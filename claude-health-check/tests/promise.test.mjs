// "What it changes / what it never changes": the two lists the tool shows before anything else,
// in the launcher, in the session and in the README. They must not drift from the code, so the
// first half of this file ties every line of "changes" to the table of writes in lib/targets.mjs
// and to the kinds of change in lib/kinds.mjs, and the second half proves every line of "never"
// by trying it through the entry points.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PACKAGE_ROOT, SCRIPTS, load, materialise, runScript } from './helpers/fixtures.mjs';
import { changedFiles, listing, readJson, runLauncher } from './helpers/console.mjs';

const { CREATED_TYPES, SUGGESTION_KINDS } = await load('lib/kinds.mjs');
const { scanSetup, startRun } = await load('lib/pipeline.mjs');
const { CHANGES, NEVER, OWN_FOLDER } = await load('lib/promise.mjs');
const render = await load('lib/render.mjs');
const { LANGS, STRINGS } = await load('lib/strings.mjs');
const { SETTINGS_ADDS, SHAPES, WRITES } = await load('lib/targets.mjs');
const { PAGE, WIDTH, widthOf } = await load('lib/term.mjs');
const { STEP_OPS, STEP_WRITES, SUBCOMMANDS, parseEnvelope, ui } = await load('ui.mjs');

const read = (...parts) => readFileSync(path.join(PACKAGE_ROOT, ...parts), 'utf8');
const pairsOf = (table) => Object.entries(table).flatMap(([op, shapes]) => shapes.map((shape) => `${op} ${shape}`)).sort();
const linePairs = (lines) => [...new Set(lines.flatMap((line) => line.writes.flatMap((op) => line.shapes.map((shape) => `${op} ${shape}`))))].sort();

// What the list does not say about the code, and what it says that the code does not do.
function drift(writes, lines) {
  const [code, list] = [pairsOf(writes), linePairs(lines)];
  return { unlisted: code.filter((pair) => !list.includes(pair)), unbacked: list.filter((pair) => !code.includes(pair)) };
}

// --- the list of changes is the table of writes ---------------------------------------------------

test('every write the code can make has a line in "what it changes", and the list promises no write the code cannot make', () => {
  assert.deepEqual(drift(WRITES, CHANGES), { unlisted: [], unbacked: [] });
  assert.deepEqual([...new Set(Object.values(WRITES).flat())].sort(), [...SHAPES].sort(), 'a kind of file that nothing writes, or a write to a kind of file nobody named');
  assert.deepEqual([...new Set(CHANGES.flatMap((line) => line.shapes))].sort(), [...SHAPES].sort());

  // The check can fail: a new write target, a new operation, or a line that promises too much.
  assert.deepEqual(drift({ ...WRITES, 'write-new': [...WRITES['write-new'], 'agent'] }, CHANGES).unlisted, ['write-new agent']);
  assert.deepEqual(drift({ ...WRITES, 'delete-file': ['memory'] }, CHANGES).unlisted, ['delete-file memory']);
  assert.deepEqual(drift({ ...WRITES, 'remove-lines': [...WRITES['remove-lines'], 'settings'] }, CHANGES).unlisted, ['remove-lines settings']);
  assert.deepEqual(drift(WRITES, CHANGES.slice(1)).unlisted.length > 0, true);
  assert.deepEqual(drift(WRITES, [...CHANGES, { key: 'x', shapes: ['hook-script'], writes: ['replace-lines'], kinds: [], creates: [] }]).unbacked, ['replace-lines hook-script']);
});

test('every kind of change and everything a change can create has a line too', () => {
  const kinds = CHANGES.flatMap((line) => line.kinds);
  assert.deepEqual([...new Set(kinds)].sort(), [...SUGGESTION_KINDS].sort(), 'a kind of change without a line in the list, or a line for a kind that does not exist');
  const creates = CHANGES.flatMap((line) => line.creates);
  assert.deepEqual([...new Set(creates)].sort(), [...CREATED_TYPES].sort(), 'something a change can create has no line in the list');
  // A line that names no write and no kind would be a sentence without code behind it.
  for (const line of CHANGES) assert.ok(line.shapes.length && line.writes.length && line.kinds.length, `the line "${line.key}" stands for nothing`);
  // "A hook or a permission rule is added": what a merge may add to a settings file is those two, by the table.
  assert.deepEqual(CHANGES.find((line) => line.key === 'settings').adds, Object.keys(SETTINGS_ADDS));
  assert.deepEqual(SETTINGS_ADDS, { hooks: null, permissions: ['allow', 'ask', 'deny'] });
});

