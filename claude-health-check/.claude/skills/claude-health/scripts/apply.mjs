// The mechanical, reversible part of a confirmed change. Every subcommand that writes
//   1. accepts only a target inside the Claude Code setup of the home folder or of a project it
//      is given (lib/targets.mjs), addressed by its real path,
//   2. checks that the file still holds what the user was shown (a hash of the lines),
//   3. copies the file into the backup folder before its first change,
//   4. writes through a temporary file, leaving every byte it was not asked to change as it was,
//      and prints what it did.
// A change that cannot be checked or backed up is refused; nothing is ever written halfway.

import crypto from 'node:crypto';
import { chmodSync, constants, copyFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UsageError, parseArgs, readStdin, requireOption, runCli } from './lib/cli.mjs';
import { CREATED_TYPES, RECORD_STATES, SUGGESTION_KINDS } from './lib/kinds.mjs';
import { splitLines } from './lib/markdown.mjs';
import { entryType, healthDir, join, timestamp } from './lib/paths.mjs';
import { SHAPES, WRITES, allowedOutput, allowedTarget, assertSettingsPatch, canonical, insideHealthDir, requireHome, writableTarget } from './lib/targets.mjs';

const SUBCOMMANDS = ['backup', 'remove-lines', 'replace-lines', 'append-lines', 'write-new', 'merge-settings', 'record', 'sha'];

