import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { load, materialise, runJson, runScript } from './helpers/fixtures.mjs';

const { appendLines, backupFiles, mergeSettings, record, removeLines, replaceLines, shaOf, writeNew } = await load('apply.mjs');
const { runChecks } = await load('checks.mjs');
const { scan } = await load('scan.mjs');

function setup(t) {
  const fx = materialise('main');
  t.after(() => fx.cleanup());
  const memory = `${fx.home}/.claude/CLAUDE.md`;
  const settings = `${fx.home}/.claude/settings.json`;
  const health = `${fx.home}/.claude/health-check`;
  const backup = `${health}/backup-test`;
  // Where a change may land: the home folder and the project roots the scan found.
  const where = { home: fx.home, projects: [fx.project('alpha-service'), fx.project('beta-tool')] };
  const checks = runChecks(scan({ home: fx.home, projects: [fx.projects] }));
  // A finding or a candidate of a check: both quote their lines and carry the hash of the quote.
  const finding = (check) => [...checks.findings, ...checks.candidates].find((entry) => entry.check === check);
  const read = (file) => readFileSync(file, 'utf8');
  return { fx, memory, settings, health, backup, where, checks, finding, read };
}

test('backup copies each file once, keeps the first copy and records files that do not exist yet', (t) => {
  const { fx, memory, settings, backup, where, read } = setup(t);
  const original = read(memory);
  const missing = `${fx.home}/.claude/skills/new/SKILL.md`;
  const result = backupFiles({ files: [memory, settings, missing], out: backup, ...where });
  assert.equal(result.backup, backup);
  assert.deepEqual(
    result.files.map((entry) => [entry.file, entry.existed]),
    [
      [memory, true],
      [settings, true],
      [missing, false],
    ],
  );
  const copy = path.join(backup, result.files[0].copy);
  assert.equal(read(copy), original);
  const manifest = JSON.parse(read(path.join(backup, 'manifest.json')));
  assert.equal(manifest.entries.length, 3);

  writeFileSync(memory, 'changed\n');
  backupFiles({ files: [memory], out: backup, ...where });
  assert.equal(read(copy), original, 'the copy taken before the first change must survive');
  assert.equal(JSON.parse(read(path.join(backup, 'manifest.json'))).entries.length, 3);
});

test('backup refuses to continue when a copy cannot be made', (t) => {
  const { memory, health, where } = setup(t);
  mkdirSync(health, { recursive: true });
  const blocked = `${health}/not-a-folder`;
  writeFileSync(blocked, 'a file where the backup folder should be');
  assert.throws(() => backupFiles({ files: [memory], out: blocked, ...where }), /Backup failed/);
});

test('one file addressed in two spellings has one backup, and it holds the original', (t) => {
  const { fx, memory, backup, where, read } = setup(t);
  const other = `${fx.home}/.claude/claude.md`;
  if (!existsSync(other)) {
    t.skip('this file system is case-sensitive, so the two spellings are two files');
    return;
  }
  const original = read(memory);
  const first = removeLines({ file: memory, from: 10, to: 10, expectSha: shaOf({ file: memory, from: 10, to: 10 }).sha, backup, ...where });
  const second = removeLines({ file: other, from: 12, to: 12, expectSha: shaOf({ file: other, from: 12, to: 12 }).sha, backup, ...where });
  assert.equal(first.file, memory);
  assert.equal(second.file, memory, 'both spellings name the same file');

  const manifest = JSON.parse(read(path.join(backup, 'manifest.json')));
  assert.equal(manifest.entries.length, 1);
  assert.equal(read(path.join(backup, manifest.entries[0].copy)), original, 'the backup still holds the bytes from before the first change');
  assert.ok(readdirSync(`${fx.home}/.claude`).includes('CLAUDE.md'), 'the file keeps its name on disk');
});

test('a backup copy that already exists is never overwritten', (t) => {
  const { fx, memory, backup, where, read } = setup(t);
  const taken = backupFiles({ files: [memory], out: backup, ...where });
  const copy = path.join(backup, taken.files[0].copy);
  writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({ createdAt: 'x', entries: [] }));
  writeFileSync(memory, 'changed after the copy was taken\n');
  const kept = read(copy);
  assert.throws(() => backupFiles({ files: [memory], out: backup, ...where }), /already exists.*nothing was written/i);
  assert.equal(read(copy), kept);
  assert.ok(fx.home);
});

