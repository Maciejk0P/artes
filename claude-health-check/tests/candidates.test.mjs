// What word matching finds is a candidate, never a finding: it has no severity, is not counted,
// and reaches a card only after a reader confirmed it with the exact quote. Each test here builds
// a small setup of its own and failed on the build that reported such lines as findings.

import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySetup, load, materialise } from './helpers/fixtures.mjs';

const { CANDIDATE_CHECKS, CHECKS, runChecks } = await load('checks.mjs');
const { LIMITS } = await load('lib/facts.mjs');
const { buildView } = await load('lib/view.mjs');
const { scan } = await load('scan.mjs');

function setup(t) {
  const s = emptySetup();
  t.after(() => s.cleanup());
  return s;
}

const findingsOf = (result, check) => result.findings.filter((finding) => finding.check === check).map((finding) => finding.quote);
const candidatesOf = (result, check) => result.candidates.filter((candidate) => candidate.check === check);

// The checks whose only evidence is the wording of a line.
const WORD_MATCHED = ['conflict-candidate', 'exception', 'procedure-in-memory', 'repeated-request', 'automation-in-memory', 'permission-in-prose', 'project-specific-in-user', 'skill-no-when-cue'];

test('a check is a finding or a candidate, never both, and every word-matched check is a candidate', () => {
  assert.deepEqual([...CANDIDATE_CHECKS].sort(), [...WORD_MATCHED].sort());
  assert.deepEqual(CHECKS.filter((check) => CANDIDATE_CHECKS.includes(check)), [], 'a check that is in both lists can reach a person as a finding');
});

test('on the main fixture no finding comes from a word-matched check, and no candidate has a severity', (t) => {
  const fx = materialise('main');
  t.after(() => fx.cleanup());
  const result = runChecks(scan({ home: fx.home, projects: [fx.projects] }));
  assert.deepEqual(result.findings.filter((finding) => WORD_MATCHED.includes(finding.check)).map((finding) => finding.check), []);
  for (const check of WORD_MATCHED.filter((name) => name !== 'conflict-candidate')) assert.ok(candidatesOf(result, check).length > 0, `${check} found nothing on the fixture that was written for it`);
  for (const candidate of result.candidates) {
    assert.equal('severity' in candidate, false, `${candidate.check} carries a severity before anyone read it`);
    assert.equal(candidate.status, 'open');
  }
  const { high, medium, low } = result.metrics.findings;
  assert.equal(high + medium + low, result.findings.length, 'candidates are not counted with the findings');
});

test('prose that opens with a word that is a noun and a verb is not reported as a rule with an exception', (t) => {
  const s = setup(t);
  s.write('home/.claude/CLAUDE.md', [
    '# How the service behaves',
    '',
    'Export jobs cover all customers except in the northern region.',
    'Record matching is instantiated only if its modality is configured.',
    'Test data is loaded only when the flag is set.',
    'Request handlers are registered unless the feature flag is off.',
    'Export pokrýva všetkých zákazníkov okrem severného regiónu.',
  ]);
  const result = runChecks(scan({ home: s.home }));
  assert.deepEqual(findingsOf(result, 'exception'), []);
  assert.deepEqual(result.findings, [], 'descriptive prose produced a finding');
});

test('"if I ..." lines that are no command are not reported as "turn it into a command and remove the line"', (t) => {
  const s = setup(t);
  s.write('home/.claude/CLAUDE.md', ['# Talk', '- If I write in Slovak, answer in Slovak.', '- When I ask a question, answer it before doing anything else.', '- If I say nothing about the language, answer in English.']);
  const result = runChecks(scan({ home: s.home }));
  assert.deepEqual(findingsOf(result, 'repeated-request'), []);
  for (const candidate of candidatesOf(result, 'repeated-request')) assert.match(candidate.message, /may /, 'a candidate is worded as a question, not as a fact');
});

