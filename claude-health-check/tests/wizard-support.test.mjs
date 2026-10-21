// What the wizard leans on besides the plain subcommands: results written to files instead of
// shell redirects, content passed as files instead of standard input, and judgement findings
// that are accepted only with a verbatim quote.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { load, materialise, runJson, runScript } from './helpers/fixtures.mjs';

const { runChecks } = await load('checks.mjs');
const { renderState } = await load('report.mjs');
const { scan } = await load('scan.mjs');

function setup(t) {
  const fx = materialise('main');
  t.after(() => fx.cleanup());
  // The run folder sits where the wizard puts it: under the health-check folder of the home.
  return { fx, memory: `${fx.home}/.claude/CLAUDE.md`, run: `${fx.home}/.claude/health-check/run-test` };
}

test('--out writes the full result as UTF-8 and prints only a summary', (t) => {
  const { fx, run } = setup(t);
  const scanFile = path.join(run, 'scan.json');
  const summary = runJson('scan.mjs', ['--home', fx.home, '--projects', fx.projects, '--out', scanFile]);
  assert.equal(summary.out, scanFile.replace(/\\/g, '/'));
  assert.equal(summary.projects, 2);
  assert.equal(summary.capped, false);
  assert.ok(summary.files > 20);
  assert.equal(summary.sections, undefined, 'the summary does not carry the inventory');
  const full = JSON.parse(readFileSync(scanFile, 'utf8'));
  assert.equal(full.files.length, summary.files);

  const checksFile = path.join(run, 'checks.json');
  const checked = runJson('checks.mjs', ['--scan', scanFile, '--lang', 'sk', '--out', checksFile]);
  const written = JSON.parse(readFileSync(checksFile, 'utf8'));
  assert.equal(checked.findings, written.findings.length);
  assert.deepEqual([checked.candidates, checked.review], [written.candidates.length, written.review.length]);
  assert.deepEqual(Object.keys(checked).sort(), ['candidates', 'findings', 'metrics', 'out', 'review']);
});

test('--nested on the command line includes nested repositories; without it they are only counted', (t) => {
  const fx = materialise('field');
  t.after(() => fx.cleanup());
  const run = `${fx.home}/.claude/health-check/run-test`;
  const plain = runJson('scan.mjs', ['--home', fx.home, '--projects', fx.projects, '--out', path.join(run, 'scan.json')]);
  assert.deepEqual([plain.projects, plain.nestedRepositories], [2, 3]);
  const nested = runJson('scan.mjs', ['--home', fx.home, '--projects', fx.projects, '--nested', '--out', path.join(run, 'scan-nested.json')]);
  assert.deepEqual([nested.projects, nested.nestedRepositories], [4, 3]);
  const full = JSON.parse(readFileSync(path.join(run, 'scan-nested.json'), 'utf8'));
  assert.equal(full.scope.nested, true);
  assert.deepEqual(full.nestedRepositories.map((entry) => entry.included), [true, false, true]);
});

test('a scan file redirected by Windows PowerShell (UTF-16 with a byte order mark) is still read', (t) => {
  const { fx, run } = setup(t);
  const scanFile = path.join(run, 'scan.json');
  runJson('scan.mjs', ['--home', fx.home, '--out', scanFile]);
  const utf16 = path.join(run, 'scan-utf16.json');
  writeFileSync(utf16, `\ufeff${readFileSync(scanFile, 'utf8')}`, 'utf16le');
  const result = runJson('checks.mjs', ['--scan', utf16]);
  assert.ok(result.findings.length > 10);
});

test('a judgement finding is accepted only with the exact text of the lines it points at', (t) => {
  const { fx, memory } = setup(t);
  const result = scan({ home: fx.home, projects: [fx.projects] });
  const vague = {
    title: 'Vague instruction',
    severity: 'low',
    file: memory,
    line: 9,
    quote: '- Prefer small functions over long ones.',
    message: 'Nothing here can be checked: "small" and "long" have no number.',
    why: 'Instructions should be concrete and verifiable.',
    kind: 'shorten',
    detail: 'Say what small means, or delete the line.',
  };
  const checks = runChecks(result, { judgement: [vague] });
  const finding = checks.findings.find((entry) => entry.check === 'judgement');
  assert.match(finding.id, /^judgement-[0-9a-f]{10}$/);
  assert.equal(finding.title, 'Vague instruction');
  assert.deepEqual([finding.line, finding.endLine, finding.quote], [9, 9, vague.quote]);
  assert.equal(finding.suggestion.kind, 'shorten');
  assert.ok(finding.quoteSha);
  assert.equal(checks.metrics.findings.low, runChecks(result).metrics.findings.low + 1);

  const html = renderState({ scan: result, checks, lang: 'en' });
  assert.match(html, /Found by reading the files/);
  assert.match(html, /Vague instruction/);
  assert.ok(html.includes(`id="${finding.id}"`));

  const refuse = (change, pattern) => assert.throws(() => runChecks(result, { judgement: [{ ...vague, ...change }] }), pattern);
  refuse({ quote: '- Prefer small functions.' }, /no quote, no finding/);
  refuse({ quote: undefined }, /no quote, no finding/);
  refuse({ line: 10 }, /no quote, no finding/);
  refuse({ line: 900 }, /no quote, no finding/);
  refuse({ file: `${fx.project('alpha-service')}/src/api/handler.ts` }, /not a file the scan lists/);
  refuse({ kind: 'rewrite' }, /Unknown kind/);
  refuse({ severity: 'urgent' }, /severity/);
  refuse({ message: '' }, /message/);
});

