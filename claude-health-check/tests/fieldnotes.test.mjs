// One test per thing the first build got wrong when it was run on a real setup. The `field`
// fixture reproduces each of them; every test here failed on the first build.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { load, materialise } from './helpers/fixtures.mjs';
import { closedDetailsDepth, parseHtml } from './helpers/html.mjs';

const { runChecks } = await load('checks.mjs');
const { scan } = await load('scan.mjs');

let fx;
let plain;
let nested;
let checks;
let nestedChecks;

before(() => {
  fx = materialise('field');
  plain = scan({ home: fx.home, projects: [fx.projects] });
  nested = scan({ home: fx.home, projects: [fx.projects], nested: true });
  checks = runChecks(plain);
  nestedChecks = runChecks(nested);
});
after(() => fx.cleanup());

const outer = () => fx.project('outer-app');
const inner = () => `${outer()}/clones/inner-kit`;
const worktree = () => `${outer()}/clones/worktree-kit`;
const of = (result, check) => result.findings.filter((finding) => finding.check === check);
const candidatesOf = (result, check) => result.candidates.filter((candidate) => candidate.check === check);
const lineOf = (result, file, needle) => {
  const all = [...result.findings, ...result.candidates].filter((entry) => entry.file === file && entry.quote?.includes(needle));
  return all.map((entry) => entry.check);
};

test('note 1: a folder with its own repository marker is a separate project, read only when asked for', () => {
  // Left out: nothing of the clones is listed, counted or checked.
  assert.deepEqual(
    plain.projects.map((project) => [project.name, project.nestedIn]),
    [
      ['agents-only', null],
      ['outer-app', null],
    ],
  );
  assert.ok(!plain.files.some((file) => file.path.includes('/clones/')), 'a file of a nested repository was read');
  assert.ok(!JSON.stringify(checks).includes('inner-kit/CLAUDE.md'), 'a nested repository reached the checks');
  assert.deepEqual(
    plain.nestedRepositories.map((entry) => [path.basename(entry.path), entry.parent === outer(), entry.setup, entry.included]),
    [
      ['inner-kit', true, true, false],
      ['plain-repo', true, false, false],
      ['worktree-kit', true, true, false],
    ],
    'a marker that is a folder and a marker that is a file both count; a clone with no Claude Code files is named and nothing more',
  );
  assert.equal(of(checks, 'import-unresolved').length, 0);

  // Asked for: each is its own project, and none of its files belongs to the outer one.
  assert.deepEqual(
    nested.projects.map((project) => [project.name, project.nestedIn === null ? null : path.basename(project.nestedIn)]),
    [
      ['agents-only', null],
      ['outer-app', null],
      ['inner-kit', 'outer-app'],
      ['worktree-kit', 'outer-app'],
    ],
  );
  const innerFiles = nested.files.filter((file) => file.path.startsWith(`${inner()}/`));
  assert.deepEqual(innerFiles.map((file) => [file.kind, file.project === inner()]).sort(), [
    ['memory', true],
    ['skill', true],
  ]);
  assert.ok(!nested.files.some((file) => file.kind === 'memory-nested' && file.path.includes('/clones/')));
  assert.equal(nested.files.find((file) => file.path === `${worktree()}/CLAUDE.md`).project, worktree());
  assert.deepEqual(
    nested.nestedRepositories.map((entry) => [path.basename(entry.path), entry.included]),
    [
      ['inner-kit', true],
      ['plain-repo', false],
      ['worktree-kit', true],
    ],
  );
  const outerLoaded = nestedChecks.alwaysLoaded.find((group) => group.project === outer());
  assert.ok(!outerLoaded.files.some((file) => file.path.includes('/clones/')), 'the outer project counts a file of a nested repository');
  assert.ok(nestedChecks.alwaysLoaded.some((group) => group.project === inner()), 'the nested repository has its own row');
  assert.deepEqual(
    of(nestedChecks, 'import-unresolved').map((finding) => finding.file),
    [`${inner()}/CLAUDE.md`],
  );
});

