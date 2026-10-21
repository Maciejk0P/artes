// Where the scripts may write. The wizard reads memory files from every scanned project, so the
// prompt alone must not be what keeps a write inside the Claude Code setup: the scripts check it.
//
//   apply.mjs       only memory files, skills, commands, agents, rule files, hook scripts and
//                   settings, under <home>/.claude or under a project root it is given
//   every --out     inside <home>/.claude/health-check, or a file that does not exist yet
//
// This module owns the whole answer to "what can this tool write": the kinds of file (SHAPES),
// what each write may touch (WRITES), and what marks a skill as somebody else's. The list the
// tool shows before it starts (lib/promise.mjs) is checked against these tables by a test.

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isSessionData } from './automemory.mjs';
import { parseFrontMatter } from './frontmatter.mjs';
import { entryType, healthDir, isInside, isSkippedDir, join, toPosix } from './paths.mjs';

// Every kind of file a write can touch, by its position in a Claude Code setup.
export const SHAPES = ['memory', 'rule', 'skill', 'command', 'agent', 'hook-script', 'settings'];

// What each write may touch. Lines are edited in text files only; settings are merged, never
// line-edited; a hook script can be created, never changed. There is no write that deletes a
// file and none that replaces one.
const TEXT_SHAPES = ['memory', 'rule', 'skill', 'command', 'agent'];
export const WRITES = Object.freeze({
  'remove-lines': TEXT_SHAPES,
  'replace-lines': TEXT_SHAPES,
  'append-lines': TEXT_SHAPES,
  'write-new': ['memory', 'rule', 'skill', 'command', 'hook-script'],
  'merge-settings': ['settings'],
});

// What a merge may add to a settings file: hooks (a list of entries per event) and permission
// rules (text, in one of three lists). No other key, no permission mode, no value that is not an
// entry of a list. An entry that is already there is never changed or removed.
export const SETTINGS_ADDS = Object.freeze({ hooks: null, permissions: Object.freeze(['allow', 'ask', 'deny']) });

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Throws unless the patch holds only what SETTINGS_ADDS allows.
export function assertSettingsPatch(patch) {
  const refuse = (text) => {
    throw new Error(`merge-settings only adds ${text}. Nothing was written.`);
  };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(SETTINGS_ADDS, key)) refuse(`hooks and permission rules: it will not write "${key}"`);
    if (!isPlainObject(value)) refuse(`entries to the lists under "${key}": "${key}" itself is not replaced`);
    const lists = SETTINGS_ADDS[key];
    for (const [name, entries] of Object.entries(value)) {
      if (lists && !lists.includes(name)) refuse(`permission rules (${lists.join(', ')}): it will not write "${key}.${name}"`);
      if (!Array.isArray(entries)) refuse(`entries to lists: "${key}.${name}" is not a list`);
      if (lists && entries.some((entry) => typeof entry !== 'string')) refuse(`permission rules as text: an entry of "${key}.${name}" is not text`);
      if (!lists && entries.some((entry) => !isPlainObject(entry))) refuse(`hook entries: an entry of "${key}.${name}" is not an object`);
    }
  }
}