test('the table of writes is the one the code that writes uses: apply.mjs and ui.mjs hold no list of their own', () => {
  const apply = readFileSync(path.join(SCRIPTS, 'apply.mjs'), 'utf8');
  const wizard = readFileSync(path.join(SCRIPTS, 'ui.mjs'), 'utf8');
  for (const [name, source] of [['apply.mjs', apply], ['ui.mjs', wizard]]) {
    assert.match(source, /import \{[^}]*\bWRITES\b[^}]*\} from '\.\/lib\/targets\.mjs'/, `${name} does not take the writes from lib/targets.mjs`);
    assert.ok(!/\[\s*'memory',\s*'skill'/.test(source), `${name} lists kinds of file itself`);
    assert.ok(!/_SHAPES\s*=\s*\[/.test(source), `${name} lists kinds of file itself`);
  }
  // Every subcommand of apply.mjs that changes the setup is an entry of the table, and the other way round.
  const subcommands = /const SUBCOMMANDS = \[([^\]]+)\]/.exec(apply)[1].split(',').map((name) => name.trim().replace(/'/g, ''));
  assert.deepEqual(subcommands.filter((name) => !['backup', 'record', 'sha'].includes(name)).sort(), Object.keys(WRITES).sort());
  // Every step a draft may hold maps to one write of the table; "by-hand" writes nothing.
  assert.deepEqual([...Object.keys(STEP_WRITES), 'by-hand'].sort(), [...STEP_OPS].sort());
  assert.ok(Object.values(STEP_WRITES).every((op) => op in WRITES));
  assert.deepEqual([...new Set(Object.values(STEP_WRITES))].sort(), Object.keys(WRITES).sort());
});

test('each line has its sentence in both languages, and no sentence is left without a line', () => {
  const wanted = [
    'ui.promise.changes.title', 'ui.promise.changes.sub', 'ui.promise.never.title', 'ui.promise.enter',
    ...CHANGES.map((line) => `ui.promise.changes.${line.key}`),
    'ui.promise.changes.folder',
    ...NEVER.map((key) => `ui.promise.never.${key}`),
  ];
  for (const lang of LANGS) {
    const have = Object.keys(STRINGS[lang]).filter((key) => key.startsWith('ui.promise.'));
    assert.deepEqual(have.sort(), [...wanted].sort(), lang);
  }
  assert.equal(OWN_FOLDER, 'health-check');
  assert.deepEqual(NEVER, ['outside', 'unconfirmed', 'existing', 'overwrite', 'third-party', 'mcp', 'sessions', 'git']);
  assert.deepEqual(CHANGES.map((line) => line.key), ['memory', 'own', 'new', 'settings']);
});

// --- the screen -----------------------------------------------------------------------------------

test('the screen: two short lists, one page, in both languages and both skins', () => {
  for (const lang of LANGS) {
    for (const unicode of [true, false]) {
      const o = { lang, colour: false, unicode };
      const lines = render.promise(o);
      assert.ok(lines.length <= PAGE, `${lang}: ${lines.length} lines`);
      for (const line of lines) {
        assert.ok(widthOf(line) <= WIDTH, `${lang}: ${widthOf(line)} wide: ${line}`);
        assert.ok(!/\s$/.test(line) && !line.includes('\u001b'), `${lang}: ${JSON.stringify(line)}`);
        if (!unicode) assert.ok(!/[^\x00-\x7f -ſ]/.test(line), `${lang}: a glyph outside ASCII: ${line}`);
      }
    }
  }
  const lines = render.promise({ lang: 'en', colour: false, unicode: true });
  assert.deepEqual(lines, [
    '  WHAT IT CHANGES       only after your yes to that one change, backup first',
    '  · your memory files (CLAUDE.md, CLAUDE.local.md, rule files; user and',
    '    project): the exact lines shown on the card are removed, shortened or',
    '    moved',
    '  · your own skills, commands and agents: front matter fixed, or the file',
    '    shortened',
    '  · new files: a skill, a command, a rule file, a hook script, or a',
    '    CLAUDE.md where there is none',
    '  · settings: a hook or a permission rule is added, nothing is removed',
    '  · without asking: only its own folder, ~/.claude/health-check/ (run data,',
    '    backups, the two reports)',
    '',
    '  WHAT IT NEVER CHANGES',
    '  · source code, or anything outside your Claude Code setup',
    '  · anything you did not confirm: there is no "apply all"',
    '  · settings entries and hooks that are already there',
    '  · a file as a whole: none is deleted, none is overwritten',
    '  · third-party skills',
    '  · the MCP configuration files',
    '  · session history and auto memory',
    '  · git: it does not stage, commit or upload',
  ]);
  // One bullet per line of the two lists, in their order: nothing is said that has no line behind it.
  const bullets = lines.filter((line) => line.startsWith('  · ')).length;
  assert.equal(bullets, CHANGES.length + 1 + NEVER.length);
  const sk = render.promise({ lang: 'sk', colour: false, unicode: true });
  assert.equal(sk.filter((line) => line.startsWith('  · ')).length, bullets);
  assert.match(sk[0], /^ {2}ČO MENÍ\s+/);
  assert.ok(sk.some((line) => /^ {2}ČO NIKDY NEMENÍ$/.test(line)));
});

test('the README shows the same two lists, word for word', () => {
  const readme = read('README.md');
  const shown = /\n### What it changes, and what it never changes\n[\s\S]*?```\n([\s\S]*?)\n```/.exec(readme);
  assert.ok(shown, 'the README has no section with the two lists');
  assert.deepEqual(shown[1].split('\n'), render.promise({ lang: 'en', colour: false, unicode: true }));
  // It stands in the short part, before the launch lines: a person reads it before running anything.
  assert.ok(readme.indexOf('### What it changes, and what it never changes') < readme.indexOf('\n## Run it\n'));
});

// --- every "never" is tried ------------------------------------------------------------------------

function fixture(t, name = 'main') {
  const fx = materialise(name);
  t.after(() => fx.cleanup());
  return fx;
}

async function call(fx, args) {
  const result = await ui([...args, '--json', '--home', fx.home], { cwd: PACKAGE_ROOT, env: {} });
  return { ...result, ...(result.code === 0 ? parseEnvelope(result.out) : {}) };
}
async function ok(fx, args) {
  const result = await call(fx, args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}`);
  return result;
}

// A run in which the wizard is about to draft its first change: whatever it puts into that draft
// is what `card` is asked to show.
async function drafting(t, name = 'main') {
  const fx = fixture(t, name);
  const { scan, scanMs } = scanSetup({ home: fx.home, scope: { projects: [fx.projects], machine: false, nested: false } });
  const run = startRun({ home: fx.home, scan, scanMs, lang: 'en', startedBy: 'launcher' });
  const resumed = await ok(fx, ['resume', run.stamp]);
  writeFileSync(resumed.files.judgement, JSON.stringify(readJson(resumed.files.reading).candidates.map((candidate) => ({ candidate: candidate.id, dismissed: true, reason: 'not what it looked like' }))));
  await ok(fx, ['judged', '--run', run.stamp]);
  const first = await ok(fx, ['card', '--run', run.stamp, '--walk', 'all']);
  const at = first.card ?? first.need;
  const draft = (steps) => {
    mkdirSync(resumed.files.drafts, { recursive: true });
    writeFileSync(path.join(resumed.files.drafts, `${at.id}.json`), JSON.stringify({ steps }));
  };
  // The card of a draft with these steps is refused, for the reason given.
  const refused = async (steps, pattern) => {
    draft(steps);
    const result = await call(fx, ['card', '--run', run.stamp]);
    assert.equal(result.code, 1, `a card was shown for ${JSON.stringify(steps)}`);
    assert.match(result.err, pattern, JSON.stringify(steps));
  };
  // The draft is taken away again: the walk goes on as if the wizard had written none.
  const clear = () => rmSync(path.join(resumed.files.drafts, `${at.id}.json`), { force: true });
  return { fx, run, stamp: run.stamp, files: resumed.files, at, draft, refused, clear, backup: `${fx.home}/.claude/health-check/backup-${run.stamp}` };
}

// The script that writes, as a program: every write it has (but those in `except`), pointed at one file.
function everyWrite(fx, file, { projects = [], backup, except = [] }) {
  const where = ['--home', fx.home, ...projects.flatMap((project) => ['--project', project]), '--backup', backup];
  const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const writes = [
    ['write-new', '--file', file, ...where],
    ['remove-lines', '--file', file, '--from', '1', '--to', '1', '--expect-sha', sha, ...where],
    ['replace-lines', '--file', file, '--from', '1', '--to', '1', '--expect-sha', sha, ...where],
    ['append-lines', '--file', file, '--expect-sha', sha, ...where],
    ['merge-settings', '--file', file, '--patch', '{"added":true}', ...where],
  ];
  assert.deepEqual(writes.map((args) => args[0]).sort(), Object.keys(WRITES).sort(), 'a write of the table is not tried');
  return writes.filter((args) => !except.includes(args[0])).map((args) => ({ op: args[0], ...runScript('apply.mjs', args, { input: 'x\n' }) }));
}

// The same writes as steps of a draft.
const everyStep = (file, except = []) =>
  [
    { op: 'write-new', file, content: 'x\n' },
    { op: 'remove', file, from: 1, to: 1 },
    { op: 'replace', file, from: 1, to: 1, content: 'x' },
    { op: 'append', file, content: 'x\n' },
    { op: 'merge-settings', file, patch: { added: true } },
  ].filter((step) => !except.includes(step.op));

// Whatever is tried on these files, through the script that writes and through a draft, nothing is written.
async function untouchable(state, files, { projects, pattern }) {
  const { fx } = state;
  const before = listing(fx.root);
  for (const file of files) {
    for (const result of everyWrite(fx, file, { projects, backup: state.backup })) {
      assert.equal(result.status, 1, `apply.mjs ${result.op} wrote to ${file}`);
      assert.match(result.stderr, pattern, `${result.op} ${file}`);
    }
    for (const step of everyStep(file)) await state.refused([step], /The draft is refused/);
  }
  const changed = changedFiles(before, listing(fx.root)).filter((file) => !file.includes('/drafts/') && !file.endsWith('/state.json'));
  assert.deepEqual(changed, [], 'something was written');
}

const PROOFS = {
  // Source code, or anything outside the Claude Code setup.
  async outside(t) {
    const state = await drafting(t);
    const { fx } = state;
    const alpha = fx.project('alpha-service');
    mkdirSync(`${fx.root}/elsewhere`, { recursive: true });
    writeFileSync(`${fx.root}/elsewhere/CLAUDE.md`, '# Not a project of this run\n');
    await untouchable(
      state,
      [`${alpha}/src/api/handler.ts`, `${alpha}/package.json`, `${alpha}/docs/api-notes.md`, `${fx.home}/notes/private.txt`, `${fx.home}/.claude/shared/reference.md`, `${fx.root}/elsewhere/CLAUDE.md`, `${fx.root}/elsewhere/.claude/skills/new/SKILL.md`],
      { projects: [alpha], pattern: /it only touches .* files under|Nothing was written/ },
    );
    // A project counts only when it is named: the memory file of another project is outside as well.
    for (const result of everyWrite(fx, `${fx.project('beta-tool')}/CLAUDE.md`, { projects: [alpha], backup: state.backup })) assert.equal(result.status, 1, result.op);
    // The launcher writes its run folder and report 1, and nothing else.
    const before = listing(fx.root);
    const run = runLauncher(['check', '--lang', 'en', '--projects', fx.projects, '--plain'], { home: fx.home });
    assert.equal(run.status, 0, run.stderr);
    const written = changedFiles(before, listing(fx.root));
    assert.ok(written.length === 4 && written.every((file) => file.startsWith(`home/.claude/${OWN_FOLDER}/`)), written.join(', '));
  },

  // Anything the person did not confirm: there is no "apply all".
  async unconfirmed(t) {
    const state = await drafting(t);
    const { fx, stamp } = state;
    // Only one subcommand changes the setup, and it takes the number of the card on screen.
    const source = readFileSync(path.join(SCRIPTS, 'ui.mjs'), 'utf8');
    const applyBody = source.slice(source.indexOf('\nfunction apply(args, io) {'), source.indexOf('\n// An answer that applies nothing'));
    for (const write of ['writeNew(', 'appendLines(', 'mergeSettings(', 'removeLines(', 'replaceLines(']) {
      assert.equal(source.split(write).length - 1, applyBody.split(write).length - 1, `${write} is called outside the one function that carries out a confirmed card`);
      assert.ok(applyBody.includes(write));
    }
    assert.ok(!SUBCOMMANDS.some((name) => /all|batch|every/.test(name)), SUBCOMMANDS.join(', '));

    const before = listing(fx.root);
    const setup = () => changedFiles(before, listing(fx.root)).filter((file) => !file.startsWith(`home/.claude/${OWN_FOLDER}/`));
    // A change that waits for its draft has no card, so there is nothing to say yes to.
    const early = await call(fx, ['apply', '--run', stamp, '--card', '1', '--answer', 'apply']);
    assert.equal(early.code, 1);
    assert.match(early.err, /Card 1 has not been shown yet/);
    // Skipped to the first card that needs no draft: one change, with one number.
    let current = await ok(fx, ['decide', '--run', stamp, '--card', '1', '--answer', 'skip']);
    for (let guard = 0; guard < 40 && !current.card; guard += 1) current = await ok(fx, ['decide', '--run', stamp, '--card', String(current.need.n), '--answer', 'skip']);
    const n = current.card.n;
    for (const [args, pattern] of [
      [['apply', '--run', stamp, '--answer', 'apply'], /is not the card on screen/],
      [['apply', '--run', stamp, '--card', String(n + 1), '--answer', 'apply'], /is not the card on screen/],
      [['apply', '--run', stamp, '--card', String(n), '--answer', 'all'], /is not an answer this card has/],
      [['apply', '--run', stamp, '--card', String(n), '--answer', 'apply-all'], /is not an answer this card has/],
      [['decide', '--run', stamp, '--card', String(n), '--answer', 'apply'], /is not a decision/],
    ]) {
      const result = await call(fx, args);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.err, pattern, args.join(' '));
    }
    assert.deepEqual(setup(), [], 'a refused answer changed the setup');
    // One yes, one change: the answer does not reach the card after it.
    const applied = await ok(fx, ['apply', '--run', stamp, '--card', String(n), '--answer', 'apply']);
    const afterOne = setup();
    assert.ok(afterOne.length >= 1 && afterOne.length <= 2, afterOne.join(', '));
    const twice = await call(fx, ['apply', '--run', stamp, '--card', String(n), '--answer', 'apply']);
    assert.equal(twice.code, 1);
    assert.deepEqual(setup(), afterOne);
    // "Skip the rest of this file" and "skip all of this kind" skip; they never apply.
    const at = (applied.card ?? applied.need).n;
    await ok(fx, ['decide', '--run', stamp, '--card', String(at), '--answer', 'skip-file']);
    assert.deepEqual(setup(), afterOne, 'skipping changed a file');
    const record = readJson(path.join(state.files.run, 'applied.json'));
    assert.equal(record.filter((entry) => entry.status === 'applied').length, 1);
  },

  // Settings entries and hooks that are already there.
  async existing(t) {
    const state = await drafting(t);
    const { fx, backup } = state;
    const settings = `${fx.home}/.claude/settings.json`;
    const hook = `${fx.home}/.claude/hooks/existing-hook.sh`;
    const where = ['--home', fx.home, '--backup', backup];
    const original = readFileSync(settings, 'utf8');
    const was = readJson(settings);
    // A patch that would change a value, or replace a list by something else, is refused; so is a line edit.
    // And what is added is a hook or a permission rule, as the list says: no other key, no mode.
    const patches = [
      { permissions: { defaultMode: 'plan' } }, { permissions: { allow: 'none' } }, { hooks: 'off' }, { customUnknownKey: { keep: false } },
      { model: 'other' }, { env: { NEW_NAME: 'value' } }, { permissions: { additionalDirectories: ['/elsewhere'] } }, { somethingNew: true },
    ];
    for (const patch of patches) {
      const result = runScript('apply.mjs', ['merge-settings', '--file', settings, '--patch', JSON.stringify(patch), ...where]);
      assert.equal(result.status, 1, JSON.stringify(patch));
      assert.match(result.stderr, /merge-settings only adds/);
      await state.refused([{ op: 'merge-settings', file: settings, patch }], /The draft is refused: merge-settings only adds/);
    }
    // An entry that is there in another shape than a list is not replaced by a list either.
    const beta = fx.project('beta-tool');
    const odd = `${beta}/.claude/settings.json`;
    const oddText = '{\n  "permissions": { "deny": "Bash(rm *)" },\n  "hooks": { "Stop": { "command": "true" } }\n}\n';
    mkdirSync(path.dirname(odd), { recursive: true });
    writeFileSync(odd, oddText);
    for (const patch of [{ permissions: { deny: ['Read(./.env)'] } }, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }]) {
      const result = runScript('apply.mjs', ['merge-settings', '--file', odd, '--patch', JSON.stringify(patch), '--home', fx.home, '--project', beta, '--backup', backup]);
      assert.equal(result.status, 1, JSON.stringify(patch));
      assert.match(result.stderr, /merge-settings only adds: it will not change the existing value at (permissions\.deny|hooks\.Stop)/);
      await state.refused([{ op: 'merge-settings', file: odd, patch }], /The draft is refused: merge-settings only adds: it will not change the existing value/);
    }
    assert.equal(readFileSync(odd, 'utf8'), oddText);
    for (const step of everyStep(settings, ['merge-settings'])) await state.refused([step], /The draft is refused/);
    for (const result of everyWrite(fx, settings, { backup, except: ['merge-settings'] })) assert.equal(result.status, 1, result.op);
    assert.equal(readFileSync(settings, 'utf8'), original);
    // A merge that adds leaves every entry that was there, in its place.
    const added = runScript('apply.mjs', ['merge-settings', '--file', settings, '--patch', JSON.stringify({ permissions: { deny: ['Bash(rm -rf *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }), ...where]);
    assert.equal(added.status, 0, added.stderr);
    const now = readJson(settings);
    const contains = (whole, part, trail = '') => {
      if (Array.isArray(part)) for (const item of part) assert.ok(whole.some((other) => JSON.stringify(other) === JSON.stringify(item)), `${trail} lost ${JSON.stringify(item)}`);
      else if (part !== null && typeof part === 'object') for (const [key, value] of Object.entries(part)) contains(whole[key], value, `${trail}.${key}`);
      else assert.deepEqual(whole, part, `${trail} changed`);
    };
    contains(now, was);
    assert.ok(now.permissions.deny.includes('Bash(rm -rf *)'));
    // A hook script that exists is never written to: not replaced, not edited, not appended to.
    const script = readFileSync(hook, 'utf8');
    for (const result of everyWrite(fx, hook, { backup })) assert.equal(result.status, 1, result.op);
    for (const step of everyStep(hook)) await state.refused([step], /The draft is refused/);
    assert.equal(readFileSync(hook, 'utf8'), script);
  },

  // A file as a whole: none is deleted, none is overwritten.
  async overwrite(t) {
    const state = await drafting(t);
    const { fx, backup } = state;
    const alpha = fx.project('alpha-service');
    const present = [`${fx.home}/.claude/CLAUDE.md`, `${fx.home}/.claude/skills/good-skill/SKILL.md`, `${fx.home}/.claude/commands/deploy.md`, `${fx.home}/.claude/rules/style.md`, `${fx.home}/.claude/hooks/existing-hook.sh`, `${alpha}/CLAUDE.md`];
    const before = listing(fx.root);
    for (const file of present) {
      const result = runScript('apply.mjs', ['write-new', '--file', file, '--home', fx.home, '--project', alpha, '--backup', backup], { input: 'replaced\n' });
      assert.equal(result.status, 1, file);
      assert.match(result.stderr, /already exists; write-new never overwrites|it only touches/);
      await state.refused([{ op: 'write-new', file, content: 'replaced\n' }], /already exists|The draft is refused/);
    }
    // There is no step and no subcommand that deletes.
    for (const op of ['delete', 'remove-file', 'unlink', 'overwrite', 'write']) {
      await state.refused([{ op, file: present[0] }], /unknown step/);
      const result = runScript('apply.mjs', [op, '--file', present[0], '--home', fx.home, '--backup', backup]);
      assert.equal(result.status, 1, op);
      assert.match(result.stderr, /needs a subcommand/);
    }
    assert.deepEqual(changedFiles(before, listing(fx.root)).filter((file) => !file.includes('/drafts/') && !file.endsWith('/state.json')), []);
    // In the code that ships, one call removes a file: the temporary file of a write that failed.
    const removals = [];
    const walk = (dir) => {
      for (const [name, text] of Object.entries(sourcesIn(dir))) {
        for (const match of text.matchAll(/\b(unlinkSync|rmSync|rmdirSync|unlink|rm|rmdir)\(([^)]*)\)/g)) removals.push(`${name}: ${match[0]}`);
      }
    };
    walk(SCRIPTS);
    walk(path.join(PACKAGE_ROOT, 'bin'));
    assert.deepEqual(removals, ['apply.mjs: unlinkSync(temp)']);
    // A result file replaces nothing outside the tool's own folder.
    const precious = `${fx.root}/precious.json`;
    writeFileSync(precious, '{"keep":true}\n');
    const out = runScript('scan.mjs', ['--home', fx.home, '--out', precious]);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /Refusing to overwrite/);
    // The launcher once wrote one line for its script into a file the environment named. It
    // writes no such line any more: a file named that way stays as it is.
    const run = runLauncher(['check', '--lang', 'en', '--user-only'], { home: fx.home, env: { CLAUDE_HEALTH_NEXT: precious, CLAUDE_HEALTH_TTY: '1' } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(precious, 'utf8'), '{"keep":true}\n');
    assert.match(run.stdout, /How to continue/);
    // A whole walk in which everything is skipped, and its closing report: every file that was there is still there.
    state.clear();
    let current = await ok(fx, ['card', '--run', state.stamp]);
    for (let guard = 0; guard < 60 && (current.card || current.need); guard += 1) current = await ok(fx, ['decide', '--run', state.stamp, '--card', String((current.card ?? current.need).n), '--answer', 'skip']);
    await ok(fx, ['finish', '--run', state.stamp]);
    const after = listing(fx.root);
    assert.deepEqual([...before.keys()].filter((file) => !after.has(file)), [], 'a file is gone');
  },

  // Third-party skills.
  async 'third-party'(t) {
    const state = await drafting(t, 'field');
    const { fx } = state;
    const vendor = `${fx.home}/.claude/skills/vendor-skill`;
    const authored = `${fx.home}/.claude/skills/authored-skill`;
    const before = listing(fx.root);
    for (const file of [`${vendor}/SKILL.md`, `${authored}/SKILL.md`]) {
      for (const result of everyWrite(fx, file, { backup: state.backup, except: ['merge-settings'] })) {
        assert.equal(result.status, 1, `apply.mjs ${result.op} edited ${file}`);
        assert.match(result.stderr, /it belongs to a third-party skill, and this tool does not edit somebody else's skill\. Nothing was written\./, result.op);
      }
      for (const step of everyStep(file, ['merge-settings', 'write-new'])) {
        await state.refused([step], /The draft is refused: ~\/\.claude\/skills\/(vendor|authored)-skill\/SKILL\.md belongs to a third-party skill; this tool does not edit it/);
      }
    }
    // No file is added to such a folder either.
    const extra = `${vendor}/notes.md`;
    const added = runScript('apply.mjs', ['write-new', '--file', extra, '--home', fx.home, '--backup', state.backup], { input: 'x\n' });
    assert.equal(added.status, 1);
    assert.match(added.stderr, /it belongs to a third-party skill/);
    await state.refused([{ op: 'write-new', file: extra, content: 'x\n' }], /belongs to a third-party skill/);
    assert.ok(!existsSync(extra));
    assert.deepEqual(changedFiles(before, listing(fx.root)).filter((file) => !file.includes('/drafts/') && !file.endsWith('/state.json')), []);
    // A skill of the person's own, next to them, can be edited: the refusal is about whose skill it is.
    const own = `${fx.home}/.claude/skills/own-skill/SKILL.md`;
    state.draft([{ op: 'append', file: own, content: '\nA line of my own.\n' }]);
    const shown = await call(fx, ['card', '--run', state.stamp]);
    assert.equal(shown.code, 0, shown.err);
  },

  // The MCP configuration files.
  async mcp(t) {
    const state = await drafting(t);
    const { fx } = state;
    const alpha = fx.project('alpha-service');
    writeFileSync(`${fx.home}/.claude.json`, '{"mcpServers":{}}\n');
    writeFileSync(`${fx.home}/.claude/.mcp.json`, '{"mcpServers":{}}\n');
    await untouchable(state, [`${alpha}/.mcp.json`, `${fx.home}/.claude.json`, `${fx.home}/.claude/.mcp.json`, `${alpha}/.claude/.mcp.json`], { projects: [alpha], pattern: /it only touches .* files under/ });
  },

  // Session history and auto memory.
  async sessions(t) {
    const state = await drafting(t);
    const { fx } = state;
    const store = `${fx.home}/.claude/projects/-work-alpha-service`;
    mkdirSync(`${store}/memory`, { recursive: true });
    writeFileSync(`${store}/memory/MEMORY.md`, '# Auto memory\n');
    writeFileSync(`${store}/0f1e2d3c.jsonl`, '{"type":"user"}\n');
    writeFileSync(`${fx.home}/.claude/history.jsonl`, '{}\n');
    await untouchable(state, [`${store}/memory/MEMORY.md`, `${store}/memory/notes.md`, `${store}/0f1e2d3c.jsonl`, `${fx.home}/.claude/history.jsonl`, `${store}/CLAUDE.md`], { projects: [fx.project('alpha-service')], pattern: /it only touches .* files under/ });
    // The same when such a folder is itself passed as a project root: it is still session data,
    // and so is everything below it. Each write is tried with what would make it valid in a project.
    const stray = `${store}/notes/CLAUDE.md`;
    mkdirSync(path.dirname(stray), { recursive: true });
    writeFileSync(stray, '# stray\n- line one\n');
    const shaOf = (file) => JSON.parse(runScript('apply.mjs', ['sha', '--file', file]).stdout).sha;
    const asProject = (root, args) => runScript('apply.mjs', [...args, '--home', fx.home, '--project', root, '--backup', state.backup], { input: '- added\n' });
    const before = listing(fx.root);
    for (const [what, result] of [
      ['a line added to a memory file there', asProject(`${store}/notes`, ['append-lines', '--file', stray, '--expect-sha', shaOf(stray)])],
      ['a line removed from a memory file there', asProject(`${store}/notes`, ['remove-lines', '--file', stray, '--from', '2', '--to', '2', '--expect-sha', JSON.parse(runScript('apply.mjs', ['sha', '--file', stray, '--from', '2', '--to', '2']).stdout).sha])],
      ['a new memory file next to the auto memory index', asProject(`${store}/memory`, ['write-new', '--file', `${store}/memory/CLAUDE.md`])],
      ['the auto memory index itself', asProject(`${store}/memory`, ['append-lines', '--file', `${store}/memory/MEMORY.md`, '--expect-sha', shaOf(`${store}/memory/MEMORY.md`)])],
      ['a new skill below such a folder', asProject(store, ['write-new', '--file', `${store}/.claude/skills/x/SKILL.md`])],
      ['a settings file below such a folder', asProject(store, ['merge-settings', '--file', `${store}/.claude/settings.json`, '--patch', '{"permissions":{"deny":["Read(./.env)"]}}'])],
      ['the folder of all of them as the root', asProject(`${fx.home}/.claude/projects`, ['write-new', '--file', `${fx.home}/.claude/projects/CLAUDE.md`])],
    ]) {
      assert.equal(result.status, 1, `${what} was accepted: ${result.stdout}`);
      assert.match(result.stderr, /it only touches .* files under/, what);
    }
    assert.deepEqual(changedFiles(before, listing(fx.root)), [], 'something was written below the per-project folders');
  },

  // git: it does not stage, commit or upload.
  async git(t) {
    // Nothing that ships runs git: the two launcher scripts start node and nothing else.
    for (const name of ['claude-health', 'claude-health.cmd']) assert.ok(!/(^|[\s;&|(`"'])git(\.exe)?[\s"']/m.test(read(name)), `${name} runs git`);
    for (const [name, text] of Object.entries({ ...sourcesIn(SCRIPTS), ...sourcesIn(path.join(PACKAGE_ROOT, 'bin')) })) {
      assert.ok(!/child_process|\bspawn(Sync)?\(|\bexecFile(Sync)?\(|\bexecSync\(|process\.binding|new Worker/.test(text), `${name} can start a program`);
    }
    // A project that is a repository: after a run with an applied change, what git keeps is as it was.
    const state = await drafting(t);
    const { fx, stamp } = state;
    const alpha = fx.project('alpha-service');
    mkdirSync(`${alpha}/.git/refs`, { recursive: true });
    writeFileSync(`${alpha}/.git/HEAD`, 'ref: refs/heads/main\n');
    writeFileSync(`${alpha}/.git/index`, 'DIRC-not-a-real-index');
    const kept = () => [...listing(fx.root)].filter(([file]) => file.includes('/.git/') || /(^|\/)\.git(ignore|attributes|modules)$/.test(file));
    const before = kept();
    assert.equal(before.length, 2);
    let current = await ok(fx, ['card', '--run', stamp]);
    let applied = 0;
    for (let guard = 0; guard < 60 && (current.card || current.need); guard += 1) {
      const at = current.card ?? current.need;
      const inProject = current.card && current.card.check === 'duplicate-across';
      if (inProject) applied += 1;
      current = await ok(fx, [inProject ? 'apply' : 'decide', '--run', stamp, '--card', String(at.n), '--answer', inProject ? 'apply' : 'skip']);
    }
    await ok(fx, ['finish', '--run', stamp]);
    assert.equal(applied, 1, 'the change in the repository was not reached');
    assert.ok(!readFileSync(`${alpha}/CLAUDE.md`, 'utf8').includes('Write commit messages in the imperative mood.'), 'the change was not made');
    assert.deepEqual(kept(), before, 'something git keeps was written');
  },
};

// Every .mjs file below a folder, by its name.
function sourcesIn(dir, out = {}, base = dir) {
  for (const [file] of listing(dir)) {
    if (file.endsWith('.mjs')) out[path.relative(base, path.join(dir, file)).replace(/\\/g, '/')] = readFileSync(path.join(dir, file), 'utf8');
  }
  return out;
}

test('every line of "what it never changes" has a proof, and no proof is left without a line', () => {
  assert.deepEqual(Object.keys(PROOFS).sort(), [...NEVER].sort());
});

for (const key of NEVER) {
  test(`never: ${STRINGS.en[`ui.promise.never.${key}`]}`, { timeout: 180_000 }, async (t) => {
    assert.equal(typeof PROOFS[key], 'function', `"${key}" is promised and never tried`);
    await PROOFS[key](t);
  });
}