test('a user line with a common word is not "about one project" because a folder has that name or one project has a manifest', (t) => {
  const s = setup(t);
  s.write('home/.claude/CLAUDE.md', ['# User', '- Write a test for every bug.', '- Keep the docs short.', '- Use npm, never yarn.']);
  s.write('projects/test/CLAUDE.md', ['# test', '- Rule.']);
  s.write('projects/docs/CLAUDE.md', ['# docs', '- Rule.']);
  s.write('projects/docs/package.json', '{}');
  const result = runChecks(scan({ home: s.home, projects: [s.projects] }));
  assert.deepEqual(findingsOf(result, 'project-specific-in-user'), []);
  // What the words suggest is kept for a reader, with what a confirmed one needs to become a card.
  const candidates = candidatesOf(result, 'project-specific-in-user');
  assert.ok(candidates.length >= 1);
  for (const candidate of candidates) assert.ok(candidate.data.projectPath && candidate.data.reason, 'the candidate does not say which project and why');
});

test('a numbered list of principles written in the imperative is a candidate, not a procedure finding', (t) => {
  const s = setup(t);
  s.write('home/.claude/CLAUDE.md', ['# Principles, most important first', '', '1. Think before coding.', '2. Prefer the simple solution.', '3. Make surgical changes.', '4. Verify the goal before you stop.', '5. Keep the reader in mind.']);
  const result = runChecks(scan({ home: s.home }));
  assert.deepEqual(findingsOf(result, 'procedure-in-memory'), [], 'a list of principles reached the person as a finding');
  assert.equal(candidatesOf(result, 'procedure-in-memory').length, 1);
});

test('a line about what tests or scripts must not use gives no ready-made deny rule', (t) => {
  const s = setup(t);
  s.write('home/.claude/CLAUDE.md', ['# Rules', '- Tests must not use `curl`; use the fake client.', '- Never execute bash scripts from the downloads folder.']);
  const result = runChecks(scan({ home: s.home }));
  assert.deepEqual(findingsOf(result, 'permission-in-prose'), []);
  for (const candidate of candidatesOf(result, 'permission-in-prose')) {
    assert.deepEqual(Object.keys(candidate.data).sort(), ['command', 'list', 'rule'], 'a confirmed candidate needs the rule it would add');
  }
});

test('a description that says when in other words is not told it does not, and a skill the model never picks is not asked', (t) => {
  const s = setup(t);
  s.write('home/.claude/CLAUDE.md', ['# User', '- Rule.']);
  const skill = (name, description, extra = []) => s.write(`home/.claude/skills/${name}/SKILL.md`, ['---', `name: ${name}`, `description: ${description}`, ...extra, '---', 'Body.']);
  skill('client', 'Regenerates the API client after every schema change.');
  skill('notes', 'Run before a release to build the notes.');
  skill('ship', 'Ships the release', ['disable-model-invocation: true']);
  const result = runChecks(scan({ home: s.home }));
  assert.deepEqual(result.findings.filter((finding) => finding.check === 'skill-no-when-cue').map((finding) => finding.file), []);
  const asked = candidatesOf(result, 'skill-no-when-cue').map((candidate) => candidate.file.split('/').at(-2));
  assert.ok(!asked.includes('ship'), 'a skill with disable-model-invocation is never chosen by the model, so it needs no "use when"');
});

test('a confirmed candidate becomes a finding that carries what the candidate knew', (t) => {
  const s = setup(t);
  const memory = s.write('home/.claude/CLAUDE.md', ['# Rules', '- Never run `git clean -fd` in this repository.']);
  const scanned = scan({ home: s.home });
  const [candidate] = candidatesOf(runChecks(scanned), 'permission-in-prose');
  assert.deepEqual(candidate.data, { command: 'git clean -fd', list: 'deny', rule: 'Bash(git clean -fd *)' });
  const entry = { candidate: candidate.id, title: 'A prohibition in prose', severity: 'medium', file: memory, line: 2, quote: '- Never run `git clean -fd` in this repository.', message: 'm', why: 'w', kind: 'make-setting', detail: 'd' };
  const judged = runChecks(scanned, { judgement: [entry] });
  const [finding] = judged.findings;
  assert.deepEqual([finding.check, finding.origin, finding.severity], ['judgement', 'permission-in-prose', 'medium']);
  assert.deepEqual(finding.data, candidate.data);
  // A quote that is only a part of the line is not the line.
  assert.throws(() => runChecks(scanned, { judgement: [{ ...entry, quote: '- Never run `git clean -fd`' }] }), /no quote, no finding/);
});