test('remove-lines removes exactly the quoted lines after backing the file up', (t) => {
  const { memory, backup, where, finding, read } = setup(t);
  const original = read(memory);
  const procedure = finding('procedure-in-memory');
  const result = removeLines({ file: memory, from: procedure.line, to: procedure.endLine, expectSha: procedure.quoteSha, backup, ...where });
  assert.deepEqual([result.removed, result.linesBefore, result.linesAfter], [5, 238, 233]);
  const after = read(memory);
  assert.ok(!after.includes('Publish the package'));
  assert.ok(after.includes('## Release procedure\n\n\n## Project notes'), 'only the quoted lines leave');
  assert.ok(after.endsWith('\n'));
  const manifest = JSON.parse(read(path.join(backup, 'manifest.json')));
  assert.equal(read(path.join(backup, manifest.entries[0].copy)), original);
});

test('remove-lines refuses a file that changed since it was shown, and leaves it alone', (t) => {
  const { memory, backup, where, finding, read } = setup(t);
  const procedure = finding('procedure-in-memory');
  writeFileSync(memory, `A new first line.\n${read(memory)}`);
  const changed = read(memory);
  assert.throws(
    () => removeLines({ file: memory, from: procedure.line, to: procedure.endLine, expectSha: procedure.quoteSha, backup, ...where }),
    /not what was shown/,
  );
  assert.equal(read(memory), changed);
  assert.ok(!existsSync(backup), 'nothing is backed up for a change that was refused');
});

test('remove-lines refuses to work without a backup, outside the file, or when the backup fails', (t) => {
  const { memory, health, backup, where, finding, read } = setup(t);
  const original = read(memory);
  const duplicate = finding('duplicate-within');
  const args = { file: memory, from: duplicate.line, to: duplicate.endLine, expectSha: duplicate.quoteSha, ...where };
  assert.throws(() => removeLines(args), /backup/i);
  assert.throws(() => removeLines({ ...args, from: 900, to: 901, backup }), /outside the file/);
  assert.throws(() => removeLines({ ...args, from: 5, to: 4, backup }), /outside the file/);
  mkdirSync(health, { recursive: true });
  const blocked = `${health}/not-a-folder`;
  writeFileSync(blocked, 'x');
  assert.throws(() => removeLines({ ...args, backup: blocked }), /Backup failed/);
  assert.equal(read(memory), original);
});

test('a line edit leaves every other byte of the file as it was', (t) => {
  const { fx, backup, where } = setup(t);
  const bytes = (file) => readFileSync(file).toString('latin1');
  const edit = (name, content, change) => {
    const file = `${fx.home}/.claude/rules/${name}`;
    writeFileSync(file, content);
    change(file);
    return bytes(file);
  };
  const remove = (line) => (file) =>
    removeLines({ file, from: line, to: line, expectSha: shaOf({ file, from: line, to: line }).sha, backup, ...where });

  assert.equal(edit('crlf.md', 'one\r\ntwo\r\nthree\r\n', remove(2)), 'one\r\nthree\r\n');
  assert.equal(edit('mixed.md', 'a\r\nb\nc\nd', remove(2)), 'a\r\nc\nd', 'mixed endings and the missing final newline are kept');
  assert.equal(edit('last.md', 'a\nb\nc', remove(3)), 'a\nb\n');
  assert.equal(
    edit('replace.md', 'a\r\nb\nc\nd', (file) =>
      replaceLines({ file, from: 4, to: 4, expectSha: shaOf({ file, from: 4, to: 4 }).sha, content: 'x\ny\n', backup, ...where }),
    ),
    'a\r\nb\nc\nx\ny',
    'the replaced last line had no newline, so the new last line has none',
  );
  assert.equal(
    edit('middle.md', 'a\r\nb\r\nc\n', (file) =>
      replaceLines({ file, from: 2, to: 2, expectSha: shaOf({ file, from: 2, to: 2 }).sha, content: 'x\ny', backup, ...where }),
    ),
    'a\r\nx\r\ny\r\nc\n',
    'new lines take the ending of the line they replace',
  );
  assert.equal(
    edit('append.md', 'a\r\nb', (file) => appendLines({ file, expectSha: shaOf({ file }).sha, content: 'c\n', backup, ...where })),
    'a\r\nb\r\nc',
  );
  assert.equal(
    edit('append-nl.md', 'a\nb\n', (file) => appendLines({ file, expectSha: shaOf({ file }).sha, content: 'c\nd', backup, ...where })),
    'a\nb\nc\nd\n',
  );
});

