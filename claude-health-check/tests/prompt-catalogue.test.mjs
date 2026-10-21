// Part 2, the prompt skill, is told the checks of part 1 through one generated file. These tests
// hold the two parts to the same checks: the same ids in the same order, the same limits and
// severities, and a prompt that writes only what the user picked.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { load, materialise, runScript } from './helpers/fixtures.mjs';

const { CATALOGUE_FILE, PROMPT_SKILL_DIR, renderCatalogue } = await load('prompt-catalogue.mjs');
const { CATALOGUE } = await load('lib/catalogue.mjs');
const { CANDIDATE_CHECKS, CHECKS, REVIEW_CHECKS, runChecks } = await load('checks.mjs');
const { SEVERITIES, SUGGESTION_KINDS } = await load('lib/kinds.mjs');
const { LIMITS, TOKENS } = await load('lib/facts.mjs');
const { parseFrontMatter } = await load('lib/frontmatter.mjs');
const { scan } = await load('scan.mjs');

const ALL = [...CHECKS, ...CANDIDATE_CHECKS, ...REVIEW_CHECKS];
const skillText = () => readFileSync(path.join(PROMPT_SKILL_DIR, 'SKILL.md'), 'utf8');

let main;
before(() => {
  main = materialise('main');
});
after(() => main.cleanup());

test('the catalogue names every check of the program, in its order, and nothing else', () => {
  assert.deepEqual(Object.keys(CATALOGUE), ALL);
});

test('a finding has its severities and a suggestion; a candidate or an item to review has no severity', () => {
  for (const id of CHECKS) {
    const entry = CATALOGUE[id];
    assert.ok(Array.isArray(entry.severity) && entry.severity.length > 0, `${id} has no severity`);
    for (const severity of entry.severity) assert.ok(SEVERITIES.includes(severity), `${id}: ${severity} is not a severity`);
    assert.ok(SUGGESTION_KINDS.includes(entry.kind), `${id}: ${entry.kind} is not a suggestion kind`);
  }
  for (const id of [...CANDIDATE_CHECKS, ...REVIEW_CHECKS]) assert.equal(CATALOGUE[id].severity, null, `${id} is found by wording and has no severity`);
  for (const id of ALL) {
    assert.ok(CATALOGUE[id].measure.length > 20, `${id} does not say how it measures`);
    if (CATALOGUE[id].limit) assert.ok(LIMITS[CATALOGUE[id].limit], `${id} names a limit that lib/facts.mjs does not have`);
  }
});

test('checks.md of part 2 is exactly what the catalogue renders, with every placeholder filled', () => {
  const text = renderCatalogue();
  assert.equal(readFileSync(CATALOGUE_FILE, 'utf8').replace(/\r\n/g, '\n'), text, 'checks.md is stale: run node prompt-catalogue.mjs --write');
  assert.equal(/\{\w+\}/.exec(text), null, 'a placeholder was left unfilled');
  for (const id of ALL) assert.ok(text.includes(`\n### ${id}\n`), `${id} is missing from checks.md`);
  for (const [name, limit] of Object.entries(LIMITS)) assert.ok(text.includes(`| ${name} | ${limit.value} |`), `the limit ${name} is missing`);
  assert.ok(text.includes(`The same ${ALL.length} checks as the program`));
});

test('--check passes on the checks.md that is there', () => {
  const result = runScript('prompt-catalogue.mjs', ['--check']);
  assert.equal(result.status, 0, result.stderr);
});

test('the program refuses a severity that the catalogue does not allow', () => {
  const setupScan = scan({ home: main.home, projects: [main.projects] });
  const result = runChecks(setupScan);
  const reported = result.findings.filter((finding) => CHECKS.includes(finding.check));
  assert.ok(reported.length >= 5, `the fixture produced only ${reported.length} findings`);
  for (const finding of reported) assert.ok(CATALOGUE[finding.check].severity.includes(finding.severity), `${finding.check} came out ${finding.severity}`);

  const check = reported[0].check;
  const saved = CATALOGUE[check].severity;
  CATALOGUE[check].severity = SEVERITIES.filter((severity) => !saved.includes(severity));
  try {
    assert.throws(() => runChecks(setupScan), new RegExp(`"${check}" is reported as`));
  } finally {
    CATALOGUE[check].severity = saved;
  }
});

