import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { load, materialise, runJson, runScript } from './helpers/fixtures.mjs';

const checksModule = await load('checks.mjs');
const {
  CANDIDATE_CHECKS,
  CHECKS,
  REVIEW_CHECKS,
  SUGGESTION_KINDS,
  matchAutomation,
  matchException,
  matchPermission,
  matchRepeatedRequest,
  permissionRule,
  ruleCoversCommand,
  ruleNamesServer,
  runChecks,
} = checksModule;
const { LIMITS, SOURCES } = await load('lib/facts.mjs');
const { scan } = await load('scan.mjs');

let main;
let clean;
let mainScan;
let mainResult;
let cleanResult;

before(() => {
  main = materialise('main');
  clean = materialise('clean');
  mainScan = scan({ home: main.home, projects: [main.projects] });
  mainResult = runChecks(mainScan);
  cleanResult = runChecks(scan({ home: clean.home, projects: [clean.projects] }));
});
after(() => {
  main.cleanup();
  clean.cleanup();
});

const of = (result, check) => result.findings.filter((finding) => finding.check === check);
const candidatesOf = (result, check) => result.candidates.filter((candidate) => candidate.check === check);
const userMemory = () => `${main.home}/.claude/CLAUDE.md`;
const alphaMemory = () => `${main.project('alpha-service')}/CLAUDE.md`;
const sha = (text) => createHash('sha256').update(text).digest('hex');

test('the clean fixture has no findings, no candidates, nothing to review and no notes', () => {
  assert.deepEqual(cleanResult.findings, []);
  assert.deepEqual(cleanResult.candidates, []);
  assert.deepEqual(cleanResult.review, []);
  assert.deepEqual(cleanResult.notes, []);
  assert.deepEqual(cleanResult.metrics.findings, { high: 0, medium: 0, low: 0 });
  assert.deepEqual(cleanResult.metrics.candidates, { total: 0, open: 0, confirmed: 0, dismissed: 0 });
});

for (const check of CANDIDATE_CHECKS) {
  test(`candidate ${check}: found on the main fixture, not on the clean one, and never as a finding`, () => {
    assert.ok(candidatesOf(mainResult, check).length > 0, `${check} found nothing on the main fixture`);
    assert.equal(candidatesOf(cleanResult, check).length, 0, `${check} found something on the clean fixture`);
    assert.equal(of(mainResult, check).length, 0, `${check} reached the findings`);
  });
}

// memory-too-large needs a file over 4 MiB, so it has its own test below with a generated file.
for (const check of CHECKS.filter((name) => name !== 'memory-too-large' && name !== 'front-matter-unreadable')) {
  test(`check ${check}: fires on the main fixture, silent on the clean one`, () => {
    assert.ok(of(mainResult, check).length > 0, `${check} did not fire on the main fixture`);
    assert.equal(of(cleanResult, check).length, 0, `${check} fired on the clean fixture`);
  });
}

test('the checks the owner asked to remove are gone: nothing about allow rules, bypass mode, secrets or git', () => {
  for (const removed of ['settings-allow-all', 'settings-bypass-permissions', 'skill-in-two-scopes']) {
    assert.ok(![...CHECKS, ...CANDIDATE_CHECKS, ...REVIEW_CHECKS].includes(removed), removed);
    assert.equal(of(mainResult, removed).length, 0, removed);
  }
  assert.equal(checksModule.isAllowAllRule, undefined);
  // The fixture still allows everything and switches the prompts off. The scan does not read the
  // mode at all, and of the rules it keeps how many there are, not what they say.
  const user = mainScan.settings.find((entry) => entry.kind === 'settings' && entry.scope === 'user');
  assert.deepEqual(user.permissions, { allow: 2, ask: 0, deny: 0, mcp: [] });
  for (const word of ['defaultMode', 'bypassPermissions']) assert.ok(!JSON.stringify(mainScan).includes(word), `the scan carries "${word}"`);
  const everything = JSON.stringify([mainResult.findings, mainResult.candidates, mainResult.review, mainResult.notes]);
  for (const word of ['bypassPermissions', 'allow rule', '.gitignore', 'gitignore', 'credential', 'secret', 'token']) {
    assert.ok(!everything.toLowerCase().includes(word.toLowerCase()), `the result speaks about "${word}"`);
  }
  assert.equal(mainResult.metrics.denyRules, undefined);
  // Masking stays, as a property of the output.
  assert.ok(!JSON.stringify([mainScan, mainResult]).includes('FIXTURE-SECRET-VALUE'));
});

test('every finding has the documented shape, a stable unique id and a known suggestion kind', () => {
  const ids = new Set();
  for (const finding of mainResult.findings) {
    assert.match(finding.id, /^[a-z-]+-[0-9a-f]{10}$/);
    assert.ok(!ids.has(finding.id), `duplicate id ${finding.id}`);
    ids.add(finding.id);
    assert.ok(CHECKS.includes(finding.check));
    assert.ok(['high', 'medium', 'low'].includes(finding.severity));
    assert.ok(finding.file && finding.message && finding.why);
    assert.ok(SUGGESTION_KINDS.includes(finding.suggestion.kind), `unknown kind ${finding.suggestion.kind}`);
    assert.ok(finding.suggestion.detail);
  }
  for (const candidate of mainResult.candidates) {
    assert.match(candidate.id, /^[a-z-]+-[0-9a-f]{10}$/);
    assert.ok(!ids.has(candidate.id), `duplicate id ${candidate.id}`);
    ids.add(candidate.id);
    assert.ok(CANDIDATE_CHECKS.includes(candidate.check));
    assert.equal('severity' in candidate, false, 'a candidate gets no severity before it is read');
    assert.equal(candidate.status, 'open');
    assert.ok(candidate.quote && candidate.quoteSha && candidate.message && candidate.why, 'a candidate always quotes its line');
  }
});

test('a quote is the exact text of the quoted lines, with a hash of it', () => {
  let quoted = 0;
  for (const finding of [...mainResult.findings, ...mainResult.candidates]) {
    if (finding.quote === null || finding.line === null) continue;
    const lines = readFileSync(finding.file, 'utf8').split(/\r?\n/);
    const expected = lines.slice(finding.line - 1, finding.endLine).join('\n');
    assert.equal(finding.quote, expected, `${finding.id} does not quote ${finding.file}:${finding.line}`);
    assert.equal(finding.quoteSha, sha(expected));
    quoted += 1;
  }
  assert.ok(quoted > 15);
});