test('a file that is not UTF-8 is refused instead of being rewritten with replacement characters', (t) => {
  const { fx, backup, where } = setup(t);
  const legacy = `${fx.home}/.claude/rules/legacy.md`;
  const original = Buffer.from([0x23, 0x20, 0x61, 0x0a, 0x2d, 0x20, 0xe1, 0x9e, 0x0a, 0x2d, 0x20, 0x62, 0x0a]);
  writeFileSync(legacy, original);
  assert.throws(() => shaOf({ file: legacy, from: 3, to: 3 }), /not UTF-8/);
  assert.throws(() => removeLines({ file: legacy, from: 3, to: 3, expectSha: 'x', backup, ...where }), /not UTF-8.*nothing was written/i);
  assert.throws(() => appendLines({ file: legacy, expectSha: 'x', content: 'c\n', backup, ...where }), /not UTF-8/);
  assert.ok(readFileSync(legacy).equals(original));

  const wide = `${fx.home}/.claude/rules/wide.md`;
  writeFileSync(wide, '\ufeff# a\n- b\n', 'utf16le');
  const wideBytes = readFileSync(wide);
  assert.throws(() => removeLines({ file: wide, from: 2, to: 2, expectSha: 'x', backup, ...where }), /not UTF-8/);
  assert.ok(readFileSync(wide).equals(wideBytes));
});

test('a rewritten file keeps its permission bits', (t) => {
  if (process.platform === 'win32') {
    t.skip('permission bits are not kept by this file system');
    return;
  }
  const { memory, settings, backup, where } = setup(t);
  chmodSync(memory, 0o600);
  chmodSync(settings, 0o600);
  removeLines({ file: memory, from: 10, to: 10, expectSha: shaOf({ file: memory, from: 10, to: 10 }).sha, backup, ...where });
  mergeSettings({ file: settings, patch: { permissions: { deny: ['Read(./.env)'] } }, backup, ...where });
  assert.equal(statSync(memory).mode & 0o777, 0o600);
  assert.equal(statSync(settings).mode & 0o777, 0o600);
});

test('a line edit never writes through a file or a link planted at the name of its temporary file', (t) => {
  const { fx, memory, backup, where, read } = setup(t);
  const original = read(memory);
  // Two files outside every root, each linked to from a name a temporary file could get: the
  // name with the id of this process, which can be guessed, and the name that is really used.
  // That one is random, so for this test the random part is made known.
  t.mock.method(crypto, 'randomBytes', () => Buffer.from('0a0b0c0d0e0f', 'hex'));
  const planted = [`${memory}.${process.pid}.tmp`, `${memory}.0a0b0c0d0e0f.tmp`];
  const outside = planted.map((_, index) => `${fx.root}/outside-${index}.txt`);
  try {
    outside.forEach((file, index) => {
      writeFileSync(file, 'not part of the setup\n');
      linkSync(file, planted[index]);
    });
  } catch (error) {
    t.skip(`this file system refused to create a hard link: ${error.code}`);
    return;
  }
  const { sha } = shaOf({ file: memory, from: 10, to: 10 });
  assert.throws(() => removeLines({ ...where, file: memory, from: 10, to: 10, expectSha: sha, backup }), /EEXIST/, 'the temporary file was opened where a file already was');
  for (const file of outside) assert.equal(read(file), 'not part of the setup\n', 'the edit was written through the planted link, out of the setup');
  assert.equal(read(memory), original, 'the memory file is as it was');
  for (const file of planted) assert.ok(existsSync(file), 'a file this tool did not create was removed');
  // The name is not the one that can be guessed, and two writes do not share one.
  t.mock.restoreAll();
  const names = new Set();
  t.mock.method(crypto, 'randomBytes', (size) => {
    const bytes = Buffer.alloc(size, names.size + 1);
    names.add(bytes.toString('hex'));
    return bytes;
  });
  removeLines({ ...where, file: memory, from: 10, to: 10, expectSha: sha, backup });
  replaceLines({ ...where, file: memory, from: 1, to: 1, expectSha: shaOf({ file: memory, from: 1, to: 1 }).sha, backup, content: '# Changed\n' });
  assert.equal(names.size, 2, 'every write asks for a new random name');
  assert.deepEqual(readdirSync(path.dirname(memory)).filter((name) => name.endsWith('.tmp')).sort(), planted.map((file) => path.basename(file)).sort(), 'no temporary file of this tool stays behind');
});

