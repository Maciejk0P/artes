// What loads where, and what each file is called. One rule says which memory files stand above a
// project, one says which a setting switches off, one says which lines Claude Code strips, and one
// gives every file a name of its own. Each test here failed before that rule existed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySetup, load, materialise } from './helpers/fixtures.mjs';

const { runChecks } = await load('checks.mjs');
const { displayPath } = await load('lib/paths.mjs');
const render = await load('lib/render.mjs');
const { buildView } = await load('lib/view.mjs');
const { scan } = await load('scan.mjs');

function setup(t) {
  const s = emptySetup();
  t.after(() => s.cleanup());
  s.write('home/.claude/CLAUDE.md', ['# User', '- Keep answers short.']);
  return s;
}

const placeOf = (result, project) => result.alwaysLoaded.find((group) => group.project === project);
const loadedIn = (result, project) => placeOf(result, project).files.map((file) => file.path);
const outerRules = () => Array.from({ length: 50 }, (_, index) => `- Outer rule ${index}.`);

test('a repository nested in a project: what is said about AGENTS.md and what is counted as loaded follow one rule', (t) => {
  const s = setup(t);
  const outer = s.write('projects/outer/CLAUDE.md', ['# Outer', ...outerRules()]);
  s.dir('projects/outer/clones/inner/.git');
  s.dir('projects/outer/clones/inner/.claude');
  s.write('projects/outer/clones/inner/AGENTS.md', ['# Agents', '- Agent rule.']);
  const inner = `${s.projects}/outer/clones/inner`;
  const scanned = scan({ home: s.home, projects: [`${s.projects}/outer`], nested: true });
  const result = runChecks(scanned);
  const agents = scanned.files.find((file) => file.kind === 'agents-md');
  // AGENTS.md is not read because outer/CLAUDE.md stands above it; then outer/CLAUDE.md loads there.
  assert.equal(agents.loads, 'never');
  assert.deepEqual(loadedIn(result, inner), [`${s.home}/.claude/CLAUDE.md`, outer]);
  assert.equal(placeOf(result, inner).lines, 2 + 51);
  assert.deepEqual(scanned.projects.find((project) => project.path === inner).memoryAbove, [outer]);
  const tax = result.contextTax.find((place) => place.project === inner);
  assert.ok(tax.parts.some((part) => part.path === outer), 'the file above is missing from the context tax of the nested repository');

  // Nothing above it: AGENTS.md is read, and is what is counted.
  const bare = setup(t);
  bare.dir('projects/outer/.claude');
  bare.dir('projects/outer/clones/inner/.git');
  bare.dir('projects/outer/clones/inner/.claude');
  const lone = bare.write('projects/outer/clones/inner/AGENTS.md', ['# Agents', '- Agent rule.']);
  const second = scan({ home: bare.home, projects: [`${bare.projects}/outer`], nested: true });
  assert.equal(second.files.find((file) => file.kind === 'agents-md').loads, 'launch');
  assert.deepEqual(loadedIn(runChecks(second), `${bare.projects}/outer/clones/inner`), [`${bare.home}/.claude/CLAUDE.md`, lone]);
});

test('a memory file in a folder between a nested repository and its project loads there too, and nowhere twice', (t) => {
  const s = setup(t);
  const outer = s.write('projects/outer/CLAUDE.md', ['# Outer', '- Always use the shared logger in every module.']);
  const middle = s.write('projects/outer/clones/CLAUDE.md', ['# Clones', '- Never use the shared logger in a clone of a module.']);
  s.dir('projects/outer/clones/inner/.git');
  const own = s.write('projects/outer/clones/inner/CLAUDE.md', ['# Inner', '- Inner rule.']);
  const inner = `${s.projects}/outer/clones/inner`;
  const scanned = scan({ home: s.home, projects: [`${s.projects}/outer`], nested: true });
  const result = runChecks(scanned);
  assert.deepEqual(loadedIn(result, inner), [`${s.home}/.claude/CLAUDE.md`, outer, middle, own], 'outermost first, its own last');
  assert.deepEqual(loadedIn(result, `${s.projects}/outer`), [`${s.home}/.claude/CLAUDE.md`, outer], 'in the outer project the file of the subfolder loads on demand');
  // The pair of lines that load together only in the nested repository is found once, there.
  const pairs = result.candidates.filter((candidate) => candidate.check === 'conflict-candidate');
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].file, pairs[0].related[0].file].sort(), [middle, outer].sort());
});