test('length: the number and its source are stated, the largest sections are named', () => {
  const [finding] = of(mainResult, 'memory-too-long');
  assert.equal(finding.file, userMemory());
  assert.equal(finding.severity, 'medium');
  assert.match(finding.message, /238 lines/);
  assert.match(finding.message, /under 200/);
  assert.ok(finding.why.includes(SOURCES.memory));
  assert.match(finding.suggestion.detail, /Reference: error codes \(192 lines\)/);
  assert.equal(finding.suggestion.kind, 'shorten');
  assert.equal(finding.line, 47);
  assert.equal(finding.quote, '## Reference: error codes');
});

test('length: a file over 4 MiB is reported as not loaded at all', (t) => {
  const local = materialise('clean');
  t.after(() => local.cleanup());
  const dir = path.join(local.projects, 'huge-notes');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'CLAUDE.md'), `# Huge\n\n${'x'.repeat(LIMITS.memoryFileBytes.value + 10)}\n`);
  const result = runChecks(scan({ home: local.home, projects: [local.projects] }));
  const [finding] = of(result, 'memory-too-large');
  assert.equal(finding.severity, 'high');
  assert.ok(finding.file.endsWith('huge-notes/CLAUDE.md'));
  assert.equal(of(cleanResult, 'memory-too-large').length, 0);
});

test('always-loaded total: counted per project with imports and rule files, against a labelled default', () => {
  // 434 lines of memory and imports, plus the one user rule file that has no paths pattern (3).
  assert.deepEqual(mainResult.metrics.alwaysLoadedLines, {
    user: 437,
    [main.project('alpha-service')]: 459,
    [main.project('beta-tool')]: 443,
  });
  const alpha = mainResult.alwaysLoaded.find((group) => group.project === main.project('alpha-service'));
  assert.deepEqual(
    alpha.files.filter((file) => file.role === 'rule').map((file) => file.label),
    ['~/.claude/rules/deep/naming.md', 'alpha-service/.claude/rules/api.md'],
    'a rule file with a paths pattern is not loaded at launch',
  );
  assert.deepEqual(alpha.excluded, []);
  const findings = of(mainResult, 'always-loaded-total');
  assert.equal(findings.length, 1, 'when the user files alone are over, it is reported once');
  assert.equal(findings[0].file, userMemory());
  assert.deepEqual([findings[0].line, findings[0].quote], [null, null], 'a sum has no line of its own');
  assert.match(findings[0].why, /no number for the total/);
  assert.match(findings[0].why, /--total-lines/);
  assert.equal(findings[0].suggestion.kind, 'make-rule-file');

  const cleanScan = scan({ home: clean.home, projects: [clean.projects] });
  assert.equal(of(runChecks(cleanScan, { totalLines: 15 }), 'always-loaded-total')[0].file, `${clean.project('tidy-app')}/CLAUDE.md`);
  assert.equal(of(runChecks(cleanScan, { totalLines: 10 }), 'always-loaded-total')[0].file, `${clean.home}/.claude/CLAUDE.md`);
});

test('duplicates: inside one file and across files that load together', () => {
  const [within] = of(mainResult, 'duplicate-within');
  assert.equal(within.line, 10);
  assert.equal(within.quote, '- Keep answers short and direct.');
  assert.equal(within.related[0].line, 8);
  assert.equal(within.suggestion.kind, 'delete-duplicate');

  const across = of(mainResult, 'duplicate-across');
  assert.equal(across.length, 1);
  assert.equal(across[0].file, alphaMemory());
  assert.equal(across[0].line, 8);
  assert.deepEqual(across[0].related, [{ file: userMemory(), line: 11, quote: '- Write commit messages in the imperative mood.' }]);
});

test('the same line in several project files is a move-to-user candidate', () => {
  const [finding] = of(mainResult, 'same-line-in-projects');
  assert.equal(finding.file, alphaMemory());
  assert.equal(finding.line, 9);
  assert.equal(finding.suggestion.kind, 'move-to-user');
  assert.equal(finding.related[0].file, `${main.project('beta-tool')}/CLAUDE.md`);
});

test('conflicts are candidates, not findings: no severity, not counted, both lines quoted', () => {
  assert.equal(of(mainResult, 'conflict-candidate').length, 0);
  const candidates = candidatesOf(mainResult, 'conflict-candidate');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].file, alphaMemory());
  assert.equal(candidates[0].line, 7);
  assert.equal(candidates[0].quote, '- Never use tabs for indentation; use two spaces.');
  assert.deepEqual(candidates[0].related, [{ file: userMemory(), line: 7, quote: '- Always use tabs for indentation in TypeScript files.' }]);
  assert.match(candidates[0].message, /indentation/);
  assert.match(candidates[0].why, /may not be a conflict at all/);
  assert.equal(candidates[0].suggestion.kind, 'review-conflict');
  assert.deepEqual(mainResult.metrics.conflictPairs, { found: 1, compared: 0, confirmed: 0, leftOut: 0 });
  assert.deepEqual(mainResult.metrics.candidates, { total: 15, open: 15, confirmed: 0, dismissed: 0 });
  const { high, medium, low } = mainResult.metrics.findings;
  assert.equal(high + medium + low, mainResult.findings.length);
  assert.equal(mainResult.metrics.suggestions, mainResult.findings.length);
});

