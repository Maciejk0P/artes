// Inventory of a Claude Code setup: which memory files, skills, commands, agents, rule files and
// settings exist, how large they are and how they are structured. It reports sizes, headings and
// front matter. It never prints a file body and never opens anything outside the locations below.
// An @import is opened only when it is a text file inside the folder its importing file belongs
// to, and no part of its path is a link.
//
// Locations and loading rules come from the documentation; lib/facts.mjs holds each with its page.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { autoMemoryIndex, isSessionData } from './lib/automemory.mjs';
import { deliver, parseArgs, requireOption, runCli } from './lib/cli.mjs';
import { APPROX_CHARS_PER_TOKEN, FACTS, LIMITS, MCP_RULE, STACK_MARKERS } from './lib/facts.mjs';
import { parseFrontMatter } from './lib/frontmatter.mjs';
import { scriptTokens, summariseHookCommand } from './lib/hooks.mjs';
import { MEMORY_KINDS } from './lib/kinds.mjs';
import { commentMask, commentSize, fenceMask, findImports, findSections, splitLines } from './lib/markdown.mjs';
import { absolute, entryType, expandHome, isInside, isSkippedDir, join, toPosix } from './lib/paths.mjs';
import { maskDeep, maskSecrets } from './lib/secrets.mjs';
import { thirdPartyMarks } from './lib/targets.mjs';

export const ALLOWED_KINDS = [...MEMORY_KINDS, 'agents-md', 'skill', 'command', 'agent', 'rule'];

export const DEFAULT_CAPS = { maxFiles: 2000, maxDirs: 20000, maxDepth: 6 };
const MAX_READ_BYTES = 2 * LIMITS.memoryFileBytes.value;
const MAX_SKIPPED = 500;
// An import with another extension (source code, a .env, a manifest) is counted by name and
// never opened: its content is not an instruction file and may be private.
const IMPORT_EXTENSIONS = ['.md', '.mdc', '.txt'];
// In the walk of the home folder, a name such as `build` or `env` is taken for build output only
// from this depth on; nearer the top it is as likely a folder of projects.
const BUILD_OUTPUT_FROM_DEPTH = 3;
const MEMORY_NAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
// Block-level HTML comments are stripped from these before they are injected (FACTS.comments).
const COMMENTS_STRIPPED = ['memory', 'memory-local', 'memory-nested'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

// A folder is a project when it holds one of the four things Claude Code reads at its root.
export function isProject(dir) {
  return (
    entryType(join(dir, 'CLAUDE.md')) === 'file' ||
    entryType(join(dir, 'CLAUDE.local.md')) === 'file' ||
    entryType(join(dir, '.claude')) === 'dir' ||
    entryType(join(dir, '.mcp.json')) === 'file'
  );
}

// Only the position is kept from the parser's message: the message itself can quote the file.
function jsonError(error) {
  const position = /position \d+( \(line \d+ column \d+\))?/.exec(error.message);
  return position ? `parse error at ${position[0]}` : 'the parser reported no position';
}

function summariseHooks(hooks) {
  const out = [];
  if (!isObject(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
        out.push({
          event,
          matcher: typeof group.matcher === 'string' ? maskSecrets(group.matcher) : null,
          type: typeof handler?.type === 'string' ? handler.type : null,
          // Program and script only; see lib/hooks.mjs.
          command: typeof handler?.command === 'string' ? summariseHookCommand(handler.command) : null,
          scripts: typeof handler?.command === 'string' ? scriptTokens(handler.command).map(maskSecrets) : [],
        });
      }
    }
  }
  return out;
}

// 'launch' for a rule file that loads at every session start, 'on-demand' for one with a paths
// pattern. When the front matter cannot be read, a line that starts with "paths:" still counts.
function ruleLoads(text, frontMatter) {
  const { paths } = frontMatter.data;
  const scoped = frontMatter.valid
    ? (Array.isArray(paths) && paths.length > 0) || (typeof paths === 'string' && paths.trim() !== '')
    : splitLines(text)
        .slice(0, frontMatter.endLine || 50)
        .some((line) => /^paths\s*:/.test(line));
  return scoped ? 'on-demand' : 'launch';
}