test('a user file that the project around a nested repository switches off is gone through once, and never compared with itself', (t) => {
  const s = emptySetup();
  t.after(() => s.cleanup());
  const user = s.write('home/.claude/CLAUDE.md', ['# User', '- Keep answers short.', '- Always use the shared logger in every module.', '', '@shared/everywhere.md']);
  const shared = s.write('home/.claude/shared/everywhere.md', ['# Everywhere', '- Write commit subjects in the imperative.', '- Never use the shared logger in a module of the core.']);
  const outer = s.write('projects/outer/CLAUDE.md', ['# Outer', '- Outer rule.', '- Write commit subjects in the imperative.']);
  s.write('projects/outer/.claude/settings.json', JSON.stringify({ claudeMdExcludes: ['**/.claude/shared/everywhere.md'] }));
  s.dir('projects/outer/clones/inner/.git');
  const own = s.write('projects/outer/clones/inner/CLAUDE.md', ['# Inner', '- Inner rule.']);
  const inner = `${s.projects}/outer/clones/inner`;
  const result = runChecks(scan({ home: s.home, projects: [`${s.projects}/outer`], nested: true }));
  // The project switches the import off; the repository inside it has settings of its own, and loads it.
  assert.deepEqual(loadedIn(result, `${s.projects}/outer`), [user, outer]);
  assert.deepEqual(loadedIn(result, inner), [user, shared, outer, own]);
  const selfRelated = (entries) => entries.filter((entry) => (entry.related ?? []).some((related) => related.file === entry.file && related.line === entry.line));
  assert.deepEqual(selfRelated([...result.findings, ...result.candidates]).map((entry) => `${entry.check} ${entry.file}:${entry.line}`), [], 'a line is reported as a copy of itself');
  // The line of the outer file is in the import as well, but where the outer file loads alone
  // the import does not: deleting it there would lose the instruction, so nothing is said.
  assert.deepEqual(result.findings.filter((finding) => finding.check === 'duplicate-across').map((finding) => `${finding.file}:${finding.line}`), []);
  // The two user lines that may contradict load together in three places and are listed once.
  const pairs = result.candidates.filter((candidate) => candidate.check === 'conflict-candidate');
  assert.deepEqual(pairs.map((pair) => [pair.file, pair.related[0].file].sort()), [[user, shared].sort()]);

  // The same on the fixture made from a real setup: an import the outer project switches off.
  const fx = materialise('field');
  t.after(() => fx.cleanup());
  const field = runChecks(scan({ home: fx.home, projects: [fx.project('outer-app'), fx.project('agents-only')], nested: true }));
  assert.deepEqual(selfRelated([...field.findings, ...field.candidates]).map((entry) => `${entry.check} ${entry.file}:${entry.line}`), [], 'a line is reported as a copy of itself');
});

test('a project named inside another named project keeps its own memory file, and gets the files above it', (t) => {
  const s = setup(t);
  const mono = s.write('projects/mono/CLAUDE.md', ['# Mono', '- Rule of mono.']);
  const web = s.write('projects/mono/packages/web/CLAUDE.md', ['# Web', '- Rule of web.', '- Second rule of web.']);
  for (const roots of [[`${s.projects}/mono`, `${s.projects}/mono/packages/web`], [`${s.projects}/mono/packages/web`, `${s.projects}/mono`]]) {
    const scanned = scan({ home: s.home, projects: roots });
    const result = runChecks(scanned);
    const file = scanned.files.find((entry) => entry.path === web);
    assert.deepEqual([file.kind, file.project], ['memory', `${s.projects}/mono/packages/web`], `the inner project's own file was taken for a subfolder file of the outer one (${roots.join(', ')})`);
    assert.deepEqual(loadedIn(result, `${s.projects}/mono/packages/web`), [`${s.home}/.claude/CLAUDE.md`, mono, web]);
    assert.deepEqual(loadedIn(result, `${s.projects}/mono`), [`${s.home}/.claude/CLAUDE.md`, mono]);
    assert.equal(scanned.files.filter((entry) => entry.path === web).length, 1);
  }
});