test('a pair is not made of two lines of one section, nor of lines that share only function words', (t) => {
  const pairs = (body) => candidatesOf(checkMemory(t, body).result, 'conflict-candidate').map((candidate) => [candidate.line, candidate.related[0].line]);
  const sameSection = '# Rules\n\n## Tabs\n\n- Always use tabs for indentation in TypeScript files.\n- Never use tabs for indentation in YAML files.\n';
  assert.deepEqual(pairs(sameSection), [], 'two lines of one section refine each other');
  const twoSections = '# Rules\n\n## Tabs\n\n- Always use tabs for indentation in TypeScript files.\n\n## Spaces\n\n- Never use tabs for indentation in YAML files.\n';
  assert.deepEqual(pairs(twoSections), [[9, 5]], 'the same two lines in two sections are a pair to read');
  const slovak = '# Pravidlá\n\n## Odpovede\n\n- Vždy odpovedaj krátko, ani slovo navyše, ešte lepšie v bodoch.\n\n## Testy\n\n- Nikdy nemaž testy, ani dočasne, ešte pred revíziou.\n';
  assert.deepEqual(pairs(slovak), [], '"ani" and "ešte" are not terms');
  const slovakReal = '# Pravidlá\n\n## Odsadenie\n\n- Vždy používaj tabulátory na odsadenie kódu.\n\n## Formát\n\n- Nikdy nepoužívaj tabulátory na odsadenie kódu.\n';
  assert.deepEqual(pairs(slovakReal), [[9, 5]], 'Slovak lines that share real terms are still paired');
});

test('a rule that may carry an exception is a candidate, listed next to the rule it limits, in English and Slovak', () => {
  assert.equal(of(mainResult, 'exception').length, 0, 'a line found by its words was reported as a finding');
  const exceptions = candidatesOf(mainResult, 'exception').filter((candidate) => candidate.file === userMemory());
  assert.deepEqual(
    exceptions.map((candidate) => [candidate.line, candidate.endLine]),
    [
      [13, 13],
      [14, 14],
      [15, 15],
      [24, 25],
    ],
  );
  assert.equal(exceptions[3].quote, '- Do not commit generated files.\n  - Unless the file is a lockfile.');
  assert.match(exceptions[1].message, /okrem/);
  assert.match(exceptions[0].message, /^This line may be a rule/, 'it is worded as a question');
  assert.match(exceptions[0].why, /found by its words alone/);
  assert.ok(exceptions.every((candidate) => candidate.suggestion.kind === 'review-exception'));

  assert.equal(matchException('Use tabs, except in YAML files.'), 'except in');
  assert.equal(matchException('Deploy on Fridays only when the tests pass.'), 'only when');
  assert.equal(matchException('Používaj tabulátory, pokiaľ nie je súbor YAML.'), 'pokiaľ nie');
  assert.equal(matchException('Zapisuj to do denníka, iba ak ide o rozhodnutie.'), 'iba ak');
  assert.equal(matchException('Throw an exception when the input is empty.'), null);
  assert.equal(matchException('Keep answers short.'), null);
});

// A user memory file with the given body, checked on its own.
function checkMemory(t, body, prepare = () => {}) {
  const local = materialise('clean');
  t.after(() => local.cleanup());
  writeFileSync(path.join(local.home, '.claude', 'CLAUDE.md'), body);
  prepare(local);
  return { local, result: runChecks(scan({ home: local.home, projects: [local.projects] })) };
}

test('a numbered block of four or more items is a make-skill candidate; three items are not', (t) => {
  assert.equal(of(mainResult, 'procedure-in-memory').length, 0, 'a numbered block was reported as a finding');
  const [candidate] = candidatesOf(mainResult, 'procedure-in-memory');
  assert.equal(candidate.line, 29);
  assert.equal(candidate.endLine, 33);
  assert.equal('severity' in candidate, false);
  assert.match(candidate.message, /5 items/);
  assert.equal(candidate.suggestion.kind, 'make-skill');

  const blocks = (body) => {
    const { result } = checkMemory(t, body);
    return [of(result, 'procedure-in-memory').length, candidatesOf(result, 'procedure-in-memory').length];
  };
  const fenced = '# Notes\n\n1. First thing.\n2. Second thing.\n3. Third thing.\n\n```\n1. a\n2. b\n3. c\n4. d\n```\n';
  assert.deepEqual(blocks(fenced), [0, 0], 'numbered lines inside a code block are not steps');
  const stepWords = '# Notes\n\nStep 1: fetch.\nStep 2: build.\nStep 3: test.\nStep 4: tag.\n';
  assert.deepEqual(blocks(stepWords), [0, 1]);
});

test('a numbered block is a candidate whatever its items open with, worded as a question', (t) => {
  const principles = '# Notes\n\n1. Correctness before speed.\n2. Readability before cleverness.\n3. Small changes before large ones.\n4. Facts before opinions.\n';
  const { result } = checkMemory(t, principles);
  assert.equal(of(result, 'procedure-in-memory').length, 0, 'a ranking is numbered too; a program cannot call it a procedure');
  const [candidate] = candidatesOf(result, 'procedure-in-memory');
  assert.deepEqual([candidate.line, candidate.endLine], [3, 6]);
  assert.match(candidate.message, /if it is a procedure/i);
  assert.match(candidate.why, /rankings, options and principles/);

  // Items that open with a verb prove nothing: principles are written in the imperative as well.
  for (const body of [
    '# Notes\n\n1. Run the tests.\n2. The build must be green.\n3. Tag the commit.\n4. Write the notes.\n',
    '# Notes\n\n1. Think before coding.\n2. Prefer the simple solution.\n3. Make surgical changes.\n4. Verify the goal.\n',
    '# Notes\n\n1. Píš malé funkcie.\n2. Používaj jasné názvy.\n3. Over výsledok.\n4. Zapíš rozhodnutie.\n',
  ]) {
    const found = checkMemory(t, body).result;
    assert.deepEqual([of(found, 'procedure-in-memory').length, candidatesOf(found, 'procedure-in-memory').length], [0, 1], body);
  }
});