test('part 2 runs no program, has no write allowed ahead of time, and writes only what the user picked', () => {
  const text = skillText();
  const matter = parseFrontMatter(text);
  assert.ok(matter.valid, matter.error);
  assert.equal(matter.data.name, 'claude-health-prompt');
  // Edit and Write stay out on purpose, so that Claude Code asks before each write too.
  assert.deepEqual(matter.data['allowed-tools'], ['Read', 'Glob', 'Grep', 'Bash(wc *)', 'Bash(cmp *)', 'Bash(ls -t *)']);
  assert.ok(!/\bnode\s|\.mjs\b/.test(text), 'part 2 runs a program, so it is no longer markdown alone');
  assert.ok(text.includes('Stop and wait for the answer.'), 'part 2 may apply changes before the user picked them');
  assert.ok(text.includes('Never apply an item the user did not pick'));
  assert.ok(/never Write it whole, never\s+copy it anywhere/.test(text), 'part 2 may rewrite or copy a settings file');
  assert.ok(/With\s+`--report-only`, end here/.test(text), 'part 2 has no run that changes nothing');
  assert.ok(matter.data.description.includes(`same ${ALL.length} checks`), 'the description names another number of checks');
  assert.ok(matter.data.description.length <= LIMITS.skillDescriptionChars.value);
});

test('part 2 marks each severity with an icon of its own and prints the legend', () => {
  const text = skillText();
  // The first run by a tester (19 Oct 2026) could not tell a warning from a critical finding at a glance.
  const icons = SEVERITIES.map((severity) => new RegExp(`^\\| (\\S+) \\| ${severity}: `, 'mu').exec(text)?.[1]);
  icons.forEach((icon, index) => assert.ok(icon, `${SEVERITIES[index]} has no icon in the legend`));
  assert.equal(new Set(icons).size, SEVERITIES.length, 'two severities share an icon');
  assert.ok(text.includes('print this legend once'), 'part 2 has icons but prints no legend');
  assert.ok(text.includes('never give those a severity of your own'), 'part 2 may invent a severity for what no check measured');
});

test('part 2 opens with a short view: a TL;DR and a plan in plain words, the rest on request', () => {
  const text = skillText();
  // The owner asked for a report that helps fast and says what will be done, without long lists (19 Oct 2026).
  const report = text.slice(text.indexOf('## Step 7.'), text.indexOf('## Step 8.'));
  const tldr = report.indexOf('**TL;DR**, at most three sentences');
  assert.ok(tldr > 0, 'the report does not open with a TL;DR');
  assert.ok(tldr < report.indexOf('**The full report**, only on `report`'), 'the full report comes before the short view, or always');
  assert.ok(report.includes('never list it item by item'), 'the report may list what is fine');
  // A live run on 20 Oct 2026 wrote five sentences and a list: the sentence on a new session came on top of the three.
  assert.ok(report.includes('at most three sentences and no list'), 'the TL;DR may grow into a list');
  assert.ok(text.includes('one of the three sentences of the TL;DR'), 'the tip of a new session may add a sentence past the three');
  const plan = text.slice(text.indexOf('## Step 8.'), text.indexOf('## Step 9.'));
  assert.ok(plan.includes('at most seven items'), 'the plan has no length limit');
  assert.ok(plan.includes('Keep for `details <n>`'), 'the exact change is not kept for details');
  assert.ok(text.includes('run `/init` in that folder') && text.includes('`ls -t -d <folder>/.git`'), 'part 2 does not point a repository without memory to /init');
});