test('a memory file in a subfolder that claudeMdExcludes switches off gets no findings and is listed as excluded', (t) => {
  const s = setup(t);
  s.write('projects/mono/CLAUDE.md', ['# Mono', '- Rule of mono.']);
  const other = s.write('projects/mono/other-team/CLAUDE.md', ['# Other team', '- Never deploy on Friday, except for hotfixes.', ...Array.from({ length: 230 }, (_, index) => `Line ${index} of the other team.`)]);
  const kept = s.write('projects/mono/own-team/CLAUDE.md', ['# Own team', ...Array.from({ length: 230 }, (_, index) => `Line ${index} of the own team.`)]);
  s.write('projects/mono/.claude/settings.local.json', JSON.stringify({ claudeMdExcludes: ['**/other-team/CLAUDE.md'] }));
  const scanned = scan({ home: s.home, projects: [`${s.projects}/mono`] });
  const result = runChecks(scanned);
  const about = (file) => [...result.findings, ...result.candidates].filter((entry) => entry.file === file).map((entry) => entry.check);
  assert.deepEqual(about(other), [], 'a file that is switched off was checked');
  assert.deepEqual(about(kept), ['memory-too-long'], 'the file next to it, which is not switched off, is still checked');
  const excluded = placeOf(result, `${s.projects}/mono`).excluded;
  assert.deepEqual(excluded.map((file) => [file.path, file.pattern]), [[other, '**/other-team/CLAUDE.md']]);
  const view = buildView({ scan: scanned, checks: result, lang: 'en' });
  assert.equal(view.inventory.onDemand.nestedMemory, 1, 'a file that is switched off is not one that loads on demand');
});

test('lines inside a block-level HTML comment are not instructions and cost no context', (t) => {
  const s = emptySetup();
  t.after(() => s.cleanup());
  const body = ['# User', '<!--', '- Never do X, except on Friday.', '1. Run a.', '2. Run b.', '3. Run c.', '4. Run d.', '- When I say "ship it", run the release.', '-->', '- One real rule.'];
  const memory = s.write('home/.claude/CLAUDE.md', body);
  const scanned = scan({ home: s.home });
  const result = runChecks(scanned);
  assert.deepEqual(result.findings.map((finding) => finding.check), []);
  assert.deepEqual(result.candidates.map((candidate) => candidate.check), []);
  const file = scanned.files.find((entry) => entry.path === memory);
  const commented = body.slice(1, 9).join('\n').length + 1;
  assert.deepEqual([file.lines, file.commentLines, file.commentBytes], [10, 8, commented]);
  const [place] = result.contextTax;
  assert.equal(place.parts[0].bytes, file.bytes - commented, 'the bytes of the comment are counted into the context tax');
  assert.equal(result.alwaysLoaded[0].lines, 2, 'the lines of the comment are counted as loaded');

  // 250 commented-out lines and one rule: the cost is that of the rule.
  const big = emptySetup();
  t.after(() => big.cleanup());
  big.write('home/.claude/CLAUDE.md', ['<!--', ...Array.from({ length: 250 }, (_, index) => `- Old rule number ${index} that nobody removed from the file.`), '-->', '- The one rule.']);
  const tax = runChecks(scan({ home: big.home })).contextTax[0];
  assert.ok(tax.tokens < 20, `about ${tax.tokens} tokens for one rule`);

  // What is not a block-level comment stays text: a comment inside a line, one inside a code block, one that never closes.
  const plain = emptySetup();
  t.after(() => plain.cleanup());
  plain.write('home/.claude/CLAUDE.md', ['# User', '- Never do X, except on Friday. <!-- why -->', '```', '<!--', '```', '- Never do Y, except on Monday.', '<!-- never closed', '- Never do Z, except on Sunday.']);
  const kept = runChecks(scan({ home: plain.home }));
  assert.deepEqual(kept.candidates.filter((candidate) => candidate.check === 'exception').map((candidate) => candidate.line), [2, 6, 8]);
});

