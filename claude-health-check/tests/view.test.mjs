// The view model: the one object the console and both HTML reports are drawn from.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { checksAfterReading } from './helpers/console.mjs';
import { load, materialise } from './helpers/fixtures.mjs';

const { runChecks } = await load('checks.mjs');
const { SOURCES } = await load('lib/facts.mjs');
const { assertGraph } = await load('lib/flow.mjs');
const { layoutGraph } = await load('lib/flow-svg.mjs');
const { buildView } = await load('lib/view.mjs');
const { scan } = await load('scan.mjs');

const NOW = new Date('2026-10-01T10:00:00.000Z');
const fixtures = {};
const scans = {};

before(() => {
  for (const name of ['main', 'clean', 'field', 'flows']) {
    fixtures[name] = materialise(name);
    scans[name] = scan({ home: fixtures[name].home, projects: [fixtures[name].projects], nested: name === 'field' });
  }
});
after(() => {
  for (const fixture of Object.values(fixtures)) fixture.cleanup();
});

const viewOf = (name, lang = 'en', options = {}) =>
  buildView({ scan: scans[name], checks: runChecks(scans[name], { lang, ...options }), lang, now: NOW });
const itemsOf = (view) => view.findings.bySeverity.flatMap((severity) => severity.groups.flatMap((group) => group.items));
const skillRow = (view, key, name) => view.skills.groups.find((group) => group.key === key).rows.find((row) => row.name === name);

const TOP_LEVEL = [
  'after', 'candidates', 'changes', 'contextTax', 'counts', 'factsCheckedOn', 'files', 'findings', 'generatedAt', 'generatedText', 'home', 'inventory',
  'kind', 'lang', 'limits', 'load', 'loaded', 'notes', 'numbers', 'review', 'scope', 'skills', 'title',
];

// Every key of an object and of everything inside it, as paths; arrays count as one shape.
function shapeOf(value, prefix = '') {
  if (Array.isArray(value)) return value.length ? shapeOf(value[0], `${prefix}[]`) : [];
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.keys(value).flatMap((key) => shapeOf(value[key], `${prefix}.${key}`));
}

test('the view has one shape for every setup and language, holds only plain data, and is the same for the same input', () => {
  for (const name of ['main', 'clean', 'field', 'flows']) {
    for (const lang of ['en', 'sk']) {
      const view = viewOf(name, lang);
      assert.deepEqual(Object.keys(view).sort(), TOP_LEVEL, `${name} ${lang}`);
      assert.deepEqual(JSON.parse(JSON.stringify(view)), view, `${name} ${lang}: the view holds something JSON cannot carry`);
      assert.deepEqual(viewOf(name, lang), view, `${name} ${lang}: two builds differ`);
      assert.equal(view.kind, 'state');
      assert.equal(view.after, null);
      assert.equal(view.lang, lang);
      assert.equal(view.generatedAt, NOW.toISOString());
      assert.equal(view.factsCheckedOn, '2026-10-01');
      for (const section of ['counts', 'limits', 'scope', 'loaded', 'contextTax', 'findings', 'candidates', 'review', 'skills', 'inventory', 'notes']) {
        assert.equal(typeof view[section], 'object', `${name} ${lang}: ${section}`);
      }
    }
    // The two languages differ in words only.
    assert.deepEqual(shapeOf(viewOf(name, 'sk')).sort(), shapeOf(viewOf(name, 'en')).sort(), `${name}: the Slovak view has another shape`);
  }
  assert.throws(() => buildView({ scan: scans.main, checks: runChecks(scans.main), lang: 'de' }), /Unknown language/);
});

test('counts are the counts of the checks, and nothing that is only a candidate is counted as a finding', () => {
  const view = viewOf('main');
  assert.deepEqual(view.counts, {
    files: 30,
    userFiles: 21,
    projectFiles: 9,
    memoryFiles: 12,
    memoryLines: 462,
    imports: { followed: 7, missing: 1, tooDeep: 1 },
    projects: 2,
    settings: 4,
    checks: 29,
    skills: 9,
    commands: 3,
    agents: 3,
    rules: 3,
    hooks: 4,
    findings: { high: 1, medium: 9, low: 8, total: 18 },
    candidates: { total: 15, open: 15, confirmed: 0, dismissed: 0 },
    review: 1,
    notes: 0,
    linkedSkills: 0,
    thirdPartySkills: 0,
  });
  assert.equal(itemsOf(view).length, 18);
  assert.equal(view.findings.total, 18);
  assert.deepEqual(view.scope.projects.map((project) => project.name), ['alpha-service', 'beta-tool']);
  assert.equal(view.scope.text, 'user files, 2 project(s)');

  const clean = viewOf('clean');
  assert.deepEqual(clean.counts.findings, { high: 0, medium: 0, low: 0, total: 0 });
  assert.deepEqual(clean.counts.candidates, { total: 0, open: 0, confirmed: 0, dismissed: 0 });
  assert.equal(clean.counts.review, 0);
  assert.equal(clean.findings.none, 'Nothing to change. That is a good result.');
  assert.deepEqual(itemsOf(clean), []);
  assert.deepEqual(clean.changes, { total: 0, files: [] });
  assert.deepEqual(clean.review.items, []);
});