test('on Windows a stream attached to a file is not a file of the setup', (t) => {
  if (process.platform !== 'win32') return t.skip('a colon in a file name names a stream only on Windows');
  const { fx, backup, where, read } = setup(t);
  const command = `${fx.home}/.claude/commands/deploy.md`;
  const before = read(command);
  for (const file of [`${command}:hidden.md`, `${fx.home}/.claude/CLAUDE.md:extra`, `${fx.home}/.claude/skills/new/SKILL.md:x.md`]) {
    assert.throws(() => writeNew({ file, content: 'x\n', backup, ...where }), /refuses .*Nothing was written/s, file);
  }
  assert.equal(read(command), before);
  assert.ok(!existsSync(backup), 'nothing is recorded for a write that was refused');
});

test('replace-lines and append-lines check what the user saw before writing', (t) => {
  const { fx, memory, backup, where, finding, read } = setup(t);
  const duplicate = finding('duplicate-within');
  const replaced = replaceLines({
    file: memory,
    from: duplicate.line,
    to: duplicate.endLine,
    expectSha: duplicate.quoteSha,
    content: '- Answer in at most five lines.\n',
    backup,
    ...where,
  });
  assert.equal(replaced.linesAfter, 238);
  assert.equal(read(memory).split('\n')[9], '- Answer in at most five lines.');

  const project = `${fx.project('beta-tool')}/CLAUDE.md`;
  const whole = shaOf({ file: project }).sha;
  appendLines({ file: project, expectSha: whole, content: '- Use cargo clippy on every Rust change.\n', backup, ...where });
  assert.ok(read(project).endsWith('- Prefer integration tests over mocks.\n- Use cargo clippy on every Rust change.\n'));
  assert.throws(
    () => appendLines({ file: project, expectSha: whole, content: 'again\n', backup, ...where }),
    /not what was shown/,
    'the file changed, so the old hash is no longer accepted',
  );
});

test('write-new creates a file with its folders and refuses to overwrite', (t) => {
  const { fx, backup, where, read } = setup(t);
  const skill = `${fx.home}/.claude/skills/release/SKILL.md`;
  const content = '---\nname: release\ndescription: Cuts a release. Use when asked to release.\n---\n\n1. Tag.\n';
  const result = writeNew({ file: skill, content, backup, ...where });
  assert.equal(result.lines, 6);
  assert.equal(read(skill), content);
  const manifest = JSON.parse(read(path.join(backup, 'manifest.json')));
  assert.deepEqual(
    manifest.entries.map((entry) => [entry.file, entry.existed, entry.copy]),
    [[skill, false, null]],
  );

  assert.throws(() => writeNew({ file: skill, content: 'other', backup, ...where }), /already exists/);
  assert.equal(read(skill), content);
  assert.throws(() => writeNew({ file: `${fx.home}/.claude/CLAUDE.md`, content: 'x', backup, ...where }), /already exists/);
  assert.throws(() => writeNew({ file: `${fx.home}/.claude/rules/x.md`, content: 'x', ...where }), /backup/i);

  const script = `${fx.home}/.claude/hooks/format.sh`;
  writeNew({ file: script, content: '#!/bin/sh\nexit 0\n', backup, ...where });
  assert.ok(existsSync(script), 'a helper script for a hook is the one new file that is not Markdown');
});