test('the pairs a reader has to compare are bounded, and what was left out is counted and said', (t) => {
  const s = setup(t);
  const lines = ['# Big file'];
  for (let index = 1; index <= 100; index += 1) lines.push(`## Section ${index}`, `- Always use the shared logger in module ${index}.`, `- Never use the shared logger in the bootstrap of module ${index}.`);
  s.write('home/.claude/CLAUDE.md', lines);
  const scanned = scan({ home: s.home });
  const result = runChecks(scanned);
  const pairs = candidatesOf(result, 'conflict-candidate');
  const perPlace = LIMITS.conflictPairsPerPlace.value;
  const perLine = LIMITS.conflictPairsPerLine.value;
  assert.ok(pairs.length > 0 && pairs.length <= perPlace, `${pairs.length} pairs, each one needs a verdict before the walk can start`);
  const uses = new Map();
  for (const pair of pairs) for (const line of [pair.line, pair.related[0].line]) uses.set(line, (uses.get(line) ?? 0) + 1);
  assert.ok(Math.max(...uses.values()) <= perLine, `one line is in ${Math.max(...uses.values())} pairs`);
  // 100 lines that ask and 100 that forbid, in 100 sections: 9,900 pairs share two terms.
  assert.deepEqual(result.metrics.conflictPairs, { found: pairs.length, compared: 0, confirmed: 0, leftOut: 9900 - pairs.length });
  assert.equal(LIMITS.conflictPairsPerPlace.documented, false, 'the bound is a default of this tool and says so');
  const view = buildView({ scan: scanned, checks: result, lang: 'en' });
  assert.match(view.candidates.sentence, new RegExp(`${(9900 - pairs.length).toLocaleString('en-US')} more pairs`), view.candidates.sentence);
  // A second run gives the same pairs: which ones are listed does not depend on chance.
  assert.deepEqual(candidatesOf(runChecks(scanned), 'conflict-candidate').map((pair) => pair.id), pairs.map((pair) => pair.id));
});

// A verdict as a reader writes it for a pair: confirmed with both quotes.
const confirmedPair = (pair, title = 'These two contradict') => ({
  candidate: pair.id, title, severity: 'high', kind: pair.suggestion.kind, file: pair.file, line: pair.line, endLine: pair.endLine, quote: pair.quote,
  related: pair.related.map((other) => ({ file: other.file, line: other.line, quote: other.quote })), message: 'One asks, one forbids.', why: 'Both load together.', detail: 'Keep one.',
});