// The labels of everything one result lists, and the two that are the same, if any.
function sharedLabel(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.label) && seen.get(row.label) !== row.path) return `${row.label} is both ${seen.get(row.label)} and ${row.path}`;
    seen.set(row.label, row.path);
  }
  return null;
}

test('no two files of a result share a label, whatever the folders are called', (t) => {
  // Layouts in which the name of one project is the name of another plus a path below it, in
  // which a project sits inside one of the same name, and in which a folder is called like the
  // mark that stands for the home folder.
  const layouts = {
    'one name is another name plus a folder': (s) => {
      s.write('projects/work/app/CLAUDE.md', ['# App', '- Use the shared eslint config of the team.']);
      s.write('projects/work/app/web/CLAUDE.md', ['# Web of app', '- Keep it.', '- Keep it.']);
      s.write('projects/old/app/web/CLAUDE.md', ['# Old web', '- Use the shared eslint config of the team.', '- Keep it.', '- Keep it.']);
      s.write('projects/new/web/CLAUDE.md', ['# New web', '- Use the shared eslint config of the team.']);
      return { projects: ['work/app', 'old/app/web', 'new/web'] };
    },
    'three deep, and a project of the same name inside': (s) => {
      s.write('projects/a/web/CLAUDE.md', ['# A', '- Keep it.', '- Keep it.']);
      s.write('projects/a/web/web/CLAUDE.md', ['# Inner', '- Keep it.', '- Keep it.']);
      s.dir('projects/a/web/web/.git');
      s.write('projects/b/web/web/CLAUDE.md', ['# B', '- Keep it.', '- Keep it.']);
      s.write('projects/b/web/web/web/CLAUDE.md', ['# B deeper', '- Keep it.', '- Keep it.']);
      s.write('projects/web/CLAUDE.md', ['# Top', '- Keep it.', '- Keep it.']);
      return { projects: ['a/web', 'b/web/web', 'web', 'a/web/web'], nested: true };
    },
    'a folder called like the home mark': (s) => {
      s.write('projects/x/~/.claude/CLAUDE.md', ['# Tilde', '- Keep it.', '- Keep it.']);
      s.write('projects/x/~/CLAUDE.md', ['# Tilde root', '- Keep answers short.']);
      s.write('projects/y/~/CLAUDE.md', ['# Other tilde', '- Keep answers short.']);
      s.write('home/.claude/rules/always.md', ['- Keep it.']);
      return { projects: ['x/~', 'y/~'] };
    },
    'a project inside the home folder next to user files': (s) => {
      s.write('home/.claude/skills/tidy/SKILL.md', ['---', 'name: tidy', 'description: Tidy. Use when asked.', '---', 'Body.']);
      s.write('home/code/.claude/skills/tidy/SKILL.md', ['---', 'name: tidy', 'description: Tidy. Use when asked.', '---', 'Body.']);
      s.write('home/code/.claude/CLAUDE.md', ['# Code', '- Keep it.']);
      s.write('projects/.claude/CLAUDE.md', ['# Folder of projects', '- Keep it.']);
      s.write('projects/code/.claude/CLAUDE.md', ['# Code elsewhere', '- Keep it.']);
      return { projects: ['../home/code', 'code', '.'] };
    },
  };
  for (const [what, build] of Object.entries(layouts)) {
    const s = setup(t);
    const { projects, nested = false } = build(s);
    const scanned = scan({ home: s.home, projects: projects.map((project) => `${s.projects}/${project}`), nested });
    const result = runChecks(scanned);
    assert.equal(sharedLabel(result.files), null, what);
    assert.ok(result.files.length >= 4, `${what}: the layout was not scanned as planned`);
    // Projects are named by the same rule, and a place is a project.
    const roots = scanned.projects.map((project) => project.path);
    assert.equal(sharedLabel([...result.files, ...roots.map((root) => ({ path: root, label: displayPath(root, s.home, roots) }))]), null, what);
    // Every list a screen or a report draws from says the same.
    const view = buildView({ scan: scanned, checks: result, lang: 'en' });
    for (const [list, rows] of Object.entries({ files: view.files, places: view.loaded.places.map((place) => ({ ...place, path: place.key })), tax: view.contextTax.places.map((place) => ({ ...place, path: place.key })), changes: view.changes.files })) {
      assert.equal(sharedLabel(rows), null, `${what}: ${list}`);
    }
    const names = view.scope.projects.map((project) => project.name);
    assert.equal(new Set(names).size, names.length, `${what}: two projects share a name: ${names.join(', ')}`);
    // A finding says where it is by label: two findings in two files never read the same.
    const places = new Map();
    for (const finding of result.findings) {
      const where = `${displayPath(finding.file, s.home, roots)}:${finding.line}`;
      assert.ok(!places.has(where) || places.get(where) === finding.file, `${what}: ${where} names two files`);
      places.set(where, finding.file);
    }
  }
});