test('nothing is written outside the Claude Code setup of the home folder and the given projects', (t) => {
  const { fx, memory, settings, health, backup, where, read } = setup(t);
  const alpha = fx.project('alpha-service');
  const userOnly = { home: fx.home, projects: [] };
  const refused = /refuses .*Nothing was written/s;
  const content = 'x\n';

  for (const file of [
    `${fx.root}/startup/run.cmd`,
    `${fx.home}/notes/new.md`,
    `${fx.home}/.claude/notes.md`,
    `${fx.home}/.claude/skills/x/run.sh`,
    `${fx.home}/.claude/hooks/deep/run.sh`,
    `${fx.home}/.claude/hooks/run.exe`,
    `${fx.home}/.claude/settings.json.md/../../../.bashrc`,
    `${alpha}/README.md`,
    `${alpha}/src/api/notes.md`,
    `${alpha}/node_modules/pkg/CLAUDE.md`,
  ]) {
    assert.throws(() => writeNew({ file, content, backup, ...where }), refused, file);
    assert.ok(!existsSync(file), `${file} was created`);
  }
  assert.throws(() => writeNew({ file: `${alpha}/.claude/rules/new.md`, content, backup, ...userOnly }), refused, 'a project has to be named');
  writeNew({ file: `${alpha}/.claude/rules/new.md`, content, backup, ...where });
  writeNew({ file: `${alpha}/packages/api/CLAUDE.md`, content, backup, ...where });

  const manifest = `${alpha}/package.json`;
  const manifestText = read(manifest);
  for (const file of [manifest, `${fx.home}/.claude/skills/good-skill/settings.json`, `${fx.home}/settings.json`]) {
    assert.throws(() => mergeSettings({ file, patch: { scripts: { postinstall: 'x' } }, backup, ...where }), refused, file);
  }
  assert.equal(read(manifest), manifestText);
  assert.throws(() => mergeSettings({ file: `${alpha}/.claude/settings.json`, patch: { a: 1 }, backup, ...userOnly }), refused);

  const line = (file) => ({ file, from: 1, to: 1, expectSha: shaOf({ file, from: 1, to: 1 }).sha, backup, ...where });
  const settingsText = read(settings);
  assert.throws(() => removeLines(line(settings)), refused, 'settings are merged, never line-edited');
  assert.throws(() => removeLines(line(`${fx.home}/.claude/hooks/existing-hook.sh`)), refused, 'a hook script is never edited');
  assert.throws(() => removeLines(line(`${alpha}/docs/api-notes.md`)), refused);
  assert.throws(() => removeLines({ ...line(`${alpha}/CLAUDE.md`), ...userOnly }), refused);
  assert.throws(() => appendLines({ file: manifest, expectSha: shaOf({ file: manifest }).sha, content, backup, ...where }), refused);
  assert.equal(read(settings), settingsText);

  assert.throws(() => backupFiles({ files: [manifest], out: backup, ...where }), refused);
  assert.throws(() => backupFiles({ files: [memory], out: `${fx.root}/elsewhere`, ...where }), /must be inside/);
  assert.throws(() => removeLines({ ...line(memory), backup: `${alpha}/backup` }), /must be inside/);
  assert.throws(() => removeLines({ ...line(memory), home: undefined }), /--home/);
  assert.throws(() => removeLines({ ...line(memory), home: `${fx.root}/no-such-home` }), /does not exist/);
  assert.ok(!existsSync(`${fx.root}/elsewhere`));
  assert.ok(health);
});