test('note 2: only a line written as an instruction is asked about its exception, and only as a candidate', async () => {
  const { matchException, isInstruction } = await load('checks.mjs');
  assert.deepEqual(of(checks, 'exception'), [], 'the word lists cannot prove a line is a rule, so it is never a finding');
  const exceptions = candidatesOf(checks, 'exception');
  assert.deepEqual(
    exceptions.map((candidate) => [candidate.file === `${outer()}/CLAUDE.md`, candidate.quote]),
    [[true, '- Never commit to the main branch, unless the change is a release tag.']],
  );
  for (const prose of [
    '- The export covers all customers except in the test region.',
    '- A matcher is instantiated only if its modality is configured.',
    '- Pravidlo sa použije na všetky súbory okrem generovaných.',
    'Workers are started only when the queue is not empty.',
  ]) {
    assert.ok(matchException(prose), `${prose} carries a marker`);
    assert.equal(isInstruction(prose), false, prose);
  }
  for (const instruction of [
    '- Never commit to the main branch, unless the change is a release tag.',
    '- Use tabs, except in YAML files.',
    'You must ask first, unless the change is one line.',
    '- Always answer in English, only when asked otherwise switch.',
    '- Do not edit generated files, except lockfiles.',
    '- Nikdy nemeň hotový text, okrem preklepov.',
    '- Vždy píš po anglicky, iba ak ide o citát, nie.',
    '- Súbor sa nesmie meniť, pokiaľ nie je odomknutý.',
    '- Test musí bežať lokálne, len keď to nejde, v CI.',
    '- Zapisuj rozhodnutia do denníka, výnimka sú preklepy.',
  ]) {
    assert.ok(matchException(instruction), `${instruction} carries a marker`);
    assert.equal(isInstruction(instruction), true, instruction);
  }
  // With the nested repository included, its one instruction is found and its prose is not.
  assert.deepEqual(
    candidatesOf(nestedChecks, 'exception')
      .filter((candidate) => candidate.file === `${inner()}/CLAUDE.md`)
      .map((candidate) => candidate.quote),
    ['- Never log request bodies, unless debugging is switched on.'],
  );
});

test('note 3: pairs found by shared words are candidates, never findings, and function words are not shared terms', () => {
  assert.equal(of(checks, 'conflict-candidate').length, 0, 'a pair found by wording was reported as a finding');
  assert.ok(checks.findings.every((finding) => finding.check !== 'conflict-candidate'));
  // "ani" and "ešte" are all the two Slovak lines share.
  assert.deepEqual(lineOf(checks, `${outer()}/CLAUDE.md`, 'Nikdy nemaž testy'), []);
  // Two neighbouring lines of one section refine each other.
  assert.deepEqual(lineOf(checks, `${outer()}/CLAUDE.md`, 'subject line of a commit message'), []);
  assert.deepEqual(candidatesOf(checks, 'conflict-candidate'), []);
  assert.deepEqual(checks.metrics.conflictPairs, { found: 0, compared: 0, confirmed: 0, leftOut: 0 });
  for (const candidate of checks.candidates) {
    assert.equal('severity' in candidate, false, 'a candidate has no severity before it is read');
    assert.equal(candidate.status, 'open');
  }
  const counted = checks.metrics.findings.high + checks.metrics.findings.medium + checks.metrics.findings.low;
  assert.equal(counted, checks.findings.length, 'candidates are not counted with the findings');
});

test('note 4: a numbered list is a candidate, whether its items read as principles or as actions', () => {
  const file = `${outer()}/CLAUDE.md`;
  assert.deepEqual(
    candidatesOf(checks, 'procedure-in-memory').map((candidate) => [candidate.file, candidate.quote.split('\n')[0], candidate.quote.split('\n').length]),
    [
      [file, '1. Correctness before speed.', 5],
      [file, '1. Run the full test suite.', 4],
    ],
  );
  assert.deepEqual(of(checks, 'procedure-in-memory'), [], 'principles are written in the imperative too: no numbered list is a finding');
});

test('note 5: a hook event of the verified list is not reported; one outside it is "not in the list", never wrong', () => {
  const unknown = of(checks, 'hook-unknown-event');
  assert.deepEqual(
    unknown.map((finding) => [finding.data.event, finding.severity]),
    [['BeforeLunch', 'low']],
    'TaskCompleted and WorktreeCreate are documented events',
  );
  assert.match(unknown[0].message, /not in the list/);
  assert.ok(!/never runs|wrong|invalid|misspel/i.test(`${unknown[0].message} ${unknown[0].title ?? ''}`));
  assert.match(unknown[0].why, /hooks-guide\.md/);
  assert.match(unknown[0].why, /2026-10-01/, 'the finding says when the list was read');
});