test('the file table: every file that is loaded text, with its limit, how full it is and when it loads', () => {
  const view = viewOf('main');
  const row = (label) => view.files.find((file) => file.label === label);
  const user = row('~/.claude/CLAUDE.md');
  assert.deepEqual(
    [user.kind, user.kindLabel, user.lines, user.limit, user.percent, user.state, user.loads, user.loadsLabel],
    ['memory', 'memory', 238, 200, 119, 'over', 'launch', 'at session start'],
  );
  assert.equal(user.tokens, Math.ceil(user.bytes / 4));
  const reference = row('~/.claude/shared/reference.md');
  assert.deepEqual([reference.kind, reference.limit, reference.percent, reference.state, reference.loads], ['import', null, null, null, 'launch']);
  assert.deepEqual([row('alpha-service/packages/web/CLAUDE.md').loads, row('alpha-service/packages/web/CLAUDE.md').limit], ['on-demand', 200]);
  assert.equal(row('~/.claude/rules/deep/naming.md').kind, 'rule', 'a rule file without paths is loaded text');
  assert.equal(row('~/.claude/rules/style.md'), undefined, 'a rule file with a paths pattern is not');
  assert.equal(row('~/.claude/skills/good-skill/SKILL.md'), undefined, 'skills have their own list');

  assert.deepEqual(view.limits.memoryFileLines, { value: 200, documented: true, carried: false, source: SOURCES.memory });
  assert.deepEqual(view.limits.alwaysLoadedLines, { value: 400, documented: false, carried: false, source: null });
  // Documented, and not among the answers read on the date the report names: carried over.
  assert.deepEqual(view.limits.skillLines, { value: 500, documented: true, carried: true, source: SOURCES.skills });
  assert.deepEqual(view.limits.bytesPerToken, { value: 4, documented: false, carried: false, source: null });
  assert.equal(viewOf('main', 'en', { totalLines: 900 }).limits.alwaysLoadedLines.value, 900, 'a threshold given on the command line is the one shown');
});

