// One order for the suggested changes, file by file: the walk of cards, the console, report 1 and
// report 2 all take it from lib/order.mjs, and these tests hold them to it.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PACKAGE_ROOT, SCRIPTS, load, materialise } from './helpers/fixtures.mjs';
import { parseHtml } from './helpers/html.mjs';
import { confirmed, readJson } from './helpers/console.mjs';

const { runChecks } = await load('checks.mjs');
const { FILE_KINDS, byFile } = await load('lib/order.mjs');
const { scanSetup, startRun } = await load('lib/pipeline.mjs');
const render = await load('lib/render.mjs');
const { buildView } = await load('lib/view.mjs');
const { renderAfterView, renderStateView } = await load('report.mjs');
const { scan } = await load('scan.mjs');
const { parseEnvelope, ui } = await load('ui.mjs');

function fixture(t, name = 'main') {
  const fx = materialise(name);
  t.after(() => fx.cleanup());
  return fx;
}

async function call(fx, args) {
  const result = await ui([...args, '--json', '--home', fx.home], { cwd: PACKAGE_ROOT, env: {} });
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}`);
  return parseEnvelope(result.out);
}

// A run that was picked up and whose candidates were all confirmed: the queue is the findings of
// the checks and, among them by file and line, one finding of the reading per candidate.
async function judgedRun(fx, { nested = false } = {}) {
  const { scan: result, scanMs } = scanSetup({ home: fx.home, scope: { projects: [fx.projects], machine: false, nested } });
  const run = startRun({ home: fx.home, scan: result, scanMs, lang: 'en', startedBy: 'launcher' });
  const resumed = await call(fx, ['resume', run.stamp]);
  const reading = readJson(resumed.files.reading);
  writeFileSync(resumed.files.judgement, JSON.stringify(reading.candidates.map((candidate) => confirmed(candidate))));
  const judged = await call(fx, ['judged', '--run', run.stamp]);
  return { run, stamp: run.stamp, files: resumed.files, judged };
}

test('the order: user memory, the other user files, then each project; inside a file from the top down', () => {
  const home = '/h';
  const file = (kind, scope, project, name) => ({ kind, scope, project, path: name, lines: 10 });
  const made = {
    home,
    projects: [{ path: '/p/alpha', name: 'alpha' }, { path: '/p/beta', name: 'beta' }],
    files: [
      // Listed in an order that is none of the wanted one.
      file('rule', 'project', '/p/beta', '/p/beta/.claude/rules/api.md'),
      file('skill', 'user', null, '/h/.claude/skills/one/SKILL.md'),
      file('memory', 'project', '/p/beta', '/p/beta/CLAUDE.md'),
      file('command', 'project', '/p/alpha', '/p/alpha/.claude/commands/ship.md'),
      file('agent', 'user', null, '/h/.claude/agents/helper.md'),
      file('import', 'user', null, '/h/.claude/shared/notes.md'),
      file('memory', 'user', null, '/h/.claude/CLAUDE.md'),
      file('memory-local', 'project', '/p/alpha', '/p/alpha/CLAUDE.local.md'),
      file('rule', 'user', null, '/h/.claude/rules/style.md'),
      file('memory', 'project', '/p/alpha', '/p/alpha/CLAUDE.md'),
      file('skill', 'project', '/p/alpha', '/p/alpha/.claude/skills/two/SKILL.md'),
      file('command', 'user', null, '/h/.claude/commands/go.md'),
      file('memory-nested', 'project', '/p/alpha', '/p/alpha/web/CLAUDE.md'),
    ],
    settings: [
      { kind: 'settings', scope: 'project', project: '/p/alpha', path: '/p/alpha/.claude/settings.json' },
      { kind: 'settings', scope: 'user', project: null, path: '/h/.claude/settings.json' },
    ],
  };
  const items = [...made.files, ...made.settings].map((entry, index) => ({ id: `f${index}`, file: entry.path, line: 3, endLine: 3 }));
  // Two more in the user memory file: one above, one for the file as a whole.
  items.push({ id: 'top', file: '/h/.claude/CLAUDE.md', line: 1, endLine: 1 }, { id: 'whole', file: '/h/.claude/CLAUDE.md', line: null, endLine: null });
  // A file the scan does not list: inside a project it belongs to that project, elsewhere to the user files.
  items.push({ id: 'stray-project', file: '/p/alpha/docs/notes.md', line: 2, endLine: 2 }, { id: 'stray', file: '/elsewhere/notes.md', line: 2, endLine: 2 });

  const groups = byFile(made, items);
  assert.deepEqual(groups.map((group) => group.path), [
    '/h/.claude/CLAUDE.md',
    '/h/.claude/shared/notes.md',
    '/h/.claude/skills/one/SKILL.md',
    '/h/.claude/commands/go.md',
    '/h/.claude/agents/helper.md',
    '/h/.claude/rules/style.md',
    '/h/.claude/settings.json',
    '/elsewhere/notes.md',
    '/p/alpha/CLAUDE.md',
    '/p/alpha/CLAUDE.local.md',
    '/p/alpha/web/CLAUDE.md',
    '/p/alpha/.claude/skills/two/SKILL.md',
    '/p/alpha/.claude/commands/ship.md',
    '/p/alpha/.claude/settings.json',
    '/p/alpha/docs/notes.md',
    '/p/beta/CLAUDE.md',
    '/p/beta/.claude/rules/api.md',
  ]);
  assert.deepEqual(groups[0].items.map((item) => item.id), ['whole', 'top', 'f6'], 'what is about the whole file comes first, then the lines from the top');
  assert.deepEqual([groups[0].kind, groups[0].scope, groups[0].project, groups[0].lines], ['memory', 'user', null, 10]);
  assert.deepEqual([groups.at(-1).kind, groups.at(-1).scope, groups.at(-1).project], ['rule', 'project', '/p/beta']);
  assert.deepEqual([groups[7].kind, groups[7].scope, groups[14].kind, groups[14].project], ['other', 'user', 'other', '/p/alpha']);
  assert.equal(groups.reduce((sum, group) => sum + group.items.length, 0), items.length, 'no item is lost and none is doubled');

  // The same items in another order give the same result: the order is a property of the files.
  assert.deepEqual(byFile(made, [...items].reverse()).map((group) => [group.path, group.items.map((item) => item.id)]), groups.map((group) => [group.path, group.items.map((item) => item.id)]));
  // Two items on one line keep the order they came in.
  const pair = [{ id: 'a', file: '/h/.claude/CLAUDE.md', line: 5, endLine: 5 }, { id: 'b', file: '/h/.claude/CLAUDE.md', line: 5, endLine: 5 }];
  assert.deepEqual(byFile(made, pair)[0].items.map((item) => item.id), ['a', 'b']);
  assert.ok(['memory', 'skill', 'command', 'agent', 'rule', 'settings', 'other'].every((kind) => FILE_KINDS.includes(kind)));
  assert.ok(FILE_KINDS.indexOf('memory') < FILE_KINDS.indexOf('skill') && FILE_KINDS.indexOf('skill') < FILE_KINDS.indexOf('command'));
  assert.ok(FILE_KINDS.indexOf('command') < FILE_KINDS.indexOf('rule') && FILE_KINDS.indexOf('rule') < FILE_KINDS.indexOf('settings'));
});

test('a change that names two files belongs to the file its finding sits in', (t) => {
  const fx = fixture(t);
  const result = scan({ home: fx.home, projects: [fx.projects] });
  const checks = runChecks(result);
  const across = checks.findings.find((finding) => finding.check === 'duplicate-across');
  assert.notEqual(across.related[0].file, across.file);
  const group = byFile(result, checks.findings).find((entry) => entry.items.includes(across));
  assert.equal(group.path, across.file);
  assert.ok(!byFile(result, checks.findings).some((entry) => entry.path === across.related[0].file && entry.items.includes(across)));
});

test('the main fixture, file by file: what the view lists is what the order function gives', (t) => {
  const fx = fixture(t);
  const result = scan({ home: fx.home, projects: [fx.projects] });
  const checks = runChecks(result);
  const view = buildView({ scan: result, checks, lang: 'en' });
  assert.deepEqual(view.changes.files.map((file) => [file.label, file.count]), [
    ['~/.claude/CLAUDE.md', 4],
    ['~/.claude/shared/chain-4.md', 1],
    ['~/.claude/skills/long-skill/SKILL.md', 1],
    ['~/.claude/skills/no-description/SKILL.md', 1],
    ['~/.claude/skills/unreachable-skill/SKILL.md', 1],
    ['~/.claude/skills/wordy-skill/SKILL.md', 1],
    ['~/.claude/skills/wrong-name/SKILL.md', 1],
    ['~/.claude/commands/deploy.md', 1],
    ['~/.claude/agents/helper.md', 1],
    ['~/.claude/settings.json', 2],
    ['~/.claude/settings.local.json', 1],
    ['alpha-service/CLAUDE.md', 2],
    ['alpha-service/.claude/skills/shared-skill/SKILL.md', 1],
  ]);
  assert.equal(view.changes.total, checks.findings.length);
  const [memory] = view.changes.files;
  assert.deepEqual([memory.k, memory.of, memory.kind, memory.kindLabel, memory.scope, memory.lines, memory.limit, memory.percent, memory.state], [1, 13, 'memory', 'memory', 'user', 238, 200, 119, 'over']);
  // What a program can prove of this file: the total, a repeated line, an import that leads nowhere, its length.
  assert.deepEqual(memory.items.map((item) => item.line), [null, 10, 43, 47]);
  assert.deepEqual(memory.items.map((item) => item.n), [1, 2, 3, 4]);
  assert.deepEqual(memory.byKind.map((entry) => [entry.kind, entry.label, entry.count]), [
    ['make-rule-file', 'Move into a rule file', 1],
    ['delete-duplicate', 'Delete the duplicate', 1],
    ['shorten', 'Shorten', 2],
  ]);
  assert.deepEqual(memory.severities, { high: 0, medium: 3, low: 1 });
  const settings = view.changes.files.find((file) => file.label === '~/.claude/settings.json');
  assert.deepEqual([settings.kind, settings.lines, settings.limit, settings.state], ['settings', null, null, null], 'a settings file has no line count to show');
  const last = view.changes.files.at(-1);
  assert.deepEqual([last.k, last.of, last.items[0].n], [13, 13, checks.findings.length]);
  assert.deepEqual(Object.keys(memory.items[0]).sort(), ['check', 'id', 'kind', 'kindLabel', 'line', 'message', 'n', 'severity', 'severityLabel', 'title', 'where']);
  // The ids, in order, are those of the order function.
  assert.deepEqual(view.changes.files.flatMap((file) => file.items.map((item) => item.id)), byFile(result, checks.findings).flatMap((group) => group.items.map((item) => item.id)));
  assert.deepEqual(buildView({ scan: scan({ home: fixture(t, 'clean').home }), checks: runChecks(scan({ home: fixture(t, 'clean').home })), lang: 'en' }).changes, { total: 0, files: [] });
});

test('the walk, the console, report 1 and report 2 agree on one order', async (t) => {
  const fx = fixture(t);
  const { stamp, files, judged, run } = await judgedRun(fx);
  const state = readJson(path.join(files.run, 'state.json'));
  const checks = readJson(path.join(files.run, 'checks.json'));
  const scanned = readJson(path.join(files.run, 'scan.json'));
  const view = buildView({ scan: scanned, checks, lang: 'en' });
  const wanted = view.changes.files.flatMap((file) => file.items.map((item) => item.id));
  // Eighteen findings of the checks and the fifteen candidates the reading confirmed.
  assert.equal(wanted.length, 33);
  assert.equal(checks.findings.filter((finding) => finding.check === 'judgement').length, 15);

  // The walk: the queue of the state file.
  assert.deepEqual(state.queue.map((item) => item.id), wanted);

  // Report 1: the section of suggested changes links to each finding, in that order, one group per file.
  const html = readFileSync(run.files.report1, 'utf8');
  const page = parseHtml(html);
  const section = page.elements.find((element) => element.name === 'section' && element.classes.includes('changes'));
  assert.ok(section, 'report 1 has no file-by-file section');
  const links = page.elements.filter((element) => element.name === 'a' && element.ancestors.includes(section)).map((element) => element.attrs.href.slice(1));
  assert.deepEqual(links, wanted);
  const groups = page.elements.filter((element) => element.classes.includes('change-file') && element.ancestors.includes(section));
  assert.deepEqual(groups.map((element) => element.attrs['data-file']), view.changes.files.map((file) => file.path));
  assert.ok(renderStateView(view).includes('class="changes"'), 'report 1 is drawn from the view');

  // The console: the block after the reading lists the same files in the same order with the same counts.
  const block = judged.blocks.find((entry) => /FILE BY FILE/.test(entry.text));
  assert.ok(block, 'the reading ends without the list of changes per file');
  const rows = block.text.split('\n').filter((line) => /^\s+\d+ {2}\S/.test(line)).map((line) => /^\s+(\d+) {2}(\S+)\s+(\d+)\b/.exec(line).slice(1, 4));
  assert.deepEqual(rows, view.changes.files.map((file) => [String(file.k), file.label, String(file.count)]));
  assert.deepEqual(block.text.split('\n'), render.changes(view, { lang: 'en', colour: false, unicode: true }));

  // The cards come in that order: answered with "skip" to the end, every position is the next one.
  let current = await call(fx, ['card', '--run', stamp, '--walk', 'all']);
  const seen = [];
  for (let guard = 0; guard < 60 && (current.card || current.need); guard += 1) {
    const at = current.card ?? current.need;
    seen.push(at.id);
    current = await call(fx, ['decide', '--run', stamp, '--card', String(at.n), '--answer', 'skip']);
  }
  assert.deepEqual(seen, wanted);

  // Report 2: per file what was applied, skipped and left open, the files in the same order.
  await call(fx, ['finish', '--run', stamp]);
  const after = buildView({ scan: readJson(path.join(files.run, 'scan-after.json')), checks: readJson(path.join(files.run, 'checks-after.json')), before: checks, applied: readJson(path.join(files.run, 'applied.json')), lang: 'en' });
  assert.deepEqual(after.after.files.map((file) => file.path), view.changes.files.map((file) => file.path));
  assert.deepEqual(after.after.files.flatMap((file) => file.skipped.map((entry) => entry.id)), wanted);
  assert.ok(after.after.files.every((file) => file.applied.length === 0 && file.open.length === file.skipped.length));
  const report2 = readFileSync(path.join(fx.home, '.claude', 'health-check', `after-${stamp}.html`), 'utf8');
  const page2 = parseHtml(report2);
  const section2 = page2.elements.find((element) => element.name === 'section' && element.classes.includes('changes'));
  assert.deepEqual(page2.elements.filter((element) => element.classes.includes('change-file') && element.ancestors.includes(section2)).map((element) => element.attrs['data-file']), view.changes.files.map((file) => file.path));
  assert.ok(renderAfterView(after).includes('class="changes"'), 'report 2 is drawn from the view');
});

test('the order is the same on a second run of the same setup', async (t) => {
  const sequence = async () => {
    const fx = fixture(t);
    const { files } = await judgedRun(fx);
    return readJson(path.join(files.run, 'state.json')).queue.map((item) => `${item.where} ${item.check}`);
  };
  const [first, second] = [await sequence(), await sequence()];
  assert.equal(first.length, 33);
  assert.deepEqual(second, first);
  // With repositories nested in a project, each is a project of its own and follows the one before it.
  const fx = fixture(t, 'field');
  const { files } = await judgedRun(fx, { nested: true });
  const state = readJson(path.join(files.run, 'state.json'));
  const scanned = readJson(path.join(files.run, 'scan.json'));
  const places = state.queue.map((item) => item.place);
  const order = ['user', ...scanned.projects.map((project) => project.path)];
  assert.deepEqual([...places].sort((a, b) => order.indexOf(a) - order.indexOf(b)), places, 'the files of one place stand together, in the order of the scan');
});

test('one function owns the order: nothing else sorts the changes', () => {
  const read = (file) => readFileSync(path.join(SCRIPTS, file), 'utf8');
  for (const file of ['ui.mjs', 'lib/view.mjs']) assert.match(read(file), /import \{[^}]*\bbyFile\b[^}]*\} from '\.\/(lib\/)?order\.mjs'/, `${file} does not take the order from lib/order.mjs`);
  for (const file of ['report.mjs', 'lib/render.mjs']) {
    assert.ok(!/from '[^']*order\.mjs'/.test(read(file)), `${file} orders changes itself; it draws what the view gives`);
    assert.match(read(file), /view\.changes\b/, `${file} does not draw the changes file by file`);
    assert.ok(!/\.sort\([^)]*(severity|kind)/.test(read(file).split('function changes')[1]?.split('\nfunction ')[0] ?? ''), `${file} sorts the changes again`);
  }
  // The queue of the walk is made by the order function and by nothing after it.
  assert.match(read('ui.mjs'), /function orderQueue\(ctx, scan, findings\) \{\n {2}return byFile\(scan, findings\)\.flatMap\(/);
  assert.ok(!/ORDER\b/.test(read('ui.mjs')), 'ui.mjs still ranks the changes by kind');
});