// What each kind of write may touch is one table, WRITES in lib/targets.mjs: every write below
// asks writableTarget(), which holds it to that table and to the skills that are the person's own.
if (!SUBCOMMANDS.filter((name) => !['backup', 'record', 'sha'].includes(name)).every((name) => name in WRITES)) {
  throw new Error('apply.mjs has a subcommand that writes and is not in the table of writes (lib/targets.mjs)');
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The temporary file takes the permission bits of the file it replaces, and never stays behind.
// It is created, never opened: its name cannot be guessed, and a file or a link that sits at that
// name all the same is not written through ("wx" fails where anything exists). A scanned
// repository can therefore not plant a link there that leads a line edit out of the setup.
function writeAtomic(file, text) {
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const mode = entryType(file) === 'file' ? statSync(file).mode & 0o777 : null;
  let created = false;
  try {
    writeFileSync(temp, text, mode === null ? { flag: 'wx' } : { mode, flag: 'wx' });
    created = true;
    if (mode !== null) chmodSync(temp, mode);
    renameSync(temp, file);
  } catch (error) {
    // Only a file this call made is removed; one that was already there is somebody else's.
    if (created) {
      try {
        unlinkSync(temp);
      } catch {
        // The rename took it, or it is gone.
      }
    }
    throw error;
  }
}

// A file is edited only when decoding and encoding it gives back the same bytes. Anything else
// (a legacy code page, UTF-16) would come back with every non-ASCII character destroyed.
function readText(file) {
  const type = entryType(file);
  if (type === 'symlink') throw new Error(`${file} is a link; this tool does not write through links`);
  if (type !== 'file') throw new Error(`${file} does not exist`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${file} is not UTF-8; this tool edits UTF-8 files only. Nothing was written.`);
  }
  return text;
}

// The lines of a text, each with the line ending it has in the file ('' for an unterminated last line).
function splitKeep(text) {
  const segments = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/y;
  while (pattern.lastIndex < text.length) {
    const match = pattern.exec(text);
    segments.push({ text: match[1], eol: match[2] });
  }
  return segments;
}

const joinKeep = (segments) => segments.map((segment) => segment.text + segment.eol).join('');

function backupDir(backup, home) {
  if (!backup) throw new Error('This change needs a backup folder (--backup <dir>); nothing was written');
  return insideHealthDir(backup, home, 'backup folder');
}

// The hash the wizard shows and later hands back: sha256 of the lines joined with "\n".
export function shaOf({ file, from, to }) {
  const target = canonical(file);
  const lines = splitLines(readText(target));
  const first = from ?? 1;
  const last = to ?? lines.length;
  if (first < 1 || last > lines.length || first > last) {
    throw new Error(`Lines ${first}-${last} are outside the file ${target} (${lines.length} lines)`);
  }
  return { file: target, from: first, to: last, lines: lines.length, sha: sha256(lines.slice(first - 1, last).join('\n')) };
}

// --- backup -----------------------------------------------------------------------------------

function backupName(file) {
  return `files/${file.replace(/^([A-Za-z]):/, '$1').replace(/^\/+/, '')}`;
}

export function backupFiles({ files, out, home, projects = [] }) {
  if (!files?.length) throw new Error('backup needs at least one file (--files)');
  const where = { home, projects };
  const dir = backupDir(out, home);
  // Anything a write could touch may be copied, a third-party skill included: a copy changes nothing.
  const targets = files.map((name) => allowedTarget(name, where, SHAPES, 'backup'));
  const manifestFile = join(dir, 'manifest.json');
  let manifest;
  try {
    mkdirSync(dir, { recursive: true });
    manifest = entryType(manifestFile) === 'file' ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { createdAt: new Date().toISOString(), entries: [] };
  } catch (error) {
    throw new Error(`Backup failed: cannot use the backup folder ${dir} (${error.code ?? error.message}); nothing was written`);
  }
  const result = [];
  for (const file of targets) {
    let entry = manifest.entries.find((item) => item.file === file);
    if (!entry) {
      const type = entryType(file);
      if (type === 'symlink' || type === 'dir' || type === 'other') {
        throw new Error(`Backup failed: ${file} is not a regular file; nothing was written`);
      }
      if (type === null) {
        entry = { file, existed: false, copy: null, sha256: null };
      } else {
        const copy = backupName(file);
        const target = join(dir, copy);
        try {
          mkdirSync(path.dirname(target), { recursive: true });
          // Exclusive: the copy taken before the first change is never replaced by a later one.
          copyFileSync(file, target, constants.COPYFILE_EXCL);
        } catch (error) {
          if (error.code === 'EEXIST') {
            throw new Error(
              `Backup failed: a backup copy already exists at ${target} that the manifest does not list for ${file}; ` +
                'use a new backup folder. Nothing was written.',
            );
          }
          throw new Error(`Backup failed: cannot copy ${file} to ${target} (${error.code ?? error.message}); nothing was written`);
        }
        const hash = sha256(readFileSync(file));
        if (sha256(readFileSync(target)) !== hash) {
          throw new Error(`Backup failed: the copy of ${file} differs from the original; nothing was written`);
        }
        entry = { file, existed: true, copy, sha256: hash };
      }
      manifest.entries.push(entry);
      writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    result.push(entry);
  }
  return { action: 'backup', backup: dir, files: result };
}

// --- line edits -------------------------------------------------------------------------------

function editLines({ action, file, from, to, expectSha, replacement, backup, home, projects = [] }) {
  const where = { home, projects };
  const target = writableTarget(file, where, action);
  if (!expectSha) throw new Error(`${action} needs the hash of the lines the user was shown (--expect-sha)`);
  const segments = splitKeep(readText(target));
  const count = segments.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > count || from > to) {
    throw new Error(`Lines ${from}-${to} are outside the file ${target} (${count} lines); nothing was written`);
  }
  const removed = segments.slice(from - 1, to);
  const found = sha256(removed.map((segment) => segment.text).join('\n'));
  if (found !== expectSha) {
    throw new Error(
      `Lines ${from}-${to} of ${target} are not what was shown (expected ${expectSha.slice(0, 12)}, found ${found.slice(0, 12)}). ` +
        'The file changed; scan again and show the user the current lines. Nothing was written.',
    );
  }
  const dir = backupDir(backup, home);
  backupFiles({ files: [target], out: dir, ...where });
  // New lines take the ending of the lines they replace; the last one keeps what the last
  // replaced line had, so a file without a final newline stays without one.
  const eol = removed[0].eol || segments[from - 2]?.eol || '\n';
  const added = replacement.map((text) => ({ text, eol }));
  if (added.length) added[added.length - 1].eol = removed[removed.length - 1].eol;
  const next = [...segments.slice(0, from - 1), ...added, ...segments.slice(to)];
  writeAtomic(target, joinKeep(next));
  return {
    action,
    file: target,
    from,
    to,
    removed: to - from + 1,
    added: replacement.length,
    linesBefore: count,
    linesAfter: next.length,
    backup: dir,
  };
}

export function removeLines(options) {
  return editLines({ ...options, action: 'remove-lines', replacement: [] });
}

export function replaceLines({ content, ...options }) {
  if (typeof content !== 'string') throw new Error('replace-lines needs the new lines on standard input');
  return editLines({ ...options, action: 'replace-lines', replacement: splitLines(content) });
}

// Appends to an existing file. The hash covers the whole file, because that is what the user saw.
export function appendLines({ file, expectSha, content, backup, home, projects = [] }) {
  const where = { home, projects };
  const target = writableTarget(file, where, 'append-lines');
  if (typeof content !== 'string' || content === '') throw new Error('append-lines needs the new lines on standard input');
  if (!expectSha) throw new Error('append-lines needs the hash of the file the user was shown (--expect-sha)');
  const text = readText(target);
  const segments = splitKeep(text);
  const found = sha256(segments.map((segment) => segment.text).join('\n'));
  if (found !== expectSha) {
    throw new Error(
      `${target} is not what was shown (expected ${expectSha.slice(0, 12)}, found ${found.slice(0, 12)}). ` +
        'The file changed; show the user the current file. Nothing was written.',
    );
  }
  const dir = backupDir(backup, home);
  backupFiles({ files: [target], out: dir, ...where });
  const last = segments[segments.length - 1];
  const eol = last?.eol || segments[segments.length - 2]?.eol || '\n';
  const added = splitLines(content);
  // An unterminated last line gets the ending it needs; the file ends as it ended before.
  const unterminated = last !== undefined && last.eol === '';
  writeAtomic(target, text + (unterminated ? eol : '') + added.join(eol) + (unterminated ? '' : eol));
  return {
    action: 'append-lines',
    file: target,
    added: added.length,
    linesBefore: segments.length,
    linesAfter: segments.length + added.length,
    backup: dir,
  };
}

export function writeNew({ file, content, backup, home, projects = [] }) {
  const where = { home, projects };
  const target = writableTarget(file, where, 'write-new');
  const dir = backupDir(backup, home);
  if (typeof content !== 'string' || content === '') throw new Error('write-new needs the file content on standard input');
  if (entryType(target) !== null) throw new Error(`${target} already exists; write-new never overwrites. Nothing was written.`);
  backupFiles({ files: [target], out: dir, ...where });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { flag: 'wx' });
  return { action: 'write-new', file: target, lines: splitLines(content).length, bytes: Buffer.byteLength(content), backup: dir };
}

// --- settings ---------------------------------------------------------------------------------

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Adds what the patch holds and the target lacks. Arrays grow, objects are merged key by key,
// and an existing value is never replaced: a patch that would change one is refused.
function mergeInto(target, patch, trail, added) {
  for (const [key, value] of Object.entries(patch)) {
    const where = [...trail, key].join('.');
    if (!(key in target)) {
      target[key] = value;
      added.push(where);
    } else if (Array.isArray(target[key]) && Array.isArray(value)) {
      const fresh = value.filter((item) => !target[key].some((existing) => sameJson(existing, item)));
      if (fresh.length) {
        target[key].push(...fresh);
        added.push(where);
      }
    } else if (isObject(target[key]) && isObject(value)) {
      mergeInto(target[key], value, [...trail, key], added);
    } else if (!sameJson(target[key], value)) {
      throw new Error(`merge-settings only adds: it will not change the existing value at ${where}. Nothing was written.`);
    }
  }
}

// The settings as they would be after a merge, without writing anything: the target is held to
// the boundary, the file must parse, and a patch that would change or remove what is there is
// refused. mergeSettings writes exactly this; a card asks here first, so that what it shows is
// what can be done.
export function previewMerge({ file, patch, home, projects = [] }) {
  const target = writableTarget(file, { home, projects }, 'merge-settings');
  if (!isObject(patch)) throw new Error('The patch must be a JSON object');
  const exists = entryType(target) !== null;
  let settings = {};
  let indent = 2;
  let eol = '\n';
  if (exists) {
    const text = readText(target);
    try {
      settings = JSON.parse(text);
    } catch {
      throw new Error(`${target} is not valid JSON; fix it by hand first. Nothing was written.`);
    }
    if (!isObject(settings)) throw new Error(`${target} does not hold a JSON object. Nothing was written.`);
    const firstIndent = /\n([ \t]+)\S/.exec(text);
    if (firstIndent) indent = firstIndent[1].includes('\t') ? '\t' : firstIndent[1].length;
    // The file is written again as a whole, so the line ending it had is the one it gets back.
    if (/\r\n/.test(text) && !/(?<!\r)\n/.test(text)) eol = '\r\n';
  }
  // Hooks and permission rules, and nothing else: the table is SETTINGS_ADDS in lib/targets.mjs.
  assertSettingsPatch(patch);
  const added = [];
  mergeInto(settings, structuredClone(patch), [], added);
  return { target, exists, settings, indent, eol, added };
}

export function mergeSettings({ file, patch, backup, home, projects = [] }) {
  const where = { home, projects };
  const { target, exists, settings, indent, eol, added } = previewMerge({ file, patch, ...where });
  const dir = backupDir(backup, home);
  if (added.length === 0) return { action: 'merge-settings', file: target, added, changed: false, backup: dir };
  backupFiles({ files: [target], out: dir, ...where });
  mkdirSync(path.dirname(target), { recursive: true });
  writeAtomic(target, `${JSON.stringify(settings, null, indent)}\n`.replace(/\n/g, eol));
  return { action: 'merge-settings', file: target, added, changed: true, created: !exists, backup: dir };
}

// --- record -----------------------------------------------------------------------------------

export function record({ applied, id, kind, status = 'applied', files = [], created = [], backup = null, note = null, now = new Date(), home }) {
  if (!applied) throw new Error('record needs the applied file (--applied)');
  if (!id) throw new Error('record needs the id of the finding (--id)');
  if (!SUGGESTION_KINDS.includes(kind)) throw new Error(`Unknown kind "${kind}"; use one of: ${SUGGESTION_KINDS.join(', ')}`);
  // by-hand: the person changed the file themselves; this tool applied nothing there.
  if (!RECORD_STATES.includes(status)) throw new Error(`Unknown status "${status}"; use one of: ${RECORD_STATES.join(', ')}`);  for (const item of created) {
    if (!CREATED_TYPES.includes(item.type)) {
      throw new Error(`Unknown created type "${item.type}"; use one of: ${CREATED_TYPES.join(', ')}`);
    }
  }
  const target = allowedOutput(applied, requireHome(home));
  let entries = [];
  if (entryType(target) !== null) {
    try {
      entries = JSON.parse(readText(target));
    } catch {
      entries = null;
    }
    if (!Array.isArray(entries)) throw new Error(`${target} does not hold a JSON array; refusing to overwrite it`);
  }
  const entry = {
    id,
    kind,
    status,
    files: files.map((file) => canonical(file)),
    created: created.map((item) => ({ type: item.type, path: canonical(item.path) })),
    backup: backup ? canonical(backup) : null,
    note,
    at: now.toISOString(),
  };
  entries.push(entry);
  mkdirSync(path.dirname(target), { recursive: true });
  writeAtomic(target, `${JSON.stringify(entries, null, 2)}\n`);
  return { action: 'record', applied: target, entry, count: entries.length };
}

// --- CLI --------------------------------------------------------------------------------------

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The ${what} is not valid JSON`);
  }
}