test('CLI: --judgement merges a file of judgement findings, or fails with the reason', (t) => {
  const { fx, memory, run } = setup(t);
  const scanFile = path.join(run, 'scan.json');
  runJson('scan.mjs', ['--home', fx.home, '--out', scanFile]);
  const judgement = path.join(run, 'judgement.json');
  const entry = {
    title: 'Model already does this',
    severity: 'low',
    file: memory,
    line: 8,
    quote: '- Keep answers short and direct.',
    message: 'm',
    why: 'w',
    kind: 'shorten',
    detail: 'd',
  };
  writeFileSync(judgement, JSON.stringify([entry]));
  const merged = runJson('checks.mjs', ['--scan', scanFile, '--judgement', judgement]);
  assert.equal(merged.findings.filter((finding) => finding.check === 'judgement').length, 1);

  writeFileSync(judgement, JSON.stringify([{ ...entry, quote: 'invented' }]));
  const refused = runScript('checks.mjs', ['--scan', scanFile, '--judgement', judgement]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no quote, no finding/);
});

test('content can be handed over as a file, so no shell has to carry it', (t) => {
  const { fx, memory, run } = setup(t);
  const backup = path.join(run, 'backup');
  const draft = path.join(run, 'draft.md');
  const content = '---\nname: vydanie\ndescription: Pripraví vydanie. Use when the user says "vydaj to".\n---\n\n1. Označ verziu.\n';
  runJson('scan.mjs', ['--home', fx.home, '--out', path.join(run, 'scan.json')]);
  writeFileSync(draft, content);

  const where = ['--backup', backup, '--home', fx.home];
  const skill = `${fx.home}/.claude/skills/vydanie/SKILL.md`;
  runJson('apply.mjs', ['write-new', '--file', skill, '--content-file', draft, ...where]);
  assert.equal(readFileSync(skill, 'utf8'), content, 'non-ASCII text arrives intact');

  writeFileSync(draft, '- Odpovedaj stručne.\n');
  const sha = runJson('apply.mjs', ['sha', '--file', memory, '--from', '8', '--to', '8']).sha;
  runJson('apply.mjs', ['replace-lines', '--file', memory, '--from', '8', '--to', '8', '--expect-sha', sha, '--content-file', draft, ...where]);
  assert.equal(readFileSync(memory, 'utf8').split('\n')[7], '- Odpovedaj stručne.');

  const whole = runJson('apply.mjs', ['sha', '--file', memory]).sha;
  runJson('apply.mjs', ['append-lines', '--file', memory, '--expect-sha', whole, '--content-file', draft, ...where]);
  assert.ok(readFileSync(memory, 'utf8').endsWith('- Odpovedaj stručne.\n'));

  const target = `${fx.home}/.claude/rules/x.md`;
  const missing = runScript('apply.mjs', ['write-new', '--file', target, '--content-file', path.join(run, 'nope.md'), ...where]);
  assert.equal(missing.status, 1);
  assert.ok(!existsSync(target));
});

test('--out never replaces a file outside the health-check folder', (t) => {
  const { fx, run } = setup(t);
  const scanFile = path.join(run, 'scan.json');
  const checksFile = path.join(run, 'checks.json');
  runJson('scan.mjs', ['--home', fx.home, '--out', scanFile]);
  runJson('checks.mjs', ['--scan', scanFile, '--out', checksFile]);

  const unrelated = `${fx.project('alpha-service')}/package.json`;
  const before = readFileSync(unrelated, 'utf8');
  for (const [script, args] of [
    ['scan.mjs', ['--home', fx.home, '--out', unrelated]],
    ['checks.mjs', ['--scan', scanFile, '--out', unrelated]],
    ['report.mjs', ['state', '--scan', scanFile, '--checks', checksFile, '--out', unrelated]],
    ['report.mjs', ['after', '--before', checksFile, '--scan', scanFile, '--checks', checksFile, '--out', unrelated]],
  ]) {
    const refused = runScript(script, args);
    assert.equal(refused.status, 1, `${script} wrote over an existing file`);
    assert.match(refused.stderr, /Refusing to overwrite/);
    assert.equal(readFileSync(unrelated, 'utf8'), before);
  }

  runJson('scan.mjs', ['--home', fx.home, '--out', scanFile]);
  const fresh = path.join(fx.root, 'elsewhere', 'scan.json');
  assert.equal(runJson('scan.mjs', ['--home', fx.home, '--out', fresh]).out, fresh.replace(/\\/g, '/'));
});

test('the after report can be written when the user stopped before any decision', (t) => {
  const { fx, run } = setup(t);
  const scanFile = path.join(run, 'scan.json');
  const checksFile = path.join(run, 'checks.json');
  runJson('scan.mjs', ['--home', fx.home, '--out', scanFile]);
  runJson('checks.mjs', ['--scan', scanFile, '--out', checksFile]);
  const out = path.join(run, 'after.html');
  runJson('report.mjs', ['after', '--before', checksFile, '--scan', scanFile, '--checks', checksFile, '--out', out]);
  assert.match(readFileSync(out, 'utf8'), /No change was applied\./);
});