test('every number carries its mark: documented with a page, carried over, or a default of this tool', () => {
  const { numbers } = viewOf('main');
  assert.equal(numbers.length, 16);
  for (const number of numbers) {
    assert.equal(typeof number.value, 'number', number.key);
    assert.ok(number.label.length > 5, number.key);
    if (number.documented) {
      assert.match(number.source, /^https:\/\/code\.claude\.com\/docs\/en\//, number.key);
      assert.equal(number.mark, number.carried ? 'documented on this page; carried over from the first version, not read again on that date' : 'documented');
    } else {
      assert.equal(number.source, null, number.key);
      assert.equal(number.mark, 'default of this tool, not from the documentation');
    }
  }
  const defaults = numbers.filter((number) => !number.documented).map((number) => number.key);
  assert.deepEqual(defaults, ['alwaysLoadedLines', 'procedureSteps', 'bytesPerToken', 'conflictPairsPerLine', 'conflictPairsPerPlace', 'flow.maxNodes', 'flow.labelChars', 'flow.minSteps']);
  assert.deepEqual(numbers.filter((number) => number.carried).map((number) => number.key), ['skillLines'], 'the one number that was not read again on that date');
  assert.deepEqual(viewOf('main', 'sk').numbers.map((number) => number.key), numbers.map((number) => number.key));
});

test('what loads at every session start, per place, with the files in loading order', () => {
  const view = viewOf('main');
  assert.deepEqual(
    view.loaded.places.map((place) => [place.key === 'user' ? 'user' : path.basename(place.key), place.label, place.lines, place.limit, place.percent, place.state]),
    [
      ['user', 'user files only', 437, 400, 109, 'over'],
      ['alpha-service', 'in alpha-service', 459, 400, 115, 'over'],
      ['beta-tool', 'in beta-tool', 443, 400, 111, 'over'],
    ],
  );
  assert.equal(view.loaded.worst, fixtures.main.project('alpha-service'));
  assert.match(view.loaded.note, /400 lines is a default of this tool/);
  const alpha = view.loaded.places[1];
  assert.deepEqual(alpha.files.slice(-4).map((file) => [file.label, file.role, file.roleLabel, file.lines]), [
    ['alpha-service/CLAUDE.md', 'memory', 'memory file', 12],
    ['alpha-service/docs/api-notes.md', 'import', 'imported', 4],
    ['alpha-service/.claude/rules/api.md', 'rule', 'rule file without paths', 3],
    ['alpha-service/CLAUDE.local.md', 'memory', 'memory file', 3],
  ]);
  assert.deepEqual(alpha.excluded, []);

  const field = viewOf('field');
  const outer = field.loaded.places.find((place) => place.label === 'in outer-app');
  assert.deepEqual(outer.excluded, [
    { path: `${fixtures.field.home}/.claude/shared/everywhere.md`, label: '~/.claude/shared/everywhere.md', lines: 12, pattern: '**/.claude/shared/everywhere.md', setting: 'outer-app/.claude/settings.json' },
  ]);
  assert.equal(viewOf('clean').loaded.places[0].state, 'ok');
});

test('the context tax per place: an estimate, its biggest contributors first, and what is not counted', () => {
  const view = viewOf('main');
  const checks = runChecks(scans.main);
  assert.equal(view.contextTax.worst, fixtures.main.project('alpha-service'));
  assert.match(view.contextTax.estimate, /bytes \/ 4: a default of this tool, not a documented number/);
  assert.equal(view.contextTax.notCounted, 'Descriptions of agents are not counted.');
  for (const place of view.contextTax.places) {
    assert.equal(place.tokens, checks.metrics.contextTokens[place.key]);
    const sorted = [...place.contributors].sort((a, b) => b.tokens - a.tokens);
    assert.deepEqual(place.contributors.map((part) => part.tokens), sorted.map((part) => part.tokens), 'the biggest contributor comes first');
    assert.equal(place.contributors.reduce((sum, part) => sum + part.tokens, 0), place.tokens);
    assert.equal(Object.values(place.stages).reduce((sum, value) => sum + value, 0), place.tokens, 'the stages add up to the total');
    for (const part of place.contributors) {
      assert.ok(part.label && part.typeLabel, JSON.stringify(part));
      assert.equal(part.share, Math.round((part.tokens / place.tokens) * 100));
    }
  }
  const alpha = view.contextTax.places.find((place) => place.label === 'in alpha-service');
  assert.deepEqual(
    alpha.contributors.slice(0, 3).map((part) => [part.label, part.type, part.share]),
    [
      ['~/.claude/CLAUDE.md', 'memory', 51],
      ['~/.claude/shared/reference.md', 'import', 39],
      ['names and descriptions of skills (8)', 'skill-listing', 7],
    ],
  );
  assert.deepEqual(Object.keys(alpha.stages), ['user', 'project', 'imports', 'rules', 'autoMemory', 'listing']);
  assert.equal(alpha.stages.user, 3594);
  assert.equal(alpha.stages.autoMemory, 0);
  assert.equal(alpha.autoMemory.found, false);
  assert.equal(view.contextTax.places.find((place) => place.key === 'user').autoMemory, null);
  assert.match(viewOf('main', 'sk').contextTax.places[1].contributors[2].label, /názvy a popisy skillov \(8\)/);
});

test('how the setup loads: one graph per place, the costliest first, with the size of each step on its node', () => {
  const view = viewOf('main');
  assert.deepEqual(view.load.map((place) => place.label), ['in alpha-service', 'in beta-tool', 'user files only']);
  const [alpha, beta, user] = view.load;
  assert.deepEqual(
    alpha.graph.nodes.map((node) => [node.id, node.kind, node.label]),
    [
      ['start', 'start', 'Session start'],
      ['userMemory', 'step', 'User memory · 238 lines'],
      ['userRules', 'step', 'User rule files (1) · 3 lines'],
      ['projectMemory', 'step', 'Project memory · 12 lines'],
      ['projectRules', 'step', 'Project rule files (1) · 3 lines'],
      ['localMemory', 'step', 'Local memory · 3 lines'],
      ['imports', 'step', 'Imported files (7) · 200 lines'],
      ['listing', 'step', 'Skill and command listing (11) · ≈ 542 tokens'],
      // The number is written as every other place writes it.
      ['total', 'step', `In context: ≈ ${view.contextTax.places[1].tokens.toLocaleString('en-US')} tokens`],
      ['end', 'end', 'Your first word'],
      ['later', 'note', 'On demand: 1 nested files, 1 scoped rules, skill bodies'],
    ],
  );
  assert.deepEqual(alpha.graph.edges.at(-1), { from: 'end', to: 'later', label: 'later' });
  assert.equal(alpha.graph.edges.length, alpha.graph.nodes.length - 1, 'one chain, in loading order');
  assert.deepEqual(user.graph.nodes.map((node) => node.id), ['start', 'userMemory', 'userRules', 'imports', 'listing', 'total', 'end', 'later']);
  assert.ok(!beta.graph.nodes.some((node) => node.id === 'localMemory'), 'a step with nothing in it is not drawn');
  for (const place of view.load) {
    assertGraph(place.graph);
    layoutGraph(place.graph);
    assert.match(place.mermaid, /^flowchart TD\n {2}n1\(\["Session start"\]\)\n/);
    assert.match(place.title, /^How the setup loads /);
  }
  const lines = alpha.graph.nodes.filter((node) => / lines$/.test(node.label)).reduce((sum, node) => sum + Number(/(\d+) lines$/.exec(node.label)[1]), 0);
  assert.equal(lines, 459, 'the lines on the nodes are the lines that load');
  // A label that needs two lines keeps the number with its unit: no word is left alone at the end.
  const drawn = Object.fromEntries(layoutGraph(alpha.graph).nodes.map((node) => [node.id, node.lines]));
  assert.deepEqual(drawn.userMemory, ['User memory · 238 lines']);
  assert.deepEqual(drawn.userRules, ['User rule files (1) ·', '3 lines']);
  assert.deepEqual(drawn.imports, ['Imported files (7) ·', '200 lines']);
  // A word that was cut because it is longer than a line is never glued to another word.
  const cut = layoutGraph({ nodes: [{ id: 'a', label: `see ${'x'.repeat(30)}`, kind: 'step' }], edges: [] }).nodes[0].lines;
  assert.deepEqual(cut, ['see', 'x'.repeat(24), 'x'.repeat(6)]);
  assert.equal(viewOf('main', 'sk').load[0].graph.nodes[0].label, 'Začiatok session');

  // Every label of these diagrams is written to fit its box: none is cut short, in either language.
  for (const name of ['main', 'clean', 'field', 'flows']) {
    for (const lang of ['en', 'sk']) {
      for (const place of viewOf(name, lang).load) {
        for (const node of layoutGraph(place.graph).nodes) {
          assert.ok(!node.lines.some((line) => line.endsWith('…')), `${name} ${lang} ${place.label}: "${node.lines.join(' / ')}" is cut`);
        }
      }
    }
  }

  // Where an AGENTS.md stands in for the memory file, and where a setting excludes a file.
  const field = viewOf('field');
  const lonely = field.load.find((place) => place.label === 'in agents-only');
  assert.ok(lonely.graph.nodes.some((node) => node.id === 'agentsMd' && node.label === 'AGENTS.md · 4 lines'));
});

test('findings are grouped by severity and kind; each item says where it is, also when it has no line', () => {
  const view = viewOf('main');
  assert.deepEqual(view.findings.bySeverity.map((severity) => [severity.severity, severity.label, severity.count, severity.groups.length]), [
    ['high', 'High', 1, 1],
    ['medium', 'Medium', 9, 9],
    ['low', 'Low', 8, 8],
  ]);
  const low = view.findings.bySeverity[2];
  const duplicates = low.groups.find((group) => group.check === 'duplicate-within');
  assert.deepEqual([duplicates.key, duplicates.title, duplicates.count], ['duplicate-within', 'Instruction repeated in one file', 1]);
  assert.deepEqual(duplicates.items.map((item) => item.where), ['~/.claude/CLAUDE.md:10']);
  const [first] = duplicates.items;
  assert.deepEqual(Object.keys(first).sort(), [
    'check', 'data', 'endLine', 'error', 'file', 'id', 'label', 'line', 'message', 'quote', 'related', 'severity', 'severityLabel', 'status', 'suggestion', 'title', 'where', 'why',
  ]);
  assert.deepEqual(first.suggestion, { kind: 'delete-duplicate', label: 'Delete the duplicate', detail: 'Delete this copy.' });

  // What a reader confirmed is grouped by the title the reader gave it, with the findings of its severity.
  const judged = buildView({ scan: scans.main, checks: checksAfterReading(scans.main, { exception: 'low', 'permission-in-prose': 'medium' }), lang: 'en', now: NOW });
  const exceptions = judged.findings.bySeverity[2].groups.find((group) => group.key === 'judgement:exception');
  assert.deepEqual([exceptions.check, exceptions.title, exceptions.count], ['judgement', 'exception', 4]);
  assert.deepEqual(exceptions.items.map((item) => item.where), ['~/.claude/CLAUDE.md:13', '~/.claude/CLAUDE.md:14', '~/.claude/CLAUDE.md:15', '~/.claude/CLAUDE.md:24']);
  assert.deepEqual(judged.counts.findings, { high: 1, medium: 10, low: 12, total: 23 });
  assert.deepEqual(judged.counts.candidates, { total: 15, open: 10, confirmed: 5, dismissed: 0 });
  const rule = judged.findings.bySeverity[1].groups.find((group) => group.key === 'judgement:permission-in-prose').items[0];
  assert.deepEqual(rule.data, { command: 'git push --force', list: 'deny', rule: 'Bash(git push --force *)' }, 'a confirmed candidate keeps what its check read from the line');

  for (const item of itemsOf(view)) {
    assert.equal(item.where, item.line === null ? item.label : `${item.label}:${item.line}`);
    assert.ok(!/null|undefined/.test(item.where), item.where);
    assert.equal(item.status, null);
  }
  const total = itemsOf(view).find((item) => item.check === 'always-loaded-total');
  assert.deepEqual([total.line, total.quote, total.where], [null, null, '~/.claude/CLAUDE.md']);
  const invalid = itemsOf(view).find((item) => item.check === 'settings-invalid-json');
  assert.match(invalid.error, /^(parse error at position|the parser reported no position)/, 'the position of the parser message and nothing else of it');
  const duplicate = itemsOf(view).find((item) => item.check === 'duplicate-across');
  assert.deepEqual(duplicate.related, [{ where: '~/.claude/CLAUDE.md:11', quote: '- Write commit messages in the imperative mood.' }]);

  // The suggested changes are listed file by file; summed up by kind they are every finding once.
  const kinds = new Map();
  for (const file of view.changes.files) for (const entry of file.byKind) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + entry.count);
  assert.deepEqual([...kinds].sort(), [
    ['delete-duplicate', 3],
    ['fix-front-matter', 6],
    ['make-rule-file', 1],
    ['make-setting', 3],
    ['move-to-user', 1],
    ['shorten', 4],
  ]);
  assert.deepEqual(view.changes.files.flatMap((file) => file.items.map((item) => item.id)).sort(), itemsOf(view).map((item) => item.id).sort());
});