test('merge-settings adds to arrays, never removes and keeps keys it does not know', (t) => {
  const { fx, settings, backup, where, read } = setup(t);
  const before = JSON.parse(read(settings));
  const patch = {
    permissions: { deny: ['Bash(git push --force:*)'], allow: ['Read(./docs/**)', 'Bash(npm test)'] },
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npx prettier --write' }] }] },
  };
  const result = mergeSettings({ file: settings, patch, backup, ...where });
  const after = JSON.parse(read(settings));

  assert.deepEqual(after.permissions.deny, ['Bash(git push --force:*)']);
  assert.deepEqual(after.permissions.allow, ['Bash', 'Read(./docs/**)', 'Bash(npm test)'], 'existing entries stay, no duplicate');
  assert.equal(after.permissions.defaultMode, 'bypassPermissions');
  assert.equal(after.hooks.PostToolUse.length, 2);
  assert.deepEqual(after.hooks.PostToolUse[0], before.hooks.PostToolUse[0]);
  assert.deepEqual(after.hooks.PreToolUse, before.hooks.PreToolUse);
  assert.deepEqual(after.customUnknownKey, { keep: true });
  assert.deepEqual(after.env, before.env);
  assert.equal(after.model, 'opus');
  assert.deepEqual(Object.keys(after), Object.keys(before), 'key order is kept');
  assert.deepEqual(result.added.sort(), ['hooks.PostToolUse', 'permissions.allow', 'permissions.deny']);

  const manifest = JSON.parse(read(path.join(backup, 'manifest.json')));
  assert.deepEqual(JSON.parse(read(path.join(backup, manifest.entries[0].copy))), before);
  assert.deepEqual(readdirSync(path.dirname(settings)).filter((name) => name.includes('.tmp')), [], 'no temp file is left');

  const again = mergeSettings({ file: settings, patch, backup, ...where });
  assert.deepEqual(again.added, []);
  assert.deepEqual(JSON.parse(read(settings)), after, 'merging the same patch twice changes nothing');

  const created = `${fx.project('beta-tool')}/.claude/settings.json`;
  mergeSettings({ file: created, patch: { permissions: { deny: ['Read(./.env)'] } }, backup, ...where });
  assert.deepEqual(JSON.parse(read(created)), { permissions: { deny: ['Read(./.env)'] } });
});

test('merge-settings refuses invalid JSON and refuses to change an existing value', (t) => {
  const { fx, settings, backup, where, read } = setup(t);
  const broken = `${fx.home}/.claude/settings.local.json`;
  const brokenText = read(broken);
  assert.throws(() => mergeSettings({ file: broken, patch: { a: 1 }, backup, ...where }), /not valid JSON/);
  assert.equal(read(broken), brokenText);

  const text = read(settings);
  const refusal = /only adds/;
  assert.throws(() => mergeSettings({ file: settings, patch: { permissions: { defaultMode: 'plan' } }, backup, ...where }), refusal);
  assert.throws(() => mergeSettings({ file: settings, patch: { permissions: { allow: 'Bash' } }, backup, ...where }), refusal);
  assert.throws(() => mergeSettings({ file: settings, patch: { env: { API_TOKEN: 'other' } }, backup, ...where }), (error) => {
    assert.match(error.message, refusal);
    assert.ok(!error.message.includes('FIXTURE-SECRET-VALUE'), 'the refusal must not print the existing value');
    return true;
  });
  assert.throws(() => mergeSettings({ file: settings, patch: ['not', 'an', 'object'], backup, ...where }), /JSON object/);
  assert.throws(() => mergeSettings({ file: settings, patch: { permissions: { deny: ['Read(./.env)'] } }, ...where }), /backup/i);
  // A merge adds hooks and permission rules, and nothing else: no other key, no permission mode,
  // no directory, nothing that is not an entry of a list.
  for (const patch of [
    { newKey: { nested: true } },
    { model: 'other' },
    { env: { NEW_NAME: 'value' } },
    { permissions: { additionalDirectories: ['/elsewhere'] } },
    { permissions: { deny: [{ rule: 'Bash' }] } },
    { permissions: 'all' },
    { hooks: { PreToolUse: { matcher: 'Bash' } } },
    { hooks: [] },
  ]) {
    assert.throws(() => mergeSettings({ file: settings, patch, backup, ...where }), /merge-settings only adds/, JSON.stringify(patch));
  }
  assert.equal(read(settings), text);
  // A value that is there in another shape than a list is not replaced by a list.
  const odd = `${fx.project('beta-tool')}/.claude/settings.json`;
  const oddText = '{ "permissions": { "deny": "Bash(rm *)" }, "hooks": { "Stop": { "command": "true" } } }\n';
  mkdirSync(path.dirname(odd), { recursive: true });
  writeFileSync(odd, oddText);
  assert.throws(() => mergeSettings({ file: odd, patch: { permissions: { deny: ['Read(./.env)'] } }, backup, ...where }), /will not change the existing value at permissions\.deny/);
  assert.throws(() => mergeSettings({ file: odd, patch: { hooks: { Stop: [{ hooks: [] }] } }, backup, ...where }), /will not change the existing value at hooks\.Stop/);
  assert.equal(read(odd), oddText);
});