test('note 6: a file excluded by claudeMdExcludes is listed as excluded and not counted for that project', () => {
  const settings = plain.settings.find((entry) => entry.project === outer() && entry.kind === 'settings');
  assert.deepEqual(settings.claudeMdExcludes, ['**/.claude/shared/everywhere.md']);
  const everywhere = `${fx.home}/.claude/shared/everywhere.md`;
  const group = (project) => checks.alwaysLoaded.find((entry) => entry.project === project);

  const user = group(null);
  assert.ok(user.files.some((file) => file.path === everywhere), 'the user files alone still load the import');
  assert.deepEqual(user.excluded, []);

  const project = group(outer());
  assert.ok(!project.files.some((file) => file.path === everywhere), 'the excluded import is still counted');
  assert.deepEqual(
    project.excluded.map((entry) => [entry.path, entry.lines, entry.pattern, entry.setting === settings.path]),
    [[everywhere, 12, '**/.claude/shared/everywhere.md', true]],
  );
  assert.equal(user.lines - project.lines + project.files.filter((file) => file.project === outer()).reduce((sum, file) => sum + file.lines, 0), 12);

  // The other project has no such setting, so the file loads there.
  assert.ok(group(fx.project('agents-only')).files.some((file) => file.path === everywhere));
});

test('note 7: rule files without paths load at launch and are counted, at user level and in a project', () => {
  const rule = (name) => plain.files.find((file) => file.kind === 'rule' && file.path.endsWith(name));
  assert.equal(rule('rules/always.md').loads, 'launch');
  assert.equal(rule('rules/typescript.md').loads, 'on-demand');
  assert.equal(rule('rules/general.md').loads, 'launch');
  assert.equal(rule('rules/api.md').loads, 'on-demand', 'paths written as one string count as paths');

  const roles = (project) =>
    checks.alwaysLoaded.find((entry) => entry.project === project).files.map((file) => [file.label, file.role, file.lines]);
  assert.deepEqual(roles(null), [
    ['~/.claude/CLAUDE.md', 'memory', 12],
    ['~/.claude/shared/everywhere.md', 'import', 12],
    ['~/.claude/rules/always.md', 'rule', 5],
  ]);
  assert.deepEqual(roles(outer()), [
    ['~/.claude/CLAUDE.md', 'memory', 12],
    ['~/.claude/rules/always.md', 'rule', 5],
    ['outer-app/CLAUDE.md', 'memory', 34],
    ['outer-app/.claude/rules/general.md', 'rule', 4],
  ]);
  assert.equal(checks.metrics.alwaysLoadedLines.user, 29);
  assert.equal(checks.metrics.alwaysLoadedLines[outer()], 55);
});

test('note 8: a linked skill folder is not read, and is still listed by name', (t) => {
  const local = materialise('field');
  t.after(() => local.cleanup());
  const target = path.join(local.root, 'elsewhere', 'borrowed-skill');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'SKILL.md'), '---\nname: borrowed-skill\ndescription: LINKED-DESCRIPTION\n---\n\n1. LINKED-STEP one.\n2. LINKED-STEP two.\n');
  try {
    symlinkSync(target, path.join(local.home, '.claude', 'skills', 'borrowed-skill'), 'junction');
  } catch (error) {
    t.skip(`this platform refused to create a link: ${error.code}`);
    return;
  }
  const result = scan({ home: local.home, projects: [local.projects] });
  assert.deepEqual(
    result.linked.map((entry) => [entry.kind, entry.name, entry.scope, entry.project]),
    [['skill', 'borrowed-skill', 'user', null]],
  );
  assert.ok(!result.files.some((file) => file.path.includes('borrowed-skill')), 'the linked skill was read');
  assert.ok(!JSON.stringify([result, runChecks(result)]).includes('LINKED-'), 'text of the linked skill reached the result');
  assert.ok(result.skipped.some((entry) => entry.reason === 'symlink' && entry.path.endsWith('borrowed-skill')));
});

test('note 9: a third-party skill is marked "do not edit" and gets a note where its own skill would get a finding', () => {
  const skill = (name) => plain.files.find((file) => file.kind === 'skill' && file.scope === 'user' && file.name === name);
  assert.deepEqual(skill('vendor-skill').thirdParty, ['license-file']);
  assert.deepEqual(skill('authored-skill').thirdParty, ['front-matter:author']);
  assert.equal(skill('own-skill').thirdParty, null);

  const about = (list, name) => list.filter((entry) => entry.file === skill(name).path).map((entry) => entry.check);
  assert.deepEqual(about(checks.findings, 'vendor-skill'), [], 'a suggestion was made on a downloaded skill');
  assert.deepEqual(about(checks.findings, 'authored-skill'), []);
  assert.deepEqual(about(checks.notes, 'vendor-skill'), ['skill-no-when-cue']);
  assert.deepEqual(about(checks.notes, 'authored-skill').sort(), ['skill-name-mismatch', 'skill-no-when-cue']);
  for (const note of checks.notes) {
    assert.equal('severity' in note, false);
    assert.equal('suggestion' in note, false);
    assert.ok(note.message);
  }
});