test('candidates and review items are lists of their own, with one sentence for a screen that shows no more', () => {
  const view = viewOf('main');
  assert.equal(view.candidates.total, 15);
  assert.equal(view.candidates.sentence, 'Candidates found by words only: 15. Claude reads them next.');
  assert.deepEqual(view.candidates.groups.map((group) => [group.check, group.title, group.count]), [
    ['conflict-candidate', 'Pairs of lines that may contradict each other', 1],
    ['exception', 'Lines that may be rules with an exception', 4],
    ['procedure-in-memory', 'Numbered blocks that may be procedures', 1],
    ['repeated-request', 'Lines that may map a phrase to a fixed action', 1],
    ['automation-in-memory', 'Lines that may describe a hook', 3],
    ['permission-in-prose', 'Lines that may restrict a command in prose only', 1],
    ['project-specific-in-user', 'User-file lines that may be about one project', 3],
    ['skill-no-when-cue', 'Skill descriptions that may not say when to use the skill', 1],
  ]);
  const [pair] = view.candidates.groups[0].items;
  assert.deepEqual([pair.where, pair.status, pair.statusLabel, pair.reason, pair.finding], ['alpha-service/CLAUDE.md:7', 'open', 'not read yet', null, null]);
  assert.deepEqual(pair.related, [{ where: '~/.claude/CLAUDE.md:7', quote: '- Always use tabs for indentation in TypeScript files.' }]);
  assert.equal(view.candidates.groups[4].items[0].command, 'npm test');
  assert.deepEqual(view.candidates.conflictPairs, { found: 1, compared: 0, confirmed: 0, leftOut: 0, text: 'Pairs found by shared words: 1. None compared yet.' });
  const candidateIds = new Set(view.candidates.groups.flatMap((group) => group.items.map((item) => item.id)));
  assert.ok(itemsOf(view).every((item) => !candidateIds.has(item.id)), 'a candidate is listed among the findings');
  assert.equal(viewOf('main', 'sk').candidates.sentence, 'Kandidáti nájdení len podľa slov: 15. Claude ich prečíta v ďalšom kroku.');

  assert.equal(view.review.note, 'Nothing here needs to change. These are yours to look at and decide.');
  assert.deepEqual(
    view.review.items.map((item) => [item.check, item.title, item.where, item.projectLabel, item.servers]),
    [['mcp-no-permission-rule', 'MCP servers without a permission rule', 'alpha-service/.mcp.json', 'alpha-service', ['tracker', 'search']]],
  );
  for (const item of view.review.items) assert.equal('severity' in item, false);
});