// One file, one identity: the path as the file system spells it, whatever spelling it was given
// in (letter case on Windows and macOS, a short name, a link in a parent folder). For a file that
// does not exist yet, the real path of the nearest existing parent plus the remaining names.
export function canonical(file) {
  const target = path.resolve(file);
  const tail = [];
  let current = target;
  for (;;) {
    try {
      return toPosix(path.join(realpathSync.native(current), ...tail));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return toPosix(target);
    tail.unshift(path.basename(current));
    current = parent;
  }
}

const MARKDOWN = /\.md$/i;
const HOOK_SCRIPT = /\.(sh|bash|zsh|py|js|mjs|cjs|ps1)$/i;
const MEMORY_NAMES = ['CLAUDE.md', 'CLAUDE.local.md'];

// Windows and macOS find `claude.md` when asked for `CLAUDE.md`, so a file spelled that way on
// disk is the memory file there; elsewhere the two are different files.
const IGNORES_CASE = process.platform === 'win32' || process.platform === 'darwin';
const named = (name, ...wanted) => wanted.some((want) => (IGNORES_CASE ? name.toLowerCase() === want.toLowerCase() : name === want));

// What a path below a `.claude` folder is, by its position there; null when it is none of these.
function claudeShape(parts) {
  const name = parts[parts.length - 1];
  if (parts.length === 1) {
    if (named(name, 'CLAUDE.md')) return 'memory';
    if (named(name, 'settings.json', 'settings.local.json')) return 'settings';
    return null;
  }
  const [folder] = parts;
  if (named(folder, 'skills') && parts.length >= 3 && MARKDOWN.test(name)) return 'skill';
  if (named(folder, 'commands') && MARKDOWN.test(name)) return 'command';
  if (named(folder, 'agents') && parts.length === 2 && MARKDOWN.test(name)) return 'agent';
  if (named(folder, 'rules') && MARKDOWN.test(name)) return 'rule';
  if (named(folder, 'hooks') && parts.length === 2 && HOOK_SCRIPT.test(name)) return 'hook-script';
  return null;
}

// { target, shape, scope, root } for a path that is part of a Claude Code setup, or null.
// A file of a skill also carries `skillDir`, the folder of that skill.
export function classifyTarget(file, { home, projects = [] }) {
  const target = canonical(file);
  // The per-project folders of the home configuration hold session history and auto memory.
  // Nothing in them is part of a setup, whatever root a caller names: a folder in there that is
  // passed as a project root is still in there, and so is every file below it.
  if (isSessionData(canonical(home), target)) return null;
  // On Windows a colon after the drive letter names a stream attached to a file, not a file.
  if (process.platform === 'win32' && target.slice(2).includes(':')) return null;
  const roots = [
    ...projects.map((project) => ({ root: canonical(project), scope: 'project' })),
    { root: canonical(home), scope: 'user' },
  ];
  for (const { root, scope } of roots) {
    if (target === root || !isInside(target, root)) continue;
    const parts = toPosix(path.relative(root, target)).split('/');
    if (named(parts[0], '.claude')) {
      const shape = claudeShape(parts.slice(1));
      if (shape) return { target, shape, scope, root, ...(shape === 'skill' ? { skillDir: join(root, parts[0], parts[1], parts[2]) } : {}) };
      continue;
    }
    const folders = parts.slice(0, -1);
    if (scope === 'project' && named(parts[parts.length - 1], ...MEMORY_NAMES) && !folders.some((name) => isSkippedDir(name))) {
      return { target, shape: 'memory', scope, root };
    }
  }
  return null;
}

export function requireHome(home) {
  if (!home) throw new Error('This command needs the home folder (--home <dir>); nothing was written');
  if (entryType(path.resolve(home)) !== 'dir') throw new Error(`Home folder does not exist: ${home}; nothing was written`);
  return canonical(home);
}

// --- skills that are somebody else's work -----------------------------------------------------------

// The keys of a skill's front matter that name another author or source, at the top level or
// under `metadata`.
export const THIRD_PARTY_KEYS = ['license', 'author', 'upstream', 'source'];

// What marks a skill as somebody else's work, from the front matter of its SKILL.md and the
// names of the entries in its folder: null, or the list of reasons. The scan and the write
// boundary both ask here, so what a report marks "do not edit" is what a write refuses.
export function thirdPartyMarks(data, names) {
  const reasons = [];
  const top = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const metadata = top.metadata !== null && typeof top.metadata === 'object' && !Array.isArray(top.metadata) ? top.metadata : {};
  for (const key of THIRD_PARTY_KEYS) {
    if (key in top || key in metadata) reasons.push(`front-matter:${key}`);
  }
  if (names.some((name) => /^licen[cs]e/i.test(name))) reasons.push('license-file');
  if (names.includes('.git')) reasons.push('repository');
  return reasons.length ? reasons : null;
}

// The same question for a skill folder on disk, asked before a write: the names in the folder
// and the front matter of its SKILL.md, nothing else. A folder that is not there marks nothing.
function thirdPartySkillDir(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let data = {};
  const skill = names.find((name) => named(name, 'SKILL.md'));
  if (skill && entryType(join(dir, skill)) === 'file') {
    try {
      data = parseFrontMatter(readFileSync(join(dir, skill), 'utf8')).data;
    } catch {
      data = {};
    }
  }
  return thirdPartyMarks(data, names);
}

// The canonical path of a file apply.mjs may touch, or an error that says why not.
export function allowedTarget(file, { home, projects = [] }, shapes, action) {
  requireHome(home);
  const found = classifyTarget(file, { home, projects });
  if (!found || !shapes.includes(found.shape)) {
    throw new Error(
      `${action} refuses ${canonical(file)}: it only touches ${shapes.join(', ')} files under ${toPosix(path.join(home, '.claude'))} ` +
        'or under a project root passed with --project. Nothing was written.',
    );
  }
  return found.target;
}

// The canonical path of a file one of the writes of WRITES may change. On top of the boundary
// above, nothing is written into the folder of a third-party skill: no line is edited there
// and no file is added.
export function writableTarget(file, { home, projects = [] }, action) {
  if (!(action in WRITES)) throw new Error(`"${action}" is not a write this tool makes; the writes are: ${Object.keys(WRITES).join(', ')}`);
  const target = allowedTarget(file, { home, projects }, WRITES[action], action);
  const found = classifyTarget(target, { home, projects });
  if (found.skillDir && thirdPartySkillDir(found.skillDir)) {
    throw new Error(`${action} refuses ${target}: it belongs to a third-party skill, and this tool does not edit somebody else's skill. Nothing was written.`);
  }
  return target;
}

// A working file of the run (backup folder, draft, patch): always inside the health-check folder.
export function insideHealthDir(file, home, what) {
  const dir = canonical(healthDir(requireHome(home)));
  const target = canonical(file);
  if (!isInside(target, dir)) throw new Error(`The ${what} must be inside ${dir}, got ${target}. Nothing was written.`);
  return target;
}

// A result file (--out, the applied log): inside the health-check folder it may be replaced,
// anywhere else it may only be created.
export function allowedOutput(file, home) {
  const target = canonical(file);
  if (entryType(target) === null) return target;
  const dir = home ? canonical(healthDir(home)) : null;
  if (dir && isInside(target, dir) && entryType(target) === 'file') return target;
  throw new Error(
    `Refusing to overwrite ${target}: it already exists${dir ? ` and is outside ${dir}` : ''}. Choose a path that does not exist yet.`,
  );
}
