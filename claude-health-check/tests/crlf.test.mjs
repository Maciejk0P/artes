// A checkout with line-ending conversion gives every Markdown and JSON file CRLF endings. The
// files are built here at run time (the fixtures in the repository are LF), and the tool has to
// see the same setup either way and leave the endings as it found them.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { load, materialise, toCrlf } from './helpers/fixtures.mjs';

const { appendLines, mergeSettings, removeLines, replaceLines, shaOf, writeNew } = await load('apply.mjs');
const { runChecks } = await load('checks.mjs');
const { buildView } = await load('lib/view.mjs');
const { renderStateView } = await load('report.mjs');
const { scan } = await load('scan.mjs');

const NOW = new Date('2026-10-01T10:00:00.000Z');
const LONE_LF = /(?<!\r)\n/;

function pair(t, name, options = {}) {
  const lf = materialise(name);
  const crlf = materialise(name);
  t.after(() => {
    lf.cleanup();
    crlf.cleanup();
  });
  assert.ok(toCrlf(crlf.root) >= 5, 'no file was rewritten, so this test would prove nothing');
  const run = (fx) => {
    const result = scan({ home: fx.home, projects: [fx.projects], ...options });
    return { fx, scan: result, checks: runChecks(result) };
  };
  return { lf: run(lf), crlf: run(crlf) };
}

// The same value with the temp folder of the fixture taken out, so two copies can be compared.
const without = (value, fx) => JSON.parse(JSON.stringify(value).split(fx.root).join('ROOT'));

for (const [name, options] of [
  ['main', {}],
  ['field', { nested: true }],
  ['flows', {}],
]) {
  test(`CRLF: the ${name} fixture gives the same scan, checks and view as with LF`, (t) => {
    const { lf, crlf } = pair(t, name, options);
    for (const file of crlf.scan.files) {
      const text = readFileSync(file.path, 'utf8');
      assert.ok(text.includes('\r\n') && !LONE_LF.test(text), `${file.path} of the copy under test is not a CRLF file`);
    }

    // The scan differs in bytes and in nothing else: every line has one more byte.
    const shape = (result, fx) =>
      without(
        result.files.map(({ bytes, approxTokens, ...file }) => file),
        fx,
      );
    assert.deepEqual(shape(crlf.scan, crlf.fx), shape(lf.scan, lf.fx));
    for (const [index, file] of crlf.scan.files.entries()) {
      assert.equal(file.bytes, lf.scan.files[index].bytes + file.lines, `${file.path}: bytes`);
    }
    assert.deepEqual(without(crlf.scan.settings.map(({ bytes, ...entry }) => entry), crlf.fx), without(lf.scan.settings.map(({ bytes, ...entry }) => entry), lf.fx));
    assert.deepEqual(without(crlf.scan.nestedRepositories, crlf.fx), without(lf.scan.nestedRepositories, lf.fx));

    // Findings, candidates, notes and review items are the same, id for id and quote for quote.
    for (const list of ['findings', 'candidates', 'review', 'notes']) {
      assert.deepEqual(without(crlf.checks[list], crlf.fx), without(lf.checks[list], lf.fx), list);
    }
    for (const entry of [...crlf.checks.findings, ...crlf.checks.candidates]) {
      assert.ok(!/\r/.test(JSON.stringify([entry.quote, entry.related ?? null])), `${entry.id} quotes a carriage return`);
    }
    assert.deepEqual(crlf.checks.metrics.findings, lf.checks.metrics.findings);
    assert.deepEqual(Object.values(crlf.checks.metrics.alwaysLoadedLines), Object.values(lf.checks.metrics.alwaysLoadedLines));

    // The view draws the same steps for every skill, and the page has no carriage return in a quote.
    const flowsOf = (view) => view.skills.groups.flatMap((group) => group.rows.map((row) => [row.name, row.lines, row.flow?.mermaid ?? null]));
    const viewLf = buildView({ scan: lf.scan, checks: lf.checks, lang: 'en', now: NOW });
    const viewCrlf = buildView({ scan: crlf.scan, checks: crlf.checks, lang: 'en', now: NOW });
    assert.deepEqual(flowsOf(viewCrlf), flowsOf(viewLf));
    assert.deepEqual(viewCrlf.counts, viewLf.counts);
    assert.ok(!renderStateView(viewCrlf).includes('\r'), 'a carriage return reached the report');
  });
}

test('CRLF: a judgement finding is accepted with the text of the line, without its line ending', (t) => {
  const { crlf } = pair(t, 'main');
  const file = `${crlf.fx.home}/.claude/CLAUDE.md`;
  const entry = { title: 'Vague', severity: 'low', file, line: 9, quote: '- Prefer small functions over long ones.', message: 'm', why: 'w', kind: 'shorten', detail: 'd' };
  const judged = runChecks(crlf.scan, { judgement: [entry] });
  assert.equal(judged.findings.filter((finding) => finding.check === 'judgement').length, 1);
  assert.throws(() => runChecks(crlf.scan, { judgement: [{ ...entry, quote: `${entry.quote}\r` }] }), /no quote, no finding/);
});