test('skills are grouped: the user skills first, then one group per project headed by its full path', () => {
  const view = viewOf('main');
  const alphaPath = fixtures.main.project('alpha-service');
  const betaPath = fixtures.main.project('beta-tool');
  assert.deepEqual(
    view.skills.groups.map((group) => [group.key, group.scope, group.title, group.count, group.empty]),
    [
      ['user', 'user', 'User skills', 8, false],
      [alphaPath, 'project', alphaPath, 1, false],
      [betaPath, 'project', betaPath, 0, true],
    ],
  );
  assert.equal(view.skills.groups[0].folderLabel, '~/.claude/skills');
  assert.equal(view.skills.groups[2].emptyText, 'No skills in this project.');
  assert.equal(view.skills.total, 9);
  assert.deepEqual(view.skills.limit, { value: 500, documented: true, carried: true, source: SOURCES.skills });
  assert.deepEqual(view.skills.groups.map((group) => group.label), [null, 'alpha-service', 'beta-tool']);
  assert.deepEqual(view.skills.groups[0].rows.map((row) => row.name), [
    'good-skill', 'long-skill', 'no-description', 'shared-skill', 'unreachable-skill', 'vague-skill', 'wordy-skill', 'wrong-name',
  ]);

  const long = skillRow(view, 'user', 'long-skill');
  assert.deepEqual([long.lines, long.limit, long.percent, long.state, long.linked, long.listed], [512, 500, 102, 'over', false, true]);
  assert.deepEqual(long.notes, [{ key: 'skill-too-long', text: 'over the recommended length' }]);
  assert.equal(long.findings.length, 1);
  assert.deepEqual(skillRow(view, 'user', 'wordy-skill').description, { chars: 1783, limit: 1536, over: true });
  assert.deepEqual(skillRow(view, 'user', 'wordy-skill').notes, [{ key: 'skill-description-too-long', text: 'description 1783 of 1536 characters' }]);
  assert.deepEqual(skillRow(view, 'user', 'wrong-name').notes, [{ key: 'skill-name-mismatch', text: 'front matter name is "other-name"' }]);
  assert.equal(skillRow(view, 'user', 'unreachable-skill').listed, false);
  assert.deepEqual(skillRow(view, 'user', 'good-skill').notes, []);

  // The same skill in the user folder and in a project: both rows say so, and say whether the texts still agree.
  const userCopy = skillRow(view, 'user', 'shared-skill');
  const projectCopy = skillRow(view, alphaPath, 'shared-skill');
  assert.deepEqual(userCopy.twins.map((twin) => [twin.relation, twin.where, twin.label]), [['differs', 'alpha-service', 'alpha-service/.claude/skills/shared-skill/SKILL.md']]);
  assert.deepEqual(projectCopy.twins.map((twin) => [twin.relation, twin.where]), [['differs', 'the user skills']]);
  assert.deepEqual(userCopy.notes, [{ key: 'twin-differs', text: 'differs from the copy in alpha-service' }]);
  assert.equal(view.skills.thirdPartyText, 'Third-party skills: none found.');
});

test('skills of nested repositories are their own groups; third-party skills carry their mark and no suggestion', () => {
  const view = viewOf('field');
  const outer = fixtures.field.project('outer-app');
  assert.deepEqual(
    view.skills.groups.map((group) => [group.scope === 'user' ? 'user' : group.title.slice(fixtures.field.projects.length + 1), group.count, group.nestedIn === null ? null : path.basename(group.nestedIn)]),
    [
      ['user', 3, null],
      ['agents-only', 0, null],
      ['outer-app', 1, null],
      ['outer-app/clones/inner-kit', 1, 'outer-app'],
      ['outer-app/clones/worktree-kit', 0, 'outer-app'],
    ],
  );
  assert.equal(view.skills.groups[3].note, `A repository nested in ${outer}; it is a project of its own.`);
  assert.equal(view.skills.groups[1].note, null);
  assert.deepEqual(view.scope.nested, { found: 3, withSetup: 2, included: 2 });
  assert.equal(view.scope.text, 'user files, 4 project(s), 2 nested repositories included');
  assert.deepEqual(view.inventory.nested.map((repository) => [repository.name, repository.state]), [
    ['inner-kit', 'included'],
    ['plain-repo', 'no-setup'],
    ['worktree-kit', 'included'],
  ]);
  assert.equal(view.inventory.nestedHint, null);

  const vendor = skillRow(view, 'user', 'vendor-skill');
  assert.deepEqual(vendor.thirdParty, {
    reasons: ['license-file'],
    text: 'third-party · do not edit',
    because: ['Third-party because its folder holds a licence file.'],
  });
  assert.deepEqual(vendor.notes.map((note) => note.key), ['third-party', 'skill-no-when-cue']);
  assert.deepEqual(vendor.findings, [], 'what would be a suggestion on a third-party skill is a note');
  const authored = skillRow(view, 'user', 'authored-skill');
  assert.deepEqual(authored.thirdParty.because, ['Third-party because its front matter has "author".']);
  assert.deepEqual(authored.notes.map((note) => note.key), ['third-party', 'skill-name-mismatch', 'skill-no-when-cue']);
  assert.equal(skillRow(view, 'user', 'own-skill').thirdParty, null);
  assert.equal(view.counts.thirdPartySkills, 2);
  assert.match(view.skills.thirdPartyText, /suggests no edit/);
  // Copies that still agree are not a finding; both rows say so.
  assert.deepEqual(skillRow(view, 'user', 'own-skill').notes, [{ key: 'twin-same', text: 'same as the copy in outer-app' }]);
  assert.deepEqual(skillRow(view, outer, 'own-skill').notes, [{ key: 'twin-same', text: 'same as the copy in the user skills' }]);

  // Without the nested repositories: they are named, and the view says how to include them.
  const plain = scan({ home: fixtures.field.home, projects: [fixtures.field.projects] });
  const left = buildView({ scan: plain, checks: runChecks(plain), lang: 'en', now: NOW });
  assert.deepEqual(left.skills.groups.map((group) => group.count), [3, 0, 1]);
  assert.deepEqual(left.scope.nested, { found: 3, withSetup: 2, included: 0 });
  assert.deepEqual(left.inventory.nested.map((repository) => repository.state), ['left-out', 'no-setup', 'left-out']);
  assert.match(left.inventory.nestedHint, /--nested/);
});