test('labels are told apart for any set of folders: a thousand made-up layouts', () => {
  // A small generator with a fixed seed: the same layouts on every run.
  let seed = 20261002;
  const random = (count) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * count);
  };
  const pick = (list) => list[random(list.length)];
  const names = ['web', 'app', 'api', '~', 'a', 'old'];
  const folder = (depth) => Array.from({ length: depth }, () => pick(names)).join('/');
  const home = '/h/u';
  for (let layout = 0; layout < 1000; layout += 1) {
    const roots = [...new Set(Array.from({ length: 2 + random(5) }, () => `${pick([home, '/srv', '/srv/x'])}/${folder(1 + random(4))}`))];
    const files = new Set([`${home}/.claude/CLAUDE.md`, `${home}/${folder(1 + random(2))}/CLAUDE.md`]);
    for (const root of roots) {
      files.add(root);
      files.add(`${root}/CLAUDE.md`);
      for (let extra = 0; extra < 3; extra += 1) files.add(`${root}/${folder(1 + random(3))}/CLAUDE.md`);
    }
    const shared = sharedLabel([...files].map((file) => ({ path: file, label: displayPath(file, home, roots) })));
    assert.equal(shared, null, `layout ${layout}, projects ${roots.join(', ')}`);
  }
});

test('two projects whose folders have the same name are told apart in every label', (t) => {
  const s = setup(t);
  s.write('home/.claude/CLAUDE.md', ['# User', '- Keep answers short.', '- Use the shared eslint config of the team.']);
  const a = s.write('projects/client-a/web/CLAUDE.md', ['# Web of client A', '- Use the shared eslint config of the team.']);
  const b = s.write('projects/client-b/web/CLAUDE.md', ['# Web of client B', '- Use the shared eslint config of the team.']);
  const roots = [`${s.projects}/client-a/web`, `${s.projects}/client-b/web`];
  assert.deepEqual([displayPath(a, s.home, roots), displayPath(b, s.home, roots)], ['client-a/web/CLAUDE.md', 'client-b/web/CLAUDE.md']);
  assert.equal(displayPath(a, s.home, [roots[0]]), 'web/CLAUDE.md', 'a name that is alone stays short');
  assert.deepEqual([displayPath(roots[0], s.home, roots), displayPath(`${s.home}/.claude/CLAUDE.md`, s.home, roots)], ['client-a/web', '~/.claude/CLAUDE.md']);

  const scanned = scan({ home: s.home, projects: roots });
  const result = runChecks(scanned);
  const view = buildView({ scan: scanned, checks: result, lang: 'en' });
  const distinct = (rows, what) => {
    const labels = rows.map((row) => row.label);
    assert.equal(new Set(labels).size, labels.length, `${what}: two rows share a label: ${labels.join(', ')}`);
  };
  distinct(view.files, 'memory files');
  distinct(view.loaded.places, 'places');
  distinct(view.contextTax.places, 'places of the context tax');
  distinct(view.changes.files, 'files with changes');
  assert.equal(view.changes.files.length, 2, 'both project files repeat a line of the user file');
  assert.deepEqual(view.scope.projects.map((project) => project.name), ['client-a/web', 'client-b/web']);
  const screen = render.overview(view, { lang: 'en', colour: false, unicode: true }).join('\n');
  assert.match(screen, /client-a\/web\/CLAUDE\.md/);
  assert.match(screen, /in client-b\/web/);
  for (const finding of result.findings) assert.ok(!/ web\/CLAUDE\.md| in web\b/.test(`${finding.message} ${finding.suggestion.detail}`), finding.message);
});