test('a procedure keeps its code blocks and continuation lines, and its range covers every step', (t) => {
  const range = (body) => {
    const { result } = checkMemory(t, body);
    return [...of(result, 'procedure-in-memory'), ...candidatesOf(result, 'procedure-in-memory')].map((entry) => [entry.line, entry.endLine]);
  };

  const withCode = [
    '# Release',
    '',
    '1. Bump the version:',
    '   ```',
    '   npm version patch',
    '   ```',
    '2. Push the tag:',
    '',
    '   ```',
    '   git push --tags',
    '   ```',
    '3. Build the package.',
    '4. Publish it.',
    '5. Announce the release.',
    '',
    '## Next section',
    '',
  ].join('\n');
  assert.deepEqual(range(withCode), [[3, 14]]);

  const flushCode = ['# Release', '', '1. Bump the version:', '```', 'npm version patch', '```', '2. Push.', '3. Build.', '4. Publish.', ''].join('\n');
  assert.deepEqual(range(flushCode), [[3, 9]], 'a code block right under a step belongs to it even when it is not indented');

  const lazy = [
    '# Release',
    '',
    '1. Update the version number',
    'in the manifest and in the lock file.',
    '2. Run the tests.',
    '3. Write the notes.',
    '4. Tag the commit.',
    '',
    'A paragraph after the list is not part of it.',
    '',
  ].join('\n');
  assert.deepEqual(range(lazy), [[3, 7]], 'an unindented continuation line does not split the block');

  const trailing = ['1. One.', '2. Two.', '3. Three.', '4. Four.', '', '```', 'an example that follows the list', '```', '', '- Another rule.', ''].join('\n');
  assert.deepEqual(range(trailing), [[1, 4]], 'a code block after the list is not removed with it');

  const twoLists = ['1. One.', '2. Two.', '', 'Text between two lists.', '', '1. Three.', '2. Four.', ''].join('\n');
  assert.deepEqual(range(twoLists), [], 'two short lists are not one procedure');
});

test('automation: only an imperative to run a tool on every event is a make-hook candidate', () => {
  assert.equal(of(mainResult, 'automation-in-memory').length, 0, 'a line that may be a trigger is never a finding');
  const automation = candidatesOf(mainResult, 'automation-in-memory');
  assert.deepEqual(
    automation.map((candidate) => [candidate.line, candidate.data?.command ?? null]),
    [
      [19, 'npm test'],
      [20, null],
      [21, null],
    ],
    'the command a line quotes is kept for the reader',
  );
  assert.ok(automation[0].why.includes(SOURCES.hooks));
  assert.match(automation[1].message, /may describe/, 'it is worded as a question');
  assert.ok(automation.every((candidate) => candidate.suggestion.kind === 'make-hook'));

  for (const line of [
    'Always run the linter before you commit.',
    'Whenever a file changes, lint it.',
    'Run `npm run lint` after each edit.',
    'Lint and format on save.',
    'Before committing, run the tests.',
    'After editing a TypeScript file, format it with prettier.',
    'Pred každým commitom spusti testy.',
    'Po každej úprave spusti `npm test`.',
  ]) {
    assert.ok(matchAutomation(line), line);
  }
  assert.deepEqual(matchAutomation('Run `npm run lint` after each edit.'), { command: 'npm run lint' });
  assert.deepEqual(matchAutomation('Lint and format on save.'), { command: null });

  for (const line of [
    'Always format dates as ISO 8601.',
    'Always use the test database for local work.',
    'Always write the test first.',
    'Always ask before you run a migration.',
    'Before you build a feature, ask what the success criteria are.',
    'Always explain what a command does before you run it.',
    'Always ask before you run the tests.',
    'Before you run the build, check which branch you are on.',
    'After a failed test run, always say which test failed.',
    'Whenever possible, prefer composition; test behaviour, not implementation.',
    'Always use tabs for indentation.',
    'Never run the formatter after a merge.',
    'Run the tests.',
    'Always build on existing patterns.',
    'Vždy spusti migrácie cez skript.',
  ]) {
    assert.equal(matchAutomation(line), null, line);
  }
});

test('a line that may map a phrase to an action is a candidate, told apart from other conditions', () => {
  assert.equal(of(mainResult, 'repeated-request').length, 0);
  assert.deepEqual(
    candidatesOf(mainResult, 'repeated-request').map((candidate) => [candidate.line, candidate.suggestion.kind]),
    [[23, 'make-command']],
  );
  assert.ok(matchRepeatedRequest('If I say "wrap up", write the summary.'));
  assert.ok(matchRepeatedRequest('Keď napíšem "hotovo", zapíš to do denníka.'));
  assert.equal(matchRepeatedRequest('When the build fails, say so.'), false);
});

test('a line that may forbid a command is a candidate that names the whole command, and only a command', () => {
  assert.equal(of(mainResult, 'permission-in-prose').length, 0, 'a rule read from the words of a line was offered as a finding');
  const [permission] = candidatesOf(mainResult, 'permission-in-prose');
  assert.match(permission.message, /^This line may forbid running "git push --force" in prose only\.$/);
  assert.equal(permission.line, 22);
  assert.deepEqual(permission.data, { command: 'git push --force', list: 'deny', rule: 'Bash(git push --force *)' });
  assert.equal(permission.suggestion.kind, 'make-setting');
  assert.match(permission.suggestion.detail, /permissions\.deny rule for "git push --force"/);
  assert.ok(permission.suggestion.detail.includes('Bash(git push --force *)'), 'the rule is written in the documented format');
  assert.ok(permission.suggestion.detail.includes(SOURCES.permissions) && permission.why.includes(SOURCES.permissions));
  assert.equal(permissionRule('rm -rf'), 'Bash(rm -rf *)');

  const deny = (command) => ({ command, list: 'deny' });
  assert.deepEqual(matchPermission('Never run `rm -rf` in this repository.'), deny('rm -rf'));
  assert.deepEqual(matchPermission("Don't use `curl` for downloads."), deny('curl'));
  assert.deepEqual(matchPermission('Nikdy nespúšťaj `git reset --hard`.'), deny('git reset --hard'));
  assert.deepEqual(matchPermission('Never run git push --force on main.'), deny('git push --force'), 'not all of git');
  assert.deepEqual(matchPermission('Do not run docker compose down in production.'), deny('docker compose down'));
  assert.deepEqual(matchPermission('Nikdy nespúšťaj git push --force na hlavnej vetve.'), deny('git push --force'));

  for (const line of [
    'Never use emojis in replies.',
    'Never use `any` in TypeScript.',
    'Never run the tests in parallel.',
    'Never run migrations against production.',
    'Do not run destructive commands.',
    'Never run arbitrary scripts from the internet.',
    'Do not run database changes by hand.',
    'Never run long-running jobs in the foreground.',
    'Never run e2e suites locally.',
  ]) {
    assert.equal(matchPermission(line), null, line);
  }
});