test('each skill has the graph of its steps, or says that it has no recognisable steps', () => {
  const view = viewOf('flows');
  const sample = fixtures.flows.project('sample-app');
  const flow = (key, name) => skillRow(view, key, name).flow;

  const linear = flow('user', 'changelog-notes');
  assert.deepEqual([linear.source, linear.steps, linear.capped, linear.text], ['list', 6, 0, null]);
  assert.deepEqual(linear.graph.nodes.map((node) => node.id), ['start', 's1', 's2', 's3', 's4', 's5', 's6', 'end']);
  assert.match(linear.mermaid, /^flowchart TD\n {2}n1\(\["Start"\]\)\n {2}n2\["Find the tag of the last version/);
  assertGraph(linear.graph);

  const branching = flow('user', 'image-resize');
  assert.equal(branching.source, 'list');
  assert.ok(branching.graph.nodes.some((node) => node.kind === 'decision'));
  assert.ok(branching.graph.edges.some((edge) => edge.label === 'yes') && branching.graph.edges.some((edge) => edge.label === 'no'));
  assert.equal(flow('user', 'data-import').source, 'headings');
  assert.equal(flow(sample, 'seed-data').source, 'headings');

  const none = flow('user', 'style-notes');
  assert.deepEqual(none, {
    source: 'none',
    steps: 0,
    capped: 0,
    graph: null,
    mermaid: '',
    text: 'No recognisable steps: this skill has no numbered list and no "Step N" headings, so no diagram is drawn.',
  });

  // The words drawn into a diagram follow the language of the view.
  const slovak = skillRow(viewOf('flows', 'sk'), 'user', 'image-resize').flow.graph;
  assert.deepEqual([slovak.nodes[0].label, slovak.nodes.at(-1).label], ['Začiatok', 'Koniec']);
  assert.ok(slovak.edges.some((edge) => edge.label === 'áno') && slovak.edges.some((edge) => edge.label === 'nie'));

  // Every skill of every fixture gets one of the two.
  for (const name of ['main', 'clean', 'field', 'flows']) {
    for (const row of viewOf(name).skills.groups.flatMap((group) => group.rows)) {
      assert.ok(['list', 'headings', 'none'].includes(row.flow.source), `${name} ${row.name}`);
      assert.equal(row.flow.graph === null, row.flow.source === 'none');
      assert.equal(row.flow.text === null, row.flow.source !== 'none');
    }
  }
});

test('a linked skill folder is a row with its name and nothing read from it', (t) => {
  const local = materialise('flows');
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
  const view = buildView({ scan: result, checks: runChecks(result), lang: 'en', now: NOW });
  const row = view.skills.groups[0].rows.find((entry) => entry.name === 'borrowed-skill');
  assert.deepEqual(
    [row.linked, row.lines, row.flow, row.description, row.notes, row.thirdParty.reasons],
    [true, null, null, null, [{ key: 'linked', text: 'linked, not read' }], ['linked']],
  );
  assert.equal(view.counts.linkedSkills, 1);
  assert.equal(view.skills.total, 7);
  assert.ok(!JSON.stringify(view).includes('LINKED-'), 'text of the linked skill reached the view');
});

test('a skill file that disappears between the scan and the view is said to be unreadable, not drawn from memory', (t) => {
  const local = materialise('flows');
  t.after(() => local.cleanup());
  const result = scan({ home: local.home, projects: [local.projects] });
  const checks = runChecks(result);
  const moved = result.files.find((file) => file.kind === 'skill' && file.name === 'changelog-notes');
  const view = buildView({ scan: { ...result, files: result.files.map((file) => (file === moved ? { ...file, path: `${file.path}.gone` } : file)) }, checks, lang: 'en', now: NOW });
  const row = view.skills.groups[0].rows.find((entry) => entry.name === 'changelog-notes');
  assert.deepEqual([row.flow.source, row.flow.graph, row.flow.text], ['unreadable', null, 'The file could not be read again, so no diagram is drawn.']);
});

// A setup with two applied changes and one skipped, as the wizard would leave it. The reading
// confirmed the numbered block and the prohibition, so both were changes to decide on.
function changedSetup(t) {
  const local = materialise('main');
  t.after(() => local.cleanup());
  const scanBefore = scan({ home: local.home, projects: [local.projects] });
  const checksBefore = checksAfterReading(scanBefore, { 'procedure-in-memory': 'medium', 'permission-in-prose': 'medium' });
  const find = (check) => checksBefore.findings.find((finding) => (finding.origin ?? finding.check) === check);
  const memory = path.join(local.home, '.claude', 'CLAUDE.md');
  const lines = readFileSync(memory, 'utf8').split('\n');
  lines.splice(28, 5); // the release procedure, lines 29-33
  lines.splice(9, 1); // the duplicated line 10
  writeFileSync(memory, lines.join('\n'));
  const skill = `${local.home}/.claude/skills/release/SKILL.md`;
  mkdirSync(path.dirname(skill), { recursive: true });
  writeFileSync(skill, '---\nname: release\ndescription: Cuts a release. Use when the user asks to release.\n---\n\n1. Run the tests.\n2. If a test fails, stop.\n3. Tag the commit.\n');
  const backup = `${local.home}/.claude/health-check/backup-20260101-120000`;
  const applied = [
    { id: find('procedure-in-memory').id, kind: 'make-skill', status: 'applied', files: [memory.replace(/\\/g, '/'), skill], created: [{ type: 'skill', path: skill }], backup, note: null, at: '2026-01-01T12:00:00.000Z' },
    { id: find('duplicate-within').id, kind: 'delete-duplicate', status: 'applied', files: [memory.replace(/\\/g, '/')], created: [], backup, note: null, at: '2026-01-01T12:01:00.000Z' },
    { id: find('permission-in-prose').id, kind: 'make-setting', status: 'skipped', files: [], created: [], backup: null, note: null, at: '2026-01-01T12:02:00.000Z' },
  ];
  const scanAfter = scan({ home: local.home, projects: [local.projects] });
  // The prohibition is still there, and what the reading said of it still holds.
  return { local, checksBefore, scanAfter, checksAfter: checksAfterReading(scanAfter, { 'permission-in-prose': 'medium' }), applied, backup, find };
}

test('after the changes: before and after, where each entry went, and the steps of what was created', (t) => {
  const { checksBefore, scanAfter, checksAfter, applied, backup, find } = changedSetup(t);
  const view = buildView({ scan: scanAfter, checks: checksAfter, before: checksBefore, applied, lang: 'en', now: NOW });
  assert.equal(view.kind, 'after');
  assert.equal(view.title, 'Claude Code setup: after the changes');
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  const { after: result } = view;
  assert.deepEqual(Object.keys(result).sort(), ['applied', 'byHand', 'created', 'createdSkills', 'files', 'lines', 'loaded', 'moved', 'next', 'open', 'skipped', 'tax', 'totals', 'undo']);

  // File by file: what was applied, what was skipped and what is still open, in the order of the walk.
  const [memory, ...others] = result.files;
  assert.deepEqual([memory.label, memory.k, memory.of, memory.linesBefore, memory.lines], ['~/.claude/CLAUDE.md', 1, result.files.length, 238, 232]);
  assert.deepEqual(memory.applied.map((entry) => [entry.kindLabel, entry.where]), [
    ['Delete the duplicate', '~/.claude/CLAUDE.md:10'],
    ['Turn into a skill', '~/.claude/CLAUDE.md:29'],
  ]);
  assert.deepEqual(memory.skipped.map((entry) => [entry.kind, entry.where, entry.finding.check, entry.finding.title]), [['make-setting', '~/.claude/CLAUDE.md:22', 'judgement', 'permission-in-prose']]);
  assert.deepEqual(memory.byHand, []);
  assert.equal(memory.open.length, checksAfter.findings.filter((finding) => finding.file === memory.path).length);
  assert.deepEqual(memory.open.map((item) => item.line), [...memory.open.map((item) => item.line)].sort((a, b) => (a ?? 0) - (b ?? 0)), 'what is open is listed from the top of the file down');
  assert.ok(others.every((file) => file.applied.length === 0 && file.skipped.length === 0 && file.open.length > 0));
  assert.equal(result.files.reduce((sum, file) => sum + file.open.length, 0), checksAfter.findings.length);

  assert.deepEqual(result.totals.memoryLines, { before: 462, after: 456 });
  assert.deepEqual(result.totals.loadedLines, { before: 459, after: 453 });
  assert.deepEqual([result.totals.applied, result.totals.byHand, result.totals.skipped], [2, 0, 1]);
  assert.deepEqual(result.totals.skills, { before: 9, after: 10 });
  assert.ok(result.totals.tokens.after < result.totals.tokens.before, 'removing lines from the user file lowers the tax');
  assert.equal(result.totals.findings.after, result.totals.findings.before - 2);
  assert.deepEqual(result.lines[0], { path: `${scanAfter.home}/.claude/CLAUDE.md`, label: '~/.claude/CLAUDE.md', before: 238, after: 232, diff: -6, status: null, statusLabel: null });
  assert.deepEqual(result.loaded.map((place) => [place.before, place.lines, place.diff]), [
    [437, 431, -6],
    [459, 453, -6],
    [443, 437, -6],
  ]);
  assert.ok(result.tax.every((place) => place.diff < 0 && place.after === place.before + place.diff));

  // One arrow per applied change, from the line of report 1 to what it became.
  assert.deepEqual(result.moved.entries.map((entry) => [entry.from, entry.to, entry.type, entry.kind]), [
    ['~/.claude/CLAUDE.md:29', '~/.claude/skills/release/SKILL.md', 'Skill', 'make-skill'],
    ['~/.claude/CLAUDE.md:10', 'Duplicate deleted', null, 'delete-duplicate'],
  ]);
  assert.deepEqual(result.moved.graph.nodes, [
    { id: 'e1', label: 'line 29 of ~/.claude/CLAUDE.md', kind: 'step' },
    { id: 't1', label: '~/.claude/skills/release/SKILL.md', kind: 'step' },
    { id: 'e2', label: 'line 10 of ~/.claude/CLAUDE.md', kind: 'step' },
    { id: 't2', label: 'Duplicate deleted', kind: 'note' },
  ]);
  assert.deepEqual(result.moved.graph.edges, [
    { from: 'e1', to: 't1', label: 'Skill' },
    { from: 'e2', to: 't2' },
  ]);
  assert.match(result.moved.mermaid, /^flowchart TD\n/);
  layoutGraph(result.moved.graph);

  assert.deepEqual(result.created, [{ type: 'skill', typeLabel: 'Skill', path: `${scanAfter.home}/.claude/skills/release/SKILL.md`, label: '~/.claude/skills/release/SKILL.md', lines: 8 }]);
  assert.deepEqual(result.createdSkills.map((row) => [row.name, row.flow.source, row.flow.steps]), [['release', 'list', 4]]);
  assert.deepEqual(result.applied.map((entry) => [entry.kindLabel, entry.files.length]), [
    ['Turn into a skill', 2],
    ['Delete the duplicate', 1],
  ]);
  assert.match(result.applied[0].message, /numbered block of 5 items/);
  assert.deepEqual(result.skipped.map((entry) => [entry.kind, entry.finding.check, entry.finding.where]), [['make-setting', 'judgement', '~/.claude/CLAUDE.md:22']]);
  const open = result.open.bySeverity.flatMap((severity) => severity.groups.flatMap((group) => group.items));
  assert.equal(open.length, checksAfter.findings.length);
  assert.ok(open.every((item) => item.status.key === 'remains' && item.status.label === 'was there before'));
  assert.deepEqual(result.undo, { text: result.undo.text, backups: [backup], unbacked: null, none: null });
  assert.match(result.undo.text, /copied to the backup folder/);
  assert.ok(result.next.some((line) => /still has 232 lines/.test(line)) && result.next.some((line) => /1 suggested change\(s\) were skipped/.test(line)));
  assert.ok(!result.next.some((line) => /deny/i.test(line)), 'the view gives no opinion on permission rules that are not there');

  // Changes of one kind that create nothing share one box; a change with no finding behind it still has a source.
  const more = [...applied.slice(0, 2), { id: 'unknown-id', kind: 'delete-duplicate', status: 'applied', files: [`${scanAfter.home}/.claude/CLAUDE.md`], created: [], backup: null, note: null }];
  const again = buildView({ scan: scanAfter, checks: checksAfter, before: checksBefore, applied: more, lang: 'en', now: NOW }).after;
  assert.deepEqual(again.moved.graph.edges.map((edge) => [edge.from, edge.to]), [['e1', 't1'], ['e2', 't2'], ['e3', 't2']]);
  assert.equal(again.moved.graph.nodes.find((node) => node.id === 'e3').label, '~/.claude/CLAUDE.md');
  assert.match(again.undo.unbacked, /1 change\(s\) were recorded without a backup folder/);

  // A change the person made by hand is not a change this tool applied: it is not counted as
  // applied, it moved nothing and created nothing, and no kind of change is said to have happened.
  const settings = `${scanAfter.home}/.claude/settings.json`;
  const hand = [
    { id: find('hook-missing-file').id, kind: 'make-setting', status: 'by-hand', files: [settings], created: [], backup, note: null },
    { id: find('skill-copies-differ').id, kind: 'delete-duplicate', status: 'by-hand', files: [find('skill-copies-differ').file], created: [], backup: null, note: null },
  ];
  const byHand = buildView({ scan: scanAfter, checks: checksAfter, before: checksBefore, applied: hand, lang: 'en', now: NOW }).after;
  assert.deepEqual([byHand.totals.applied, byHand.totals.byHand, byHand.totals.skipped], [0, 2, 0]);
  assert.deepEqual([byHand.moved.entries, byHand.moved.graph, byHand.created, byHand.applied], [[], null, [], []], 'a change made by hand was drawn or listed as one the tool made');
  assert.deepEqual(byHand.byHand.map((entry) => [entry.kindLabel, entry.files]), [['Change settings', ['~/.claude/settings.json']], ['Delete the duplicate', ['alpha-service/.claude/skills/shared-skill/SKILL.md']]]);
  const settingsFile = byHand.files.find((entry) => entry.path === settings);
  assert.deepEqual([settingsFile.applied.length, settingsFile.byHand.length, settingsFile.skipped.length], [0, 1, 0]);
  assert.ok(!JSON.stringify(byHand).includes('Duplicate deleted') && !JSON.stringify(byHand).includes('Settings changed'), 'the view says the tool did something it did not do');
  // The copy that was taken before the person edited is named; the edit without a copy is said to have none.
  assert.deepEqual([byHand.undo.backups, byHand.undo.none], [[backup], null]);
  assert.match(byHand.undo.unbacked, /1 change\(s\) were recorded without a backup folder/);

  // Nothing applied: no diagram, and the view says why.
  const stopped = buildView({ scan: scanAfter, checks: checksAfter, before: checksAfter, applied: [], lang: 'en', now: NOW }).after;
  assert.deepEqual([stopped.moved.graph, stopped.moved.mermaid, stopped.moved.entries], [null, '', []]);
  assert.equal(stopped.undo.none, 'No change was applied, so there is nothing to undo.');
  assert.deepEqual(stopped.createdSkills, []);
});