test('part 2 proposes a question before what cannot be undone, as ask rules of the user settings', () => {
  const text = skillText();
  // A tester asked for a question before a push and a write to the tracker; the owner added deletion (19 Oct 2026).
  const start = text.indexOf('### Then: a question before what cannot be undone');
  assert.ok(start > 0, 'part 2 has no list of actions that cannot be undone');
  const section = text.slice(start, text.indexOf('\n## ', start));
  const rules = [...section.matchAll(/`((?:Bash|PowerShell)\([^`]*\))`/g)].map((match) => match[1]);
  for (const rule of ['Bash(git push *)', 'Bash(rm *)', 'Bash(git clean *)', 'Bash(git reset --hard *)', 'PowerShell(Remove-Item *)']) {
    assert.ok(rules.includes(rule), `${rule} is not proposed`);
  }
  // A star needs a space before it to match the bare command too (https://code.claude.com/docs/en/permissions).
  for (const rule of rules) assert.match(rule, /^(Bash|PowerShell)\((\*|[A-Za-z][^()*]*( \*)?)\)$/, `${rule} is not a rule of the documented shape`);
  assert.ok(!/`mcp__[^`]*\(/.test(section), 'an MCP rule with parentheses is skipped by Claude Code');
  assert.ok(text.includes('`ask` list under `permissions` in\n`<home>/.claude/settings.json`'), 'part 2 does not say where the ask rules go');
  assert.ok(text.includes("never in a project's\nsettings"), 'part 2 may put ask rules into settings a team shares');
  assert.ok(text.includes('Change no allow or deny rule.'), 'part 2 may change an allow or deny rule');
  assert.ok(text.includes('never read `~/.claude.json`'), 'part 2 may read ~/.claude.json to find MCP servers');
  assert.ok(text.includes('a seat belt, not a lock'), 'part 2 does not say what an ask rule does not catch');
});

test('part 2 takes numbers and no text from a transcript, with the pattern it names', () => {
  const text = skillText();
  const pattern = /`("usage":\\\{[^`]+)`/.exec(text);
  assert.ok(pattern, 'part 2 names no usage pattern');
  const usage = new RegExp(pattern[1], 'g');
  const row = (object) => JSON.stringify(object);
  const transcript = [
    row({ type: 'user', message: { content: 'SECRET-PROMPT "usage":{"input_tokens":5,"cache_creation_input_tokens":6,"cache_read_input_tokens":7}' } }),
    row({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', input: { command: 'SECRET-COMMAND' } }], usage: { input_tokens: 3, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0, output_tokens: 10 } } }),
    row({ type: 'attachment', attachment: { content: 'SECRET-OUTPUT' }, usage: { totalTokens: 9, toolUses: 1 } }),
    row({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'SECRET-ANSWER' }], usage: { input_tokens: 1, cache_creation_input_tokens: 50, cache_read_input_tokens: 2000, output_tokens: 5 } } }),
  ].join('\n');
  const matches = transcript.match(usage) ?? [];
  assert.deepEqual(matches, [
    '"usage":{"input_tokens":3,"cache_creation_input_tokens":2000,"cache_read_input_tokens":0',
    '"usage":{"input_tokens":1,"cache_creation_input_tokens":50,"cache_read_input_tokens":2000',
  ], 'the pattern takes another row than the usage of a reply, or more than its numbers');
  assert.ok(text.includes('Never fall back to reading a transcript.'));
  assert.ok(text.includes(`above ${TOKENS.longContext.value.toLocaleString('en-US')} tokens`), 'the long context of part 2 differs from part 1');
});

test('the comparison of the two parts finds a finding that one of them missed', async () => {
  const { parity, part2Result } = await load('prompt-parity.mjs');
  const result = runChecks(scan({ home: main.home, projects: [main.projects] }));
  const asPart2 = {
    part: 2,
    findings: result.findings.map(({ check, severity, file, line }) => ({ check, severity, file, line })),
    candidates: result.candidates.map(({ check, file, line }) => ({ check, file, line })),
    notes: [],
    review: [],
    contextTokens: Object.fromEntries(result.contextTax.map((place) => [place.project ?? 'user', place.tokens])),
  };
  const answer = `Report.\n\n\`\`\`json\n${JSON.stringify(asPart2)}\n\`\`\`\n`;
  for (const text of [answer, JSON.stringify(asPart2), JSON.stringify({ result: answer })]) {
    assert.deepEqual(part2Result(text).findings, asPart2.findings);
  }
  const same = parity({ ...result, contextTokens: asPart2.contextTokens }, asPart2);
  assert.deepEqual([same.findings.onlyPart1, same.findings.onlyPart2, same.findings.severityDiffers], [[], [], []]);

  // Findings are matched by check and file, so the one left out has to be the only one of its kind there.
  const keyOf = (item) => `${item.check} ${item.file}`;
  const alone = asPart2.findings.findIndex((item) => asPart2.findings.filter((other) => keyOf(other) === keyOf(item)).length === 1);
  assert.ok(alone >= 0, 'the fixture has no finding that is alone in its file');
  const missed = { ...asPart2, findings: asPart2.findings.filter((_, index) => index !== alone) };
  const differs = parity({ ...result, contextTokens: asPart2.contextTokens }, missed);
  assert.equal(differs.findings.onlyPart1.length, 1, 'a finding of part 1 that part 2 did not report went unseen');
  assert.throws(() => part2Result('No block here.'), /No ```json block/);
});

test('part 2 reads its checks from checks.md and reaches into session transcripts only for the numbers', () => {
  const text = skillText();
  assert.ok(text.includes('[checks.md](checks.md)'));
  assert.ok(text.includes('Never Read, Glob or Grep there otherwise.'));
  // The first live run checked the home folder with Glob "*" and got the name of a transcript (19 Oct 2026).
  assert.ok(text.includes('with `ls -t -d <folder>`') && /Never Glob `\*` with the home folder/.test(text), 'part 2 may check a folder with a pattern that reaches the transcripts');
  assert.ok(/never list a folder\s+recursively/.test(text), 'part 2 may list the transcripts recursively');
  // The third live run grepped **/CLAUDE.md over the folder above the home and walked the transcripts.
  assert.ok(/never Grep or Glob with a `\*\*`\s+pattern from the home folder or a folder above it/.test(text), 'part 2 may grep its way through the transcripts');
  assert.ok(text.includes('Never Glob `<home>/**` or\n  `<home>/.claude/**`'), 'part 2 may glob its way into the transcripts');
  // A server written on one line carries its env values; only -o keeps them out (first run, 16 Oct 2026).
  assert.ok(text.includes('Never Read an `.mcp.json`: Grep it with `-o`'), 'part 2 may read the values of .mcp.json');
  assert.ok(/does not, stop: say which argument/.test(text), 'part 2 goes on with a folder that is not there');
  assert.ok(text.split('\n').length <= LIMITS.skillLines.value, 'part 2 is over the skill length it checks for');
});