test('record appends what was done so the second report can tell', (t) => {
  const { fx, memory, health, backup, where, read } = setup(t);
  const applied = `${health}/run-test/applied.json`;
  const skill = `${fx.home}/.claude/skills/release/SKILL.md`;
  const first = record({
    applied,
    id: 'procedure-in-memory-0123456789',
    kind: 'make-skill',
    files: [memory, skill],
    created: [{ type: 'skill', path: skill }],
    backup,
    now: new Date('2026-01-01T12:00:00Z'),
    ...where,
  });
  assert.deepEqual(first.entry, {
    id: 'procedure-in-memory-0123456789',
    kind: 'make-skill',
    status: 'applied',
    files: [memory, skill],
    created: [{ type: 'skill', path: skill }],
    backup,
    note: null,
    at: '2026-01-01T12:00:00.000Z',
  });
  record({ applied, id: 'exception-0123456789', kind: 'review-exception', status: 'skipped', note: 'still holds', ...where });
  const entries = JSON.parse(read(applied));
  assert.equal(entries.length, 2);
  assert.deepEqual([entries[1].status, entries[1].files, entries[1].note], ['skipped', [], 'still holds']);

  // A change the person made by hand is a third thing: recorded, and neither applied nor skipped.
  const byHand = record({ applied, id: 'hook-missing-file-0123456789', kind: 'make-setting', status: 'by-hand', files: [`${fx.home}/.claude/settings.json`], backup, ...where });
  assert.deepEqual([byHand.entry.status, byHand.entry.created, byHand.count], ['by-hand', [], 3]);

  assert.throws(() => record({ applied, id: 'x', kind: 'rewrite-everything', ...where }), /Unknown kind/);
  assert.throws(() => record({ applied, id: 'x', kind: 'make-skill', status: 'maybe', ...where }), /Unknown status "maybe"; use one of: applied, by-hand, skipped/);
  assert.throws(() => record({ applied, id: 'x', kind: 'make-skill', created: [{ type: 'spaceship', path: 'x' }], ...where }), /Unknown created type/);
  writeFileSync(applied, '{ "not": "an array" }');
  assert.throws(() => record({ applied, id: 'x', kind: 'make-skill', ...where }), /JSON array/);

  const unrelated = `${fx.project('alpha-service')}/package.json`;
  const unrelatedText = read(unrelated);
  assert.throws(() => record({ applied: unrelated, id: 'x', kind: 'make-skill', ...where }), /Refusing to overwrite/);
  assert.equal(read(unrelated), unrelatedText);
  assert.throws(() => record({ applied, id: 'x', kind: 'make-skill' }), /--home/);
});