test('"without asking" is a permissions.ask rule, not a deny rule', (t) => {
  const ask = (command) => ({ command, list: 'ask' });
  assert.deepEqual(matchPermission('Do not run sudo without asking.'), ask('sudo'));
  assert.deepEqual(matchPermission('Never run npm install without asking first.'), ask('npm install'));
  assert.deepEqual(matchPermission('Never run `git push` without my confirmation.'), ask('git push'));
  assert.deepEqual(matchPermission('Nikdy nespúšťaj `npm publish` bez opýtania.'), ask('npm publish'));

  const { local, result } = checkMemory(t, '# Rules\n\n- Never run npm install without asking first.\n');
  const [finding] = candidatesOf(result, 'permission-in-prose');
  assert.deepEqual(finding.data, { command: 'npm install', list: 'ask', rule: 'Bash(npm install *)' });
  assert.match(finding.suggestion.detail, /permissions\.ask rule for "npm install"/);
  assert.match(finding.message, /confirmation/);
  const slovak = runChecks(scan({ home: local.home }), { lang: 'sk' });
  assert.match(candidatesOf(slovak, 'permission-in-prose')[0].suggestion.detail, /permissions\.ask/);

  const settings = path.join(local.home, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify({ permissions: { ask: ['Bash(npm install:*)'] } }));
  assert.equal(candidatesOf(runChecks(scan({ home: local.home })), 'permission-in-prose').length, 0, 'an ask rule settles a line that wants a confirmation');
});

test('a memory file may import a rule, skill or agent file: it is counted and checked as loaded text', (t) => {
  const local = materialise('main');
  t.after(() => local.cleanup());
  const user = `${local.home}/.claude/CLAUDE.md`;
  const alpha = `${local.project('alpha-service')}/CLAUDE.md`;
  const extra = `${local.home}/.claude/rules/extra.md`;
  writeFileSync(user, '# User\n\n- Keep answers short and direct.\n\n@rules/style.md\n@agents/reviewer.md\n@rules/extra.md\n');
  writeFileSync(extra, '---\ndescription: Never run `rm -rf` here.\n---\n\n- Never run `git clean` in a shared folder.\n');
  writeFileSync(alpha, '# alpha-service\n\n- Name files in kebab-case.\n\n@.claude/rules/api.md\n');

  const result = runChecks(scan({ home: local.home, projects: [local.projects] }));
  const loaded = (project) => result.alwaysLoaded.find((group) => group.project === project).files.map((file) => file.label);
  // An imported rule file loads as an import, whatever its paths say; the one rule file without a
  // paths pattern that nothing imports loads on its own, after them.
  assert.deepEqual(loaded(null), [
    '~/.claude/CLAUDE.md',
    '~/.claude/rules/style.md',
    '~/.claude/agents/reviewer.md',
    '~/.claude/rules/extra.md',
    '~/.claude/rules/deep/naming.md',
  ]);
  const roles = result.alwaysLoaded.find((group) => group.project === null).files.map((file) => file.role);
  assert.deepEqual(roles, ['memory', 'import', 'import', 'import', 'rule']);
  assert.ok(loaded(local.project('alpha-service')).includes('alpha-service/.claude/rules/api.md'));
  const lines = (label) => result.files.find((file) => file.label === label).lines;
  assert.equal(
    result.metrics.alwaysLoadedLines.user,
    7 + lines('~/.claude/rules/style.md') + lines('~/.claude/agents/reviewer.md') + 5 + lines('~/.claude/rules/deep/naming.md'),
  );

  const [across] = of(result, 'duplicate-across');
  assert.equal(across.file, alpha, 'a line of the project file repeats a line of the imported rule file');
  assert.equal(across.related[0].file, `${local.home}/.claude/rules/style.md`);
  assert.deepEqual(
    candidatesOf(result, 'permission-in-prose').map((candidate) => [candidate.file, candidate.line, candidate.data.command]),
    [[extra, 5, 'git clean']],
    'the body of an imported rule file is checked, its front matter is not',
  );

  const scanFile = path.join(local.root, 'scan.json');
  writeFileSync(scanFile, JSON.stringify(scan({ home: local.home, projects: [local.projects] })));
  assert.equal(runScript('checks.mjs', ['--scan', scanFile]).status, 0, 'the command line does not crash either');
});