test('CRLF: line edits keep every line ending as it was', (t) => {
  const { crlf } = pair(t, 'main');
  const { fx, checks } = crlf;
  const memory = `${fx.home}/.claude/CLAUDE.md`;
  const where = { home: fx.home, projects: [fx.project('alpha-service')], backup: `${fx.home}/.claude/health-check/backup-crlf` };
  const read = () => readFileSync(memory, 'utf8');
  const original = read();
  const lines = () => read().split('\r\n');

  // The hash of a finding is the hash of what the person was shown: the text, without line endings.
  const duplicate = checks.findings.find((finding) => finding.check === 'duplicate-within');
  assert.equal(shaOf({ file: memory, from: duplicate.line, to: duplicate.endLine }).sha, duplicate.quoteSha);
  const procedure = checks.candidates.find((candidate) => candidate.check === 'procedure-in-memory');
  assert.equal(shaOf({ file: memory, from: procedure.line, to: procedure.endLine }).sha, procedure.quoteSha, 'a quote of several lines');

  removeLines({ ...where, file: memory, from: procedure.line, to: procedure.endLine, expectSha: procedure.quoteSha });
  assert.equal(lines().length, original.split('\r\n').length - 5);
  assert.ok(!LONE_LF.test(read()), 'remove-lines left a bare line feed');
  assert.equal(lines()[procedure.line - 2], '');

  const sha = shaOf({ file: memory, from: 8, to: 8 }).sha;
  replaceLines({ ...where, file: memory, from: 8, to: 8, expectSha: sha, content: '- Keep answers short.\n- And direct.\n' });
  assert.deepEqual(lines().slice(7, 9), ['- Keep answers short.', '- And direct.']);
  assert.ok(!LONE_LF.test(read()), 'replace-lines wrote a bare line feed');

  appendLines({ ...where, file: memory, expectSha: shaOf({ file: memory }).sha, content: '- One more line.\n- And another.\n' });
  assert.ok(read().endsWith('- One more line.\r\n- And another.\r\n'));
  assert.ok(!LONE_LF.test(read()), 'append-lines wrote a bare line feed');

  // The changed file is still the file the scanner and the checks understand.
  const again = runChecks(scan({ home: fx.home, projects: [fx.projects] }));
  assert.equal(again.candidates.filter((candidate) => candidate.check === 'procedure-in-memory').length, 0);

  // A project file, and a file with no final line ending.
  const alpha = `${fx.project('alpha-service')}/CLAUDE.md`;
  writeFileSync(alpha, '# alpha\r\n\r\n- First.\r\n- Last, with no line ending after it.');
  appendLines({ ...where, file: alpha, expectSha: shaOf({ file: alpha }).sha, content: '- Added.\n' });
  assert.equal(readFileSync(alpha, 'utf8'), '# alpha\r\n\r\n- First.\r\n- Last, with no line ending after it.\r\n- Added.');
});

test('CRLF: a settings file that is merged keeps its line endings, and a new file is written as it was given', (t) => {
  const { crlf } = pair(t, 'main');
  const { fx } = crlf;
  const where = { home: fx.home, projects: [fx.project('alpha-service')], backup: `${fx.home}/.claude/health-check/backup-crlf` };
  const settings = `${fx.home}/.claude/settings.json`;
  const before = readFileSync(settings, 'utf8');
  assert.ok(before.includes('\r\n') && !LONE_LF.test(before));
  const result = mergeSettings({ ...where, file: settings, patch: { permissions: { deny: ['Bash(git clean *)'] } } });
  assert.equal(result.changed, true);
  const after = readFileSync(settings, 'utf8');
  assert.ok(!LONE_LF.test(after), 'merge-settings turned a CRLF file into an LF file');
  assert.ok(after.endsWith('}\r\n'));
  assert.deepEqual(JSON.parse(after).permissions.deny, ['Bash(git clean *)']);
  assert.equal(JSON.parse(after).customUnknownKey.keep, true);
  assert.equal(scan({ home: fx.home }).settings.find((entry) => entry.path === settings).valid, true);

  // An LF file stays LF.
  const projectSettings = `${fx.project('alpha-service')}/.claude/settings.json`;
  writeFileSync(projectSettings, readFileSync(projectSettings, 'utf8').replace(/\r\n/g, '\n'));
  mergeSettings({ ...where, file: projectSettings, patch: { permissions: { deny: ['Bash(git clean *)'] } } });
  assert.ok(!readFileSync(projectSettings, 'utf8').includes('\r'), 'merge-settings turned an LF file into a CRLF file');

  // A new file has no endings to keep: it is written byte for byte.
  const skill = `${fx.home}/.claude/skills/fresh/SKILL.md`;
  const content = '---\r\nname: fresh\r\ndescription: Does it. Use when asked.\r\n---\r\n';
  writeNew({ ...where, file: skill, content });
  assert.equal(readFileSync(skill, 'utf8'), content);
});