test('CLI: every subcommand prints what it did, and a refusal exits non-zero with the reason', (t) => {
  const { fx, memory, settings, health, backup, finding, read } = setup(t);
  const duplicate = finding('duplicate-within');
  const home = ['--home', fx.home];

  const hashed = runJson('apply.mjs', ['sha', '--file', memory, '--from', String(duplicate.line), '--to', String(duplicate.endLine)]);
  assert.equal(hashed.sha, duplicate.quoteSha);

  const backedUp = runJson('apply.mjs', ['backup', '--files', memory, settings, '--out', backup, ...home]);
  assert.equal(backedUp.files.length, 2);
  const defaultBackup = runJson('apply.mjs', ['backup', '--files', memory, ...home]);
  assert.match(defaultBackup.backup, /\/\.claude\/health-check\/backup-\d{8}-\d{6}$/);

  const removed = runJson('apply.mjs', [
    'remove-lines', '--file', memory, '--from', String(duplicate.line), '--to', String(duplicate.endLine),
    '--expect-sha', duplicate.quoteSha, '--backup', backup, ...home,
  ]);
  assert.equal(removed.linesAfter, 237);

  const refused = runScript('apply.mjs', [
    'remove-lines', '--file', memory, '--from', String(duplicate.line), '--to', String(duplicate.endLine),
    '--expect-sha', duplicate.quoteSha, '--backup', backup, ...home,
  ]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /not what was shown/);

  const command = `${fx.home}/.claude/skills/ship-it/SKILL.md`;
  const content = '---\nname: ship-it\ndescription: Runs the release checklist. Use when the user says "ship it".\n---\n';
  const written = runJson('apply.mjs', ['write-new', '--file', command, '--backup', backup, ...home], { input: content });
  assert.equal(written.file, command);
  assert.equal(read(command), content);
  assert.equal(runScript('apply.mjs', ['write-new', '--file', command, '--backup', backup, ...home], { input: content }).status, 1);

  const merged = runJson('apply.mjs', [
    'merge-settings', '--file', settings, '--patch', '{"permissions":{"deny":["Bash(git push --force:*)"]}}', '--backup', backup, ...home,
  ]);
  assert.deepEqual(merged.added, ['permissions.deny']);
  const badPatch = runScript('apply.mjs', ['merge-settings', '--file', settings, '--patch', '{oops', '--backup', backup, ...home]);
  assert.equal(badPatch.status, 1);
  assert.match(badPatch.stderr, /patch is not valid JSON/);

  const applied = `${health}/run-test/applied.json`;
  runJson('apply.mjs', [
    'record', '--applied', applied, '--id', duplicate.id, '--kind', 'delete-duplicate', '--files', memory, '--backup', backup, ...home,
  ]);
  runJson('apply.mjs', [
    'record', '--applied', applied, '--id', 'repeated-request-0123456789', '--kind', 'make-command',
    '--files', memory, command, '--created', `command=${command}`, '--backup', backup, ...home,
  ]);
  const entries = JSON.parse(read(applied));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[1].created, [{ type: 'command', path: command }]);

  const unknown = runScript('apply.mjs', ['delete-everything']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /backup, remove-lines/);
});

test('CLI: a write needs --home, a project file needs --project, and drafts come from the run folder', (t) => {
  const { fx, memory, health, backup, read } = setup(t);
  const alpha = fx.project('alpha-service');
  const rule = `${alpha}/.claude/rules/new.md`;
  const outside = `${fx.root}/startup/run.cmd`;

  const noHome = runScript('apply.mjs', ['write-new', '--file', `${fx.home}/.claude/rules/x.md`, '--backup', backup], { input: 'x\n' });
  assert.equal(noHome.status, 1);
  assert.match(noHome.stderr, /--home/);

  const escaped = runScript('apply.mjs', ['write-new', '--file', outside, '--backup', backup, '--home', fx.home], { input: 'x\n' });
  assert.equal(escaped.status, 1);
  assert.match(escaped.stderr, /refuses/);
  assert.ok(!existsSync(outside));

  const unnamed = runScript('apply.mjs', ['write-new', '--file', rule, '--backup', backup, '--home', fx.home], { input: 'x\n' });
  assert.equal(unnamed.status, 1);
  runJson('apply.mjs', ['write-new', '--file', rule, '--backup', backup, '--home', fx.home, '--project', alpha], { input: '# New\n' });
  assert.equal(read(rule), '# New\n');

  const stray = `${alpha}/package.json`;
  const fromOutside = runScript('apply.mjs', [
    'write-new', '--file', `${fx.home}/.claude/rules/copied.md`, '--content-file', stray, '--backup', backup, '--home', fx.home,
  ]);
  assert.equal(fromOutside.status, 1);
  assert.match(fromOutside.stderr, /must be inside/);
  assert.ok(!existsSync(`${fx.home}/.claude/rules/copied.md`));

  const patch = runScript('apply.mjs', [
    'merge-settings', '--file', `${fx.home}/.claude/settings.json`, '--patch-file', stray, '--backup', backup, '--home', fx.home,
  ]);
  assert.equal(patch.status, 1);
  assert.match(patch.stderr, /must be inside/);

  const draft = `${health}/run-test/drafts/rule.md`;
  mkdirSync(path.dirname(draft), { recursive: true });
  writeFileSync(draft, '# Drafted\n');
  runJson('apply.mjs', ['write-new', '--file', `${fx.home}/.claude/rules/drafted.md`, '--content-file', draft, '--backup', backup, '--home', fx.home]);
  assert.equal(read(`${fx.home}/.claude/rules/drafted.md`), '# Drafted\n');
  assert.ok(memory);
});