test('a prohibition is settled only by a rule that covers its command, in settings that apply to the file', (t) => {
  // The scan keeps no text of a rule, so the rules are where they are in real life: in the files.
  const local = materialise('main');
  t.after(() => local.cleanup());
  const userFile = path.join(local.home, '.claude', 'settings.json');
  const alphaFile = path.join(local.project('alpha-service'), '.claude', 'settings.json');
  const originals = new Map([userFile, alphaFile].map((file) => [file, readFileSync(file, 'utf8')]));
  const open = (file, list, rule) => {
    for (const [name, original] of originals) writeFileSync(name, original);
    const settings = JSON.parse(originals.get(file));
    settings.permissions[list] = [...(settings.permissions[list] ?? []), rule];
    writeFileSync(file, JSON.stringify(settings));
    const scanned = scan({ home: local.home, projects: [local.projects] });
    assert.ok(!JSON.stringify(scanned).includes(rule), 'the text of a rule is kept in the scan');
    return candidatesOf(runChecks(scanned), 'permission-in-prose').length;
  };

  assert.equal(open(userFile, 'deny', 'Bash(git push --force:*)'), 0);
  assert.equal(open(userFile, 'deny', 'Bash(git push:*)'), 0, 'a wider rule covers it');
  assert.equal(open(userFile, 'deny', 'Bash(git push --force-with-lease:*)'), 1);
  assert.equal(open(userFile, 'deny', 'Bash(legit push --forceful:*)'), 1, 'a substring is not a match');
  assert.equal(open(userFile, 'deny', 'Read(git push --force)'), 1, 'a rule for another tool');
  assert.equal(open(userFile, 'ask', 'Bash(git push --force:*)'), 1, 'asking is weaker than forbidding');
  assert.equal(open(alphaFile, 'deny', 'Bash(git push --force:*)'), 1, 'a rule in one project does not settle a line of the user file');

  // The documented format: Tool or Tool(specifier), "*" for any text.
  assert.equal(open(userFile, 'deny', 'Bash(git push --force *)'), 0);
  assert.equal(open(userFile, 'deny', 'Bash(git push *)'), 0);
  assert.equal(open(userFile, 'deny', 'Bash(git * --force)'), 0);
  assert.equal(open(userFile, 'deny', 'Bash(git pull *)'), 1);
  assert.equal(open(userFile, 'deny', 'tool:shell:run:git push*'), 1, 'not a format of permission rules');

  // A settings file that goes away after the scan is not taken for one without rules.
  for (const [name, original] of originals) writeFileSync(name, original);
  const settings = JSON.parse(originals.get(userFile));
  settings.permissions.deny = ['Bash(git push *)'];
  writeFileSync(userFile, JSON.stringify(settings));
  const stale = scan({ home: local.home, projects: [local.projects] });
  writeFileSync(userFile, '{ not json');
  assert.throws(() => runChecks(stale), /Cannot read .*settings\.json, which the scan lists as valid settings/);

  assert.equal(ruleCoversCommand('Bash(terraform destroy *)', 'rm'), false);
  assert.equal(ruleCoversCommand('Bash(rm *)', 'rm -rf'), true);
  assert.equal(ruleCoversCommand('Bash(rm *)', 'rmdir'), false, 'the space before the star ends the word');
  assert.equal(ruleCoversCommand('Bash(rm -rf *)', 'rm -rf'), true);
  assert.equal(ruleCoversCommand('Bash(rm -rf)', 'rm -rf'), true);
  assert.equal(ruleCoversCommand('Bash(*)', 'rm -rf'), true);
  assert.equal(ruleCoversCommand('Bash', 'rm -rf'), true);
  assert.equal(ruleCoversCommand('PowerShell(Remove-Item *)', 'Remove-Item'), true);
  assert.equal(ruleCoversCommand('Bash(rm -rf /tmp/x)', 'rm -rf'), false, 'a narrower rule does not cover the command');
  assert.equal(ruleCoversCommand('Bash(a.c *)', 'abc'), false, 'a dot in a rule is a dot');
  // The older spelling of a prefix is still in settings files, and is read so that an existing rule is not called missing.
  assert.equal(ruleCoversCommand('Bash(terraform destroy:*)', 'rm'), false);
  assert.equal(ruleCoversCommand('Bash(rm:*)', 'rm -rf'), true);
  for (const notARule of ['tool:shell:run:rm *', 'tool:file:write:rm*', 'Read(rm -rf)', 'mcp__rm', '', 'Bash(rm']) {
    assert.equal(ruleCoversCommand(notARule, 'rm'), false, notARule);
  }
});

test('a user-file line that may be about one project is a move-to-project candidate', () => {
  assert.equal(of(mainResult, 'project-specific-in-user').length, 0, 'a line matched by a word was reported as a finding');
  const candidates = candidatesOf(mainResult, 'project-specific-in-user');
  assert.deepEqual(
    candidates.map((candidate) => [candidate.line, candidate.data.project, candidate.data.reason, candidate.data.projectPath]),
    [
      [19, 'alpha-service', 'stack', main.project('alpha-service')],
      [37, 'alpha-service', 'name', main.project('alpha-service')],
      [38, 'beta-tool', 'stack', main.project('beta-tool')],
    ],
  );
  assert.ok(candidates.every((candidate) => candidate.suggestion.kind === 'move-to-project'));
  assert.match(candidates[0].message, /^This line of the user memory file may be about one project \(alpha-service\)/);

  const one = runChecks(scan({ home: main.home, projects: [main.project('beta-tool')] }));
  assert.deepEqual(
    candidatesOf(one, 'project-specific-in-user').map((candidate) => candidate.line),
    [],
    'with one scanned project a stack cannot be said to belong to exactly one',
  );
});

test('skills: only what a program can prove', () => {
  const skill = (check) => of(mainResult, check).map((finding) => path.basename(path.dirname(finding.file)));
  assert.deepEqual(skill('skill-no-description'), ['no-description']);
  // Whether a description says when to use the skill is a matter of its words: a candidate.
  assert.deepEqual(skill('skill-no-when-cue'), []);
  const [cue] = candidatesOf(mainResult, 'skill-no-when-cue');
  assert.deepEqual([path.basename(path.dirname(cue.file)), cue.quote, cue.data.description], ['vague-skill', 'description: Formats tables.', 'Formats tables.']);
  assert.match(cue.message, /may not say when/);
  assert.deepEqual(skill('skill-name-mismatch'), ['wrong-name']);
  assert.deepEqual(skill('skill-too-long'), ['long-skill']);
  assert.deepEqual(skill('skill-description-too-long'), ['wordy-skill']);
  assert.deepEqual(skill('skill-unreachable'), ['unreachable-skill']);
  const [twice] = of(mainResult, 'skill-copies-differ');
  assert.ok(twice.file.includes('alpha-service/.claude/skills/shared-skill'));
  assert.ok(twice.related[0].file.includes('home/.claude/skills/shared-skill'));
  assert.equal(twice.severity, 'low');
  assert.ok(!/only one of them|is used by|takes precedence|wins/i.test(`${twice.message} ${twice.why.replace('does not say which of the two is used', '')}`), 'the finding does not claim which copy runs');
  assert.equal(of(mainResult, 'skill-name-mismatch')[0].quote, 'name: other-name');
  assert.ok(of(mainResult, 'skill-too-long')[0].why.includes(SOURCES.skills));
  assert.match(of(mainResult, 'skill-description-too-long')[0].message, /1536/);
  assert.equal(of(mainResult, 'skill-no-description')[0].quote, null);
});

test('front matter that cannot be read is reported, readable front matter is not', (t) => {
  const local = materialise('clean');
  t.after(() => local.cleanup());
  writeFileSync(path.join(local.home, '.claude', 'skills', 'tidy-skill', 'SKILL.md'), '---\nname: tidy-skill\nthis line is not yaml\n---\n');
  const result = runChecks(scan({ home: local.home }));
  assert.equal(of(result, 'front-matter-unreadable').length, 1);
  assert.equal(of(cleanResult, 'front-matter-unreadable').length, 0);
  assert.equal(of(mainResult, 'front-matter-unreadable').length, 0);
});