runCli(import.meta.url, async (argv) => {
  const args = parseArgs(argv, {
    file: 'string',
    files: 'list',
    out: 'string',
    home: 'string',
    project: 'list',
    from: 'number',
    to: 'number',
    'expect-sha': 'string',
    backup: 'string',
    patch: 'string',
    'patch-file': 'string',
    'content-file': 'string',
    applied: 'string',
    id: 'string',
    kind: 'string',
    status: 'string',
    created: 'list',
    note: 'string',
  });
  const [subcommand] = args._;
  if (subcommand === 'sha') return shaOf({ file: requireOption(args, 'file'), from: args.from, to: args.to });
  if (!SUBCOMMANDS.includes(subcommand)) throw new UsageError(`apply.mjs needs a subcommand: ${SUBCOMMANDS.join(', ')}`);

  // Every subcommand below writes, so each one is told where it may: the home folder, and the
  // roots of the projects the scan found.
  const where = { home: requireOption(args, 'home'), projects: args.project };
  // New content comes from a draft in the run folder (UTF-8, no shell quoting involved) or from
  // standard input; a draft is never read from anywhere else.
  const draft = (name) => readText(insideHealthDir(args[name], where.home, `--${name} file`));
  const content = () => (args['content-file'] ? draft('content-file') : readStdin());
  const lineArgs = () => ({
    ...where,
    file: requireOption(args, 'file'),
    from: requireOption(args, 'from'),
    to: requireOption(args, 'to'),
    expectSha: requireOption(args, 'expect-sha'),
    backup: requireOption(args, 'backup'),
  });
  switch (subcommand) {
    case 'backup':
      return backupFiles({
        ...where,
        files: requireOption(args, 'files'),
        out: args.out ?? join(healthDir(canonical(where.home)), `backup-${timestamp()}`),
      });
    case 'remove-lines':
      return removeLines(lineArgs());
    case 'replace-lines':
      return replaceLines({ ...lineArgs(), content: await content() });
    case 'append-lines':
      return appendLines({
        ...where,
        file: requireOption(args, 'file'),
        expectSha: requireOption(args, 'expect-sha'),
        backup: requireOption(args, 'backup'),
        content: await content(),
      });
    case 'write-new':
      return writeNew({ ...where, file: requireOption(args, 'file'), backup: requireOption(args, 'backup'), content: await content() });
    case 'merge-settings': {
      const file = requireOption(args, 'file');
      const backup = requireOption(args, 'backup');
      const text = args.patch ?? (args['patch-file'] ? draft('patch-file') : await readStdin());
      return mergeSettings({ ...where, file, backup, patch: parseJson(text, 'patch') });
    }
    default:
      return record({
        home: where.home,
        applied: requireOption(args, 'applied'),
        id: requireOption(args, 'id'),
        kind: requireOption(args, 'kind'),
        status: args.status,
        files: args.files,
        created: args.created.map((item) => {
          const split = item.indexOf('=');
          if (split === -1) throw new UsageError(`--created takes type=path, got "${item}"`);
          return { type: item.slice(0, split), path: item.slice(split + 1) };
        }),
        backup: args.backup ?? null,
        note: args.note ?? null,
      });
  }
});