export function scan(options = {}) {
  if (!options.home) throw new Error('scan needs a home folder (--home <dir>)');
  const home = absolute(options.home);
  if (entryType(home) !== 'dir') throw new Error(`Home folder does not exist: ${home}`);

  const caps = {
    maxFiles: options.maxFiles ?? DEFAULT_CAPS.maxFiles,
    maxDirs: options.maxDirs ?? DEFAULT_CAPS.maxDirs,
    maxDepth: options.maxDepth ?? DEFAULT_CAPS.maxDepth,
  };
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const files = [];
  const settings = [];
  const skipped = [];
  const projects = [];
  const linked = [];
  const nestedRepositories = [];
  const capped = { hit: false, reasons: [] };
  const seen = new Map();
  // The roots that were asked for, known before the first of them is walked.
  const named = new Set();
  let dirsVisited = 0;

  function cap(name, limit, at) {
    capped.hit = true;
    const existing = capped.reasons.find((reason) => reason.cap === name);
    if (existing) existing.count += 1;
    else capped.reasons.push({ cap: name, limit, at, count: 1 });
  }

  function skip(file, reason) {
    if (skipped.some((entry) => entry.path === file && entry.reason === reason)) return;
    if (skipped.length >= MAX_SKIPPED) cap('max-skipped', MAX_SKIPPED, file);
    else skipped.push({ path: file, reason });
  }

  // The per-project folders of the home configuration hold session transcripts. Whatever asks,
  // nothing in them is listed or opened: every file and folder access of the scan passes one of
  // the three functions that check this (listDir, addFile, addSettings).
  const offLimits = (target) => isSessionData(home, target);

  function listDir(dir) {
    if (offLimits(dir)) return [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skip(dir, 'unreadable');
      return [];
    }
    return entries
      .map((entry) => {
        const full = join(dir, entry.name);
        // A plain directory or file needs no second look; anything else is checked with lstat,
        // which tells a real link or junction apart from other reparse points.
        const type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entryType(full);
        return { name: entry.name, full, type };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  function countDir(dir) {
    if (dirsVisited >= caps.maxDirs) {
      cap('max-dirs', caps.maxDirs, dir);
      return false;
    }
    dirsVisited += 1;
    return true;
  }

  // What marks a skill as somebody else's work: a key of its front matter, a licence file or a
  // repository marker in its folder. Only the names in the folder are looked at. The marks are
  // defined once, in lib/targets.mjs, where a write into such a folder is refused.
  const thirdPartyReasons = (dir, data) => thirdPartyMarks(data, listDir(dir).map((entry) => entry.name));

  function addFile(kind, scope, project, file, extra = {}) {
    if (seen.has(file) || offLimits(file)) return null;
    const type = entryType(file);
    if (type === 'symlink') skip(file, 'symlink');
    if (type !== 'file') return null;
    if (files.length >= caps.maxFiles) {
      cap('max-files', caps.maxFiles, file);
      return null;
    }
    const bytes = statSync(file).size;
    if (bytes > MAX_READ_BYTES) {
      skip(file, 'too-large');
      return null;
    }
    const text = readFileSync(file, 'utf8');
    const lines = splitLines(text);
    const mask = fenceMask(lines);
    const isMemory = MEMORY_KINDS.includes(kind);
    const comments = isMemory ? commentMask(lines, mask) : [];
    const hasFrontMatter = !isMemory && kind !== 'agents-md';
    let frontMatter = null;
    const derived = {};
    if (hasFrontMatter) {
      const parsed = parseFrontMatter(text);
      frontMatter = { present: parsed.present, valid: parsed.valid, error: parsed.error, data: maskDeep(parsed.data) };
      if (kind === 'rule') derived.loads = ruleLoads(text, parsed);
      if (kind === 'skill') {
        // Line endings are left out of the hash: the same skill checked out twice is one text.
        derived.contentSha = createHash('sha256').update(lines.join('\n')).digest('hex');
        derived.thirdParty = thirdPartyReasons(path.dirname(file), parsed.data);
      }
    }
    if (COMMENTS_STRIPPED.includes(kind)) {
      const stripped = commentSize(text);
      derived.commentLines = stripped.lines;
      derived.commentBytes = stripped.bytes;
    }
    if (kind === 'memory' || kind === 'memory-local') derived.loads = 'launch';
    if (kind === 'memory-nested') derived.loads = FACTS.nestedMemory.loads;
    const entry = {
      kind,
      scope,
      project,
      path: file,
      lines: lines.length,
      bytes,
      // What a comment holds is stripped before the file is injected, so it costs no tokens.
      approxTokens: Math.ceil((bytes - (derived.commentBytes ?? 0)) / APPROX_CHARS_PER_TOKEN),
      // A heading inside a comment is no section of the loaded text.
      sections: findSections(lines, isMemory ? mask.map((masked, index) => masked || comments[index]) : mask),
      imports: isMemory ? findImports(lines, mask) : [],
      frontMatter,
      ...derived,
      ...extra,
    };
    files.push(entry);
    seen.set(file, entry);
    return entry;
  }

  function addSettings(kind, scope, project, file) {
    if (offLimits(file)) return;
    const type = entryType(file);
    if (type === 'symlink') skip(file, 'symlink');
    if (type !== 'file') return;
    const base = { kind, scope, project, path: file, bytes: statSync(file).size };
    let json = null;
    let error = null;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObject(json)) error = 'the top level is not a JSON object';
    } catch (cause) {
      error = jsonError(cause);
    }
    if (kind === 'mcp') {
      // Server names only. Commands, arguments and environment values stay unread.
      const servers = !error && isObject(json.mcpServers) ? Object.keys(json.mcpServers) : [];
      settings.push({ ...base, valid: !error, error, servers });
      return;
    }
    if (error) {
      settings.push({ ...base, valid: false, error, keys: [], envKeys: [], permissions: null, hookEvents: [], hooks: [], claudeMdExcludes: [] });
      return;
    }
    const permissions = isObject(json.permissions) ? json.permissions : {};
    settings.push({
      ...base,
      valid: true,
      error: null,
      keys: Object.keys(json),
      envKeys: isObject(json.env) ? Object.keys(json.env) : [],
      // A permission rule can hold a credential, and no pattern recognises every one. So no text
      // of a rule is kept: how many each list holds, and the rules that name an MCP server, whose
      // shape leaves no room for one. A check that needs a rule reads the file again (checks.mjs).
      permissions: {
        ...Object.fromEntries(FACTS.permissionRules.lists.map((list) => [list, strings(permissions[list]).length])),
        mcp: FACTS.permissionRules.lists.flatMap((list) => strings(permissions[list])).filter((rule) => MCP_RULE.test(rule)),
      },
      hookEvents: isObject(json.hooks) ? Object.keys(json.hooks) : [],
      hooks: summariseHooks(json.hooks),
      // Globs for memory files this layer switches off; see FACTS.memoryExcludes.
      claudeMdExcludes: strings(json[FACTS.memoryExcludes.setting]).map(maskSecrets),
    });
  }

  function addMarkdownTree(kind, scope, project, dir, depth = 0) {
    for (const entry of listDir(dir)) {
      if (entry.type === 'symlink') skip(entry.full, 'symlink');
      else if (entry.type === 'file' && entry.name.toLowerCase().endsWith('.md')) addFile(kind, scope, project, entry.full);
      else if (entry.type === 'dir') {
        if (depth >= caps.maxDepth) cap('max-depth', caps.maxDepth, entry.full);
        else addMarkdownTree(kind, scope, project, entry.full, depth + 1);
      }
    }
  }

  function scanClaudeDir(dir, scope, project) {
    const type = entryType(dir);
    if (type === 'symlink') skip(dir, 'symlink');
    if (type !== 'dir') return;
    addFile('memory', scope, project, join(dir, 'CLAUDE.md'));
    addSettings('settings', scope, project, join(dir, 'settings.json'));
    addSettings('settings-local', scope, project, join(dir, 'settings.local.json'));
    const dirOf = (name) => (entryType(join(dir, name)) === 'dir' ? join(dir, name) : null);
    for (const name of ['skills', 'commands', 'agents', 'rules']) {
      if (entryType(join(dir, name)) === 'symlink') skip(join(dir, name), 'symlink');
    }
    if (dirOf('skills')) {
      for (const entry of listDir(dirOf('skills'))) {
        if (entry.type === 'symlink') {
          // Not followed and not read, and still part of the setup: it is listed by its name.
          skip(entry.full, 'symlink');
          linked.push({ kind: 'skill', name: entry.name, scope, project, path: entry.full });
        } else if (entry.type === 'dir') addFile('skill', scope, project, join(entry.full, 'SKILL.md'), { name: entry.name });
      }
    }
    if (dirOf('commands')) addMarkdownTree('command', scope, project, dirOf('commands'));
    if (dirOf('agents')) {
      for (const entry of listDir(dirOf('agents'))) {
        if (entry.type === 'symlink') skip(entry.full, 'symlink');
        else if (entry.type === 'file' && entry.name.toLowerCase().endsWith('.md')) {
          addFile('agent', scope, project, entry.full);
        }
      }
    }
    if (dirOf('rules')) addMarkdownTree('rule', scope, project, dirOf('rules'));
  }

  // Memory files in subfolders load on demand; they are listed so they can be measured.
  // The walk has no depth limit of its own: only the cap on visited folders can stop it,
  // so a normal project is searched completely and a stop is always worth reporting.
  // A subfolder with its own repository marker (.git as a folder or as a file) is another
  // project: the walk names it and does not enter it.
  function addNestedMemory(root) {
    const queue = listDir(root);
    while (queue.length) {
      const entry = queue.shift();
      if (entry.type === 'symlink' && !entry.name.startsWith('.')) skip(entry.full, 'symlink');
      if (entry.type !== 'dir' || isSkippedDir(entry.name)) continue;
      if (!countDir(entry.full)) return;
      if (entryType(join(entry.full, '.git')) !== null) {
        if (!nestedRepositories.some((repository) => repository.path === entry.full)) {
          nestedRepositories.push({ path: entry.full, name: entry.name, parent: root, setup: isProject(entry.full), included: false });
        }
        continue;
      }
      // A folder that is named as a project of its own is that project, not a subfolder of this one.
      if (named.has(entry.full)) continue;
      addFile('memory-nested', 'project', root, join(entry.full, 'CLAUDE.md'));
      addFile('memory-nested', 'project', root, join(entry.full, 'CLAUDE.local.md'));
      queue.push(...listDir(entry.full));
    }
  }

  // The memory files that stand above a project and load when Claude Code is started in it:
  // those the scan lists in the folders between the project and the outermost scanned project
  // around it, outermost first. Folders above a scanned root are not looked at. This one list is
  // what says whether an AGENTS.md is read, and what the checks count as loaded there.
  function memoryAbove(root) {
    const around = projects.map((project) => project.path).filter((other) => other !== root && isInside(root, other));
    if (around.length === 0) return [];
    const top = around.sort((a, b) => a.length - b.length)[0];
    const found = [];
    for (let dir = toPosix(path.dirname(root)); isInside(dir, top); dir = toPosix(path.dirname(dir))) {
      found.unshift(...MEMORY_NAMES.map((name) => join(dir, name)).filter((file) => seen.has(file)));
      if (dir === top) break;
    }
    return found;
  }

  function scanProject(root, nestedIn = null) {
    if (projects.some((project) => project.path === root)) return;
    const markers = Object.keys(STACK_MARKERS).filter((marker) => entryType(join(root, marker)) === 'file');
    projects.push({ path: root, name: path.basename(root), markers, nestedIn, memoryAbove: [] });
    addFile('memory', 'project', root, join(root, 'CLAUDE.md'));
    scanClaudeDir(join(root, '.claude'), 'project', root);
    addFile('memory-local', 'project', root, join(root, 'CLAUDE.local.md'));
    // AGENTS.md is listed; whether it is read is said once every project is known (below).
    for (const name of FACTS.agentsMd.names) addFile('agents-md', 'project', root, join(root, name));
    addSettings('mcp', 'project', root, join(root, FACTS.mcp.projectFile));
    addNestedMemory(root);
    progress({ phase: 'project', path: root, projects: projects.length, files: files.length });
  }

  // Walks the home folder breadth first, so the projects closest to it are found before a cap.
  function discoverProjects() {
    const found = [];
    const queue = [{ dir: home, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.shift();
      if (!countDir(dir)) break;
      if (dirsVisited % 500 === 0) progress({ phase: 'discover', dirs: dirsVisited, found: found.length });
      if (dir !== home && isProject(dir)) {
        found.push(dir);
        continue;
      }
      const buildOutput = depth + 1 >= BUILD_OUTPUT_FROM_DEPTH;
      const entries = listDir(dir).filter((entry) => !isSkippedDir(entry.name, { buildOutput }));
      for (const entry of entries) if (entry.type === 'symlink') skip(entry.full, 'symlink');
      const subdirs = entries.filter((entry) => entry.type === 'dir');
      if (depth >= caps.maxDepth) {
        if (subdirs.length) cap('max-depth', caps.maxDepth, dir);
        continue;
      }
      for (const entry of subdirs) queue.push({ dir: entry.full, depth: depth + 1 });
    }
    progress({ phase: 'discover', dirs: dirsVisited, found: found.length });
    return found.sort();
  }

  function projectsUnder(folder) {
    const dir = absolute(folder);
    if (isSessionData(home, dir)) throw new Error(`${dir} holds session data and is never scanned. Name the folder of the project itself.`);
    if (entryType(dir) !== 'dir') throw new Error(`Project folder does not exist: ${dir}`);
    if (isProject(dir)) return [dir];
    const children = listDir(dir).filter((entry) => entry.type === 'dir' && !isSkippedDir(entry.name, { buildOutput: false }));
    const found = children.filter((entry) => isProject(entry.full)).map((entry) => entry.full);
    if (found.length === 0) skip(dir, 'no-project-found');
    return found;
  }

  // The first link on the way from a root down to a target, or null. lstat on the target alone
  // would miss a linked folder in the middle of the path.
  function linkOnPath(root, target) {
    let current = root;
    for (const part of toPosix(path.relative(root, target)).split('/').filter(Boolean)) {
      current = join(current, part);
      const type = entryType(current);
      if (type === 'symlink') return current;
      if (type === null) return null;
    }
    return null;
  }

  // Imports are followed breadth first so every imported file is reached at its smallest hop count.
  // A file may import from the folder it belongs to: a project file from its own project, and
  // every file from <home>/.claude. Anything else is recorded and left unread, so a memory file in
  // one repository cannot pull in a file from the home folder or from another project.
  function resolveImports() {
    const userRoot = join(home, '.claude');
    const queue = files.filter((file) => MEMORY_KINDS.includes(file.kind)).map((file) => ({ file, hop: 1 }));
    while (queue.length) {
      const { file, hop } = queue.shift();
      const roots = file.project ? [file.project, userRoot] : [userRoot];
      const resolved = [];
      for (const candidate of file.imports) {
        const expanded = expandHome(candidate.raw, home);
        const target = absolute(path.isAbsolute(expanded) ? expanded : path.join(path.dirname(file.path), expanded));
        const tooDeep = hop > LIMITS.importHops.value;
        const entry = { raw: candidate.raw, line: candidate.line, resolved: target, exists: null, outside: false, hop, tooDeep };
        const root = roots.find((allowed) => isInside(target, allowed));
        if (!root) {
          if (candidate.bare) continue;
          resolved.push({ ...entry, outside: true });
          skip(target, 'import-outside-scope');
          continue;
        }
        const link = linkOnPath(root, target);
        if (link) {
          if (!candidate.bare) resolved.push(entry);
          skip(link, 'symlink');
          continue;
        }
        const type = entryType(target);
        if (candidate.bare && type !== 'file') continue;
        if (!IMPORT_EXTENSIONS.includes(path.extname(target).toLowerCase())) {
          resolved.push({ ...entry, notText: true });
          skip(target, 'import-not-text');
          continue;
        }
        const exists = type === 'file';
        resolved.push({ ...entry, exists });
        if (!exists || tooDeep) continue;
        const known = seen.get(target);
        if (known) {
          if (known.kind === 'import' && !known.importedBy.includes(file.path)) known.importedBy.push(file.path);
          continue;
        }
        const inProject = root === file.project;
        const child = addFile('import', inProject ? 'project' : 'user', inProject ? file.project : null, target, {
          hop,
          importedBy: [file.path],
        });
        if (child) queue.push({ file: child, hop: hop + 1 });
      }
      file.imports = resolved;
    }
  }

  scanClaudeDir(join(home, '.claude'), 'user', null);
  progress({ phase: 'user', files: files.length });
  const requested = (options.projects ?? []).map((folder) => absolute(folder));
  const roots = requested.flatMap(projectsUnder);
  if (options.machine) roots.push(...discoverProjects());
  for (const root of roots) named.add(root);
  for (const root of named) scanProject(root);
  // Nested repositories are their own projects, and are read only when asked for. Scanning one
  // can find more of them, so the list is walked until it stops growing.
  for (let index = 0; index < nestedRepositories.length; index += 1) {
    const repository = nestedRepositories[index];
    if (projects.some((project) => project.path === repository.path)) repository.included = true;
    else if (options.nested && repository.setup) {
      scanProject(repository.path, repository.parent);
      repository.included = true;
    }
  }
  // AGENTS.md is read only where no memory file is beside or above it.
  for (const project of projects) {
    project.memoryAbove = memoryAbove(project.path);
    const beside = MEMORY_NAMES.some((name) => entryType(join(project.path, name)) === 'file');
    for (const file of files.filter((entry) => entry.kind === 'agents-md' && entry.project === project.path)) {
      file.loads = beside || project.memoryAbove.length > 0 ? 'never' : 'launch';
    }
  }
  resolveImports();
  progress({ phase: 'imports', files: files.length });

  return {
    scannedAt: (options.now ?? new Date()).toISOString(),
    home,
    scope: { user: true, projects: requested, machine: Boolean(options.machine), nested: Boolean(options.nested), limits: caps },
    capped,
    projects,
    nestedRepositories,
    files,
    settings,
    linked,
    // The size of each project's auto memory index, and nothing else from that folder.
    autoMemory: projects.map((project) => ({ project: project.path, ...autoMemoryIndex(home, project.path) })),
    skipped,
  };
}

runCli(import.meta.url, (argv) => {
  const args = parseArgs(argv, {
    home: 'string',
    projects: 'list',
    machine: 'boolean',
    nested: 'boolean',
    'max-files': 'number',
    'max-dirs': 'number',
    'max-depth': 'number',
    out: 'string',
  });
  const result = scan({
    home: requireOption(args, 'home'),
    projects: args.projects,
    machine: args.machine,
    nested: args.nested,
    maxFiles: args['max-files'],
    maxDirs: args['max-dirs'],
    maxDepth: args['max-depth'],
  });
  return deliver(
    result,
    args.out,
    {
      home: result.home,
      files: result.files.length,
      settings: result.settings.length,
      projects: result.projects.length,
      nestedRepositories: result.nestedRepositories.length,
      capped: result.capped.hit,
      skipped: result.skipped.length,
    },
    result.home,
  );
});