test('commands and agents without a description', () => {
  assert.deepEqual(
    of(mainResult, 'command-no-description').map((finding) => path.basename(finding.file)),
    ['deploy.md'],
  );
  assert.deepEqual(
    of(mainResult, 'agent-no-description').map((finding) => path.basename(finding.file)),
    ['helper.md'],
  );
});

test('copies of one skill: equal copies are no finding, copies that differ are one', (t) => {
  const local = materialise('main');
  t.after(() => local.cleanup());
  const user = path.join(local.home, '.claude', 'skills', 'shared-skill', 'SKILL.md');
  const project = path.join(local.project('alpha-service'), '.claude', 'skills', 'shared-skill', 'SKILL.md');
  const differ = (result) => of(result, 'skill-copies-differ').length;
  assert.equal(differ(runChecks(scan({ home: local.home, projects: [local.projects] }))), 1);

  writeFileSync(project, readFileSync(user, 'utf8'));
  assert.equal(differ(runChecks(scan({ home: local.home, projects: [local.projects] }))), 0, 'equal copies are listed with the skills, not reported');

  // The same text with the line endings of another checkout is still the same text.
  writeFileSync(project, readFileSync(user, 'utf8').replace(/\n/g, '\r\n'));
  const crlf = scan({ home: local.home, projects: [local.projects] });
  const hashes = crlf.files.filter((file) => file.kind === 'skill' && file.name === 'shared-skill').map((file) => file.contentSha);
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], hashes[1]);
  assert.match(hashes[0], /^[0-9a-f]{64}$/);
  assert.equal(differ(runChecks(crlf)), 0);
});

test('settings: invalid JSON and hooks', () => {
  const [invalid] = of(mainResult, 'settings-invalid-json');
  assert.ok(invalid.file.endsWith('settings.local.json'));
  assert.equal(invalid.severity, 'high');
  assert.equal(invalid.quote, null);

  const [missing] = of(mainResult, 'hook-missing-file');
  assert.equal(missing.data.event, 'PostToolUse');
  assert.ok(missing.data.file.endsWith('home/.claude/hooks/missing-hook.py'));
  assert.equal(missing.quote, 'python3 ~/.claude/hooks/missing-hook.py ***');
  assert.equal(of(mainResult, 'hook-missing-file').length, 1, 'existing hook scripts are not reported');

  const [unknown] = of(mainResult, 'hook-unknown-event');
  assert.equal(unknown.data.event, 'AfterEverything');
  assert.equal(unknown.severity, 'low');
  assert.match(unknown.message, /not in the list of 33 event names this tool knows/);
  assert.match(unknown.why, /a newer Claude Code may know more events/);
  assert.deepEqual(
    [missing.suggestion.kind, unknown.suggestion.kind],
    ['make-setting', 'make-setting'],
    'a broken hook is fixed in the settings file; it is not a line to turn into a hook',
  );
  assert.ok(!JSON.stringify(mainResult).includes('FIXTURE-SECRET-VALUE'), 'a secret value leaked into the findings');
});

test('to review: an MCP server of a project that no permission rule names; not a finding, no severity, no suggestion', (t) => {
  assert.deepEqual(
    mainResult.review.map((item) => [item.check, item.file, item.project, item.servers]),
    [['mcp-no-permission-rule', `${main.project('alpha-service')}/.mcp.json`, main.project('alpha-service'), ['tracker', 'search']]],
  );
  const [item] = mainResult.review;
  assert.match(item.id, /^mcp-no-permission-rule-[0-9a-f]{10}$/);
  for (const field of ['severity', 'suggestion', 'quote']) assert.equal(field in item, false, `a review item has no ${field}`);
  assert.match(item.message, /tracker, search/);
  assert.ok(item.why.includes(SOURCES.mcp) && item.why.includes(SOURCES.permissions));
  assert.equal(mainResult.metrics.review, 1);
  assert.ok(mainResult.findings.every((finding) => !finding.check.startsWith('mcp')));

  // A rule in allow, ask or deny of any settings file in effect names the server.
  const local = materialise('main');
  t.after(() => local.cleanup());
  const reviewed = (write) => {
    write();
    return runChecks(scan({ home: local.home, projects: [local.projects] })).review.flatMap((entry) => entry.servers);
  };
  const projectLocal = path.join(local.project('alpha-service'), '.claude', 'settings.local.json');
  assert.deepEqual(
    reviewed(() => writeFileSync(projectLocal, JSON.stringify({ permissions: { ask: ['mcp__tracker'] } }))),
    ['search'],
    'a rule in the local settings of the project counts',
  );
  const userSettings = path.join(local.home, '.claude', 'settings.json');
  assert.deepEqual(
    reviewed(() => writeFileSync(userSettings, JSON.stringify({ permissions: { deny: ['mcp__search__delete_index'] } }))),
    [],
    'a rule for one tool of the server names the server',
  );
  assert.deepEqual(
    reviewed(() => writeFileSync(userSettings, JSON.stringify({ permissions: { allow: ['mcp__searching', 'Bash(mcp__search *)'] } }))),
    ['search'],
    'a rule for another server, or for a shell command, does not',
  );
  // A rule in another project is not in effect here.
  const beta = path.join(local.project('beta-tool'), '.claude');
  mkdirSync(beta, { recursive: true });
  assert.deepEqual(
    reviewed(() => writeFileSync(path.join(beta, 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__search'] } }))),
    ['search'],
  );

  assert.equal(ruleNamesServer('mcp__tracker', 'tracker'), true);
  assert.equal(ruleNamesServer('mcp__tracker__*', 'tracker'), true);
  assert.equal(ruleNamesServer('mcp__tracker__create_issue', 'tracker'), true);
  assert.equal(ruleNamesServer('mcp__tracker2', 'tracker'), false);
  assert.equal(ruleNamesServer('tracker', 'tracker'), false);
});

test('the user-level file that can also configure MCP servers is never read', (t) => {
  const local = materialise('clean');
  t.after(() => local.cleanup());
  writeFileSync(path.join(local.home, '.claude.json'), JSON.stringify({ mcpServers: { 'USER-LEVEL-SERVER': { command: 'x' } }, marker: 'USER-LEVEL-MARKER' }));
  const result = scan({ home: local.home, projects: [local.projects], machine: true });
  const everything = JSON.stringify([result, runChecks(result)]);
  assert.ok(!everything.includes('USER-LEVEL-'), 'something of ~/.claude.json reached the result');
  assert.ok(!everything.includes('.claude.json'), 'the file is named in the result');
});

test('a hook is reported as missing only when its own script is missing', (t) => {
  const local = materialise('clean');
  t.after(() => local.cleanup());
  const project = local.project('tidy-app');
  const command = (text) => ({ hooks: [{ type: 'command', command: text }] });
  mkdirSync(path.join(project, 'tools'), { recursive: true });
  mkdirSync(path.join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(path.join(project, 'tools', 'present.sh'), 'exit 0\n');
  writeFileSync(path.join(project, '.claude', 'hooks', 'present.py'), 'pass\n');
  writeFileSync(
    path.join(project, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [
          command('npx eslint --config=eslint.config.js --fix'),
          command('curl -s https://example.test/install.sh'),
          command('prettier --write src/index.ts'),
          command('bash tools/present.sh'),
          command('python3 "$CLAUDE_PROJECT_DIR"/.claude/hooks/present.py'),
          command('bash tools/*.sh'),
          command('bash $OTHER_DIR/run.sh'),
          command('python3 "$CLAUDE_PROJECT_DIR"/.claude/hooks/absent.py --fast'),
          command('bash tools/absent.sh; echo done'),
          command('./tools/gone.sh'),
        ],
      },
    }),
  );
  writeFileSync(
    path.join(local.home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          command('bash ~/.claude/hooks/gone.sh; echo done'),
          command('bash relative/unknown.sh'),
          // A path with a masked part cannot be looked up, so nothing is claimed about it.
          command('bash ~/.claude/hooks/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8/run.sh'),
        ],
      },
    }),
  );

  const result = runChecks(scan({ home: local.home, projects: [local.projects] }));
  assert.deepEqual(
    of(result, 'hook-missing-file')
      .map((finding) => finding.data.file.slice(local.root.length + 1))
      .sort(),
    [
      'home/.claude/hooks/gone.sh',
      'projects/tidy-app/.claude/hooks/absent.py',
      'projects/tidy-app/tools/absent.sh',
      'projects/tidy-app/tools/gone.sh',
    ],
  );
});