test('the bound decides which pairs wait for a reader, never whether a pair that was read is still there', (t) => {
  // Three lines ask, one forbids: the line that forbids is in as many pairs as the list holds for one line.
  const s = setup(t);
  const user = s.write('home/.claude/CLAUDE.md', ['# User', '', '## Scripts', '- Always use the retry helper for network calls in scripts.']);
  s.write('projects/zzz/CLAUDE.md', [
    '# zzz', '', '## Clients', '- Always use the retry helper for network calls in clients.', '', '## Workers', '- Always use the retry helper for network calls in workers.', '',
    '## Tests', '- Never use the retry helper for network calls in tests.',
  ]);
  const look = () => scan({ home: s.home, projects: [`${s.projects}/zzz`] });
  const first = runChecks(look());
  const read = candidatesOf(first, 'conflict-candidate');
  assert.equal(read.length, LIMITS.conflictPairsPerLine.value, 'the setup does not fill the list of one line');
  assert.equal(first.metrics.conflictPairs.leftOut, 0);

  // More lines that ask arrive in a file that loads earlier, the way a card "move to the user file" puts them there.
  for (const added of [1, 4, 40]) {
    s.write('home/.claude/CLAUDE.md', ['# User', '', '## Scripts', '- Always use the retry helper for network calls in scripts.', ...Array.from({ length: added }, (_, index) => [`## Moved ${index}`, `- Always use the retry helper for network calls in gateway ${index}.`]).flat()]);
    const scanned = look();
    // Without a word about what was read, the bound picks from all pairs, and may pick others.
    const unread = candidatesOf(runChecks(scanned), 'conflict-candidate').map((pair) => pair.id);
    assert.ok(read.some((pair) => !unread.includes(pair.id)), `${added} more: the setup does not push a pair over the bound, so this proves nothing`);
    // Every pair that has a verdict is listed again, whichever it is, and a confirmed one is a finding.
    for (const judged of read) {
      const again = runChecks(scanned, { read: [judged] });
      assert.ok(candidatesOf(again, 'conflict-candidate').some((pair) => pair.id === judged.id), `${added} more: a pair that was read is no longer listed`);
      const merged = runChecks(scanned, { judgement: [confirmedPair(judged)] });
      const finding = merged.findings.find((entry) => entry.candidate === judged.id);
      assert.ok(finding, `${added} more: a confirmed contradiction whose two lines still stand is gone`);
      assert.deepEqual([finding.quote, finding.related[0].quote], [judged.quote, judged.related[0].quote]);
      assert.equal(merged.metrics.conflictPairs.confirmed, 1);
    }
    const all = runChecks(scanned, { read });
    assert.deepEqual(read.filter((pair) => !candidatesOf(all, 'conflict-candidate').some((entry) => entry.id === pair.id)), []);
    // The pairs that still wait for a reader are bounded as before, and the rest is counted.
    const waiting = candidatesOf(all, 'conflict-candidate').filter((pair) => !read.some((entry) => entry.id === pair.id));
    assert.ok(waiting.length <= LIMITS.conflictPairsPerPlace.value);
    assert.equal(all.metrics.conflictPairs.found + all.metrics.conflictPairs.leftOut, added + 3, 'a pair is listed, or it is counted as left out');
  }
  assert.ok(user);
});

test('the bound of one place does not take a pair that was read either', (t) => {
  const s = setup(t);
  const sections = (count, from = 0) => Array.from({ length: count }, (_, index) => [`## Part ${from + index}`, `- Always use the shared logger in module ${from + index}.`, `## Boot ${from + index}`, `- Never use the shared logger in the bootstrap of module ${from + index}.`]).flat();
  s.write('home/.claude/CLAUDE.md', ['# Big file', ...sections(40)]);
  const first = runChecks(scan({ home: s.home }));
  const read = candidatesOf(first, 'conflict-candidate');
  assert.equal(read.length, LIMITS.conflictPairsPerPlace.value);
  // Lines put in front of the others take the places of the list.
  s.write('home/.claude/CLAUDE.md', ['# Big file', ...sections(20, 100), ...sections(40)]);
  const scanned = scan({ home: s.home });
  const unread = candidatesOf(runChecks(scanned), 'conflict-candidate').map((pair) => pair.id);
  assert.ok(read.filter((pair) => !unread.includes(pair.id)).length > 0, 'the setup does not push a pair over the bound, so this proves nothing');
  // Told which pairs were read, the checks list every one of them again, where its lines stand now.
  const again = candidatesOf(runChecks(scanned, { read }), 'conflict-candidate');
  assert.deepEqual(read.filter((pair) => !again.some((entry) => entry.id === pair.id)).map((pair) => pair.quote), [], 'a pair that was read is no longer listed');
  assert.equal(again.length, LIMITS.conflictPairsPerPlace.value, 'the pairs that were read fill the list; none is added for a reader who is done');
  const now = (pair) => again.find((entry) => entry.id === pair.id);
  const judgement = read.map((pair, index) => (index % 2 ? { candidate: pair.id, dismissed: true, reason: 'they are about different modules' } : confirmedPair(now(pair), `Contradiction ${index}`)));
  // A dismissal names its pair by id alone, so the pairs are handed over as they were listed when they were read.
  const merged = runChecks(scanned, { read, judgement });
  assert.equal(merged.findings.filter((finding) => finding.check === 'judgement').length, Math.ceil(read.length / 2));
  assert.deepEqual(candidatesOf(merged, 'conflict-candidate').filter((pair) => pair.status !== 'open').length, read.length, 'a verdict was lost');
});