test('note 10: a finding without a line is shown by its file alone, in the view and in the report', async () => {
  const { buildView } = await load('lib/view.mjs');
  const { renderState } = await load('report.mjs');
  const tight = runChecks(plain, { totalLines: 20 });
  const total = of(tight, 'always-loaded-total');
  assert.ok(total.length >= 1);
  assert.deepEqual([total[0].line, total[0].endLine, total[0].quote, total[0].quoteSha], [null, null, null, null]);

  const view = buildView({ scan: plain, checks: tight, lang: 'en' });
  const items = view.findings.bySeverity.flatMap((severity) => severity.groups.flatMap((group) => group.items));
  const item = items.find((entry) => entry.id === total[0].id);
  assert.equal(item.where, '~/.claude/CLAUDE.md');
  assert.equal(item.line, null);
  for (const entry of items) assert.ok(!/null|undefined|NaN/.test(entry.where), entry.where);

  const html = renderState({ scan: plain, checks: tight, lang: 'en' });
  assert.ok(!/:null|:undefined|>null<|>undefined</.test(html), 'the report prints a missing line');
});

test('note 11: thirty skills and forty findings do not make a wall', async (t) => {
  const { buildView } = await load('lib/view.mjs');
  const { renderStateView } = await load('report.mjs');
  const local = materialise('clean');
  t.after(() => local.cleanup());
  const steps = ['1. Read the input.', '2. If it is empty, stop.', '3. Change it.', '4. Write the output.'].join('\n');
  for (let index = 1; index <= 30; index += 1) {
    const dir = path.join(local.home, '.claude', 'skills', `bulk-skill-${index}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: bulk-skill-${index}\ndescription: Does thing ${index}. Use when the user asks for thing ${index}.\n---\n\n${steps}\n`);
  }
  const rules = Array.from({ length: 22 }, (_, index) => `- Never touch folder number ${index + 1} of the archive, unless the owner of folder ${index + 1} agrees.`);
  const repeats = Array.from({ length: 20 }, (_, index) => `- When I say "report ${index + 1}", write report number ${index + 1} into the log.`);
  // Every line stands twice: forty-two exact copies, which a program can prove.
  writeFileSync(path.join(local.home, '.claude', 'CLAUDE.md'), `# Rules\n\n${rules.join('\n')}\n\n## Requests\n\n${repeats.join('\n')}\n\n## Once more\n\n${rules.join('\n')}\n${repeats.join('\n')}\n`);

  const result = scan({ home: local.home, projects: [local.projects] });
  const checked = runChecks(result);
  assert.ok(checked.findings.length >= 40, `${checked.findings.length} findings`);
  assert.equal(result.files.filter((file) => file.kind === 'skill').length, 31);

  const page = parseHtml(renderStateView(buildView({ scan: result, checks: checked, lang: 'en' })));
  const visible = (element) => closedDetailsDepth(element) === 0;
  const all = (predicate) => page.elements.filter(predicate);

  const diagrams = all((element) => element.name === 'svg');
  assert.ok(diagrams.length >= 31, 'every skill with steps has its diagram in the page');
  const skillDiagrams = diagrams.filter((element) => element.ancestors.some((ancestor) => ancestor.classes.includes('skill')));
  assert.equal(skillDiagrams.length, 30);
  assert.deepEqual(skillDiagrams.filter(visible), [], 'a skill diagram is drawn outside a closed details element');
  assert.deepEqual(all((element) => element.classes.includes('skill-body')).filter(visible), [], 'a skill body is open');

  const cards = all((element) => element.classes.includes('finding-body'));
  assert.equal(cards.length, checked.findings.length, 'every finding is in the page');
  assert.ok(cards.filter(visible).length <= 5, `${cards.filter(visible).length} finding bodies are open`);
  const rows = all((element) => element.classes.includes('finding'));
  assert.ok(rows.filter(visible).length <= 15, `${rows.filter(visible).length} finding rows are visible before anything is opened`);

  // What drives the height of the page before anything is opened.
  const tall = all((element) => ['tr', 'li', 'pre', 'svg', 'article'].includes(element.name)).filter(visible);
  assert.ok(tall.length <= 120, `${tall.length} rows, items, quotes and diagrams are visible at once`);
});