test('a hook written with a Git Bash drive path is found on Windows', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Git Bash drive paths exist on Windows only');
    return;
  }
  const local = materialise('clean');
  t.after(() => local.cleanup());
  const script = `${local.home}/.claude/hooks/guard.sh`;
  const gitBash = script.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  writeFileSync(
    path.join(local.home, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `bash ${gitBash}` }] }] } }),
  );
  assert.equal(of(runChecks(scan({ home: local.home })), 'hook-missing-file').length, 0);
});

test('imports: unresolved paths and chains over the documented depth', () => {
  const [unresolved] = of(mainResult, 'import-unresolved');
  assert.equal(unresolved.line, 43);
  assert.match(unresolved.message, /shared\/missing\.md/);
  const [deep] = of(mainResult, 'import-too-deep');
  assert.ok(deep.file.endsWith('shared/chain-4.md'));
  assert.equal(deep.quote, '@chain-5.md');
  assert.match(deep.message, /hop 5/);
  assert.ok(deep.why.includes(SOURCES.memory));
});

test('metrics count what the setup holds', () => {
  const { metrics } = mainResult;
  assert.equal(metrics.files, mainScan.files.length);
  assert.equal(metrics.skills, 9);
  assert.equal(metrics.commands, 3);
  assert.equal(metrics.agents, 3);
  assert.equal(metrics.hooks, 4);
  assert.equal(metrics.totalLines, 238 + 4 + 20 + 172 + 12 + 3 + 3 + 4 + 6);
  assert.equal(metrics.findings.high + metrics.findings.medium + metrics.findings.low, mainResult.findings.length);
  assert.equal(mainResult.limits.memoryFileLines.value, 200);
  assert.equal(mainResult.limits.alwaysLoadedLines.documented, false);
  const row = mainResult.files.find((file) => file.path === userMemory());
  assert.deepEqual([row.lines, row.limit, row.label], [238, 200, '~/.claude/CLAUDE.md']);
});

test('findings are sorted by severity, and Slovak output keeps the same ids', () => {
  const order = { high: 0, medium: 1, low: 2 };
  const ranks = mainResult.findings.map((finding) => order[finding.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));

  const slovak = runChecks(mainScan, { lang: 'sk' });
  assert.deepEqual(
    slovak.findings.map((finding) => finding.id),
    mainResult.findings.map((finding) => finding.id),
  );
  assert.match(of(slovak, 'memory-too-long')[0].message, /238 riadkov/);
  assert.notEqual(slovak.findings[0].message, mainResult.findings[0].message);
  assert.throws(() => runChecks(mainScan, { lang: 'de' }), /Unknown language/);
});

test('ids do not depend on line numbers, and a stale scan is refused', (t) => {
  const local = materialise('main');
  t.after(() => local.cleanup());
  const file = path.join(local.home, '.claude', 'CLAUDE.md');
  const before = runChecks(scan({ home: local.home, projects: [local.projects] }));
  const staleScan = scan({ home: local.home, projects: [local.projects] });
  writeFileSync(file, `\n${readFileSync(file, 'utf8')}`);
  assert.throws(() => runChecks(staleScan), /changed since the scan/);
  const shifted = runChecks(scan({ home: local.home, projects: [local.projects] }));
  const ids = (result) => result.findings.map((finding) => finding.id).sort();
  assert.deepEqual(ids(shifted), ids(before));
  assert.equal(of(shifted, 'duplicate-within')[0].line, 11);
});

test('CLI reads a scan file and prints findings as JSON', () => {
  const scanFile = path.join(main.root, 'scan.json');
  writeFileSync(scanFile, JSON.stringify(mainScan));
  const result = runJson('checks.mjs', ['--scan', scanFile, '--lang', 'sk']);
  assert.equal(result.lang, 'sk');
  assert.equal(result.findings.length, mainResult.findings.length);
  assert.equal(result.metrics.skills, 9);

  const bad = runScript('checks.mjs', ['--scan', scanFile, '--lang', 'xx']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown language/);
  const missing = runScript('checks.mjs', []);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--scan/);
});
