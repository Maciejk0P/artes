// What loads at session start and what it costs: the context tax, the auto memory index (size
// only), files switched off by claudeMdExcludes, AGENTS.md, and what a reader makes of candidates.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { SCRIPTS, load, materialise } from './helpers/fixtures.mjs';

const { ruleCoversCommand, runChecks } = await load('checks.mjs');
const { LIMITS } = await load('lib/facts.mjs');
const { autoMemoryDirName, autoMemoryIndex } = await load('lib/automemory.mjs');
const { globMatcher } = await load('lib/glob.mjs');
const { buildView } = await load('lib/view.mjs');
const { renderStateView } = await load('report.mjs');
const { scan } = await load('scan.mjs');

let main;
let field;
let mainScan;
let mainChecks;

before(() => {
  main = materialise('main');
  field = materialise('field');
  mainScan = scan({ home: main.home, projects: [main.projects] });
  mainChecks = runChecks(mainScan);
});
after(() => {
  main.cleanup();
  field.cleanup();
});

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const taxOf = (checks, project) => checks.contextTax.find((place) => place.project === project);
const tokens = (bytes) => Math.ceil(bytes / 4);

// --- context tax --------------------------------------------------------------------------------

test('context tax: per place, every file that loads at launch plus the listing of skills and commands', () => {
  assert.deepEqual(
    mainChecks.contextTax.map((place) => [place.key, place.project]),
    [
      ['user', null],
      [main.project('alpha-service'), main.project('alpha-service')],
      [main.project('beta-tool'), main.project('beta-tool')],
    ],
  );
  const alpha = taxOf(mainChecks, main.project('alpha-service'));
  const loaded = mainChecks.alwaysLoaded.find((group) => group.project === main.project('alpha-service'));
  const fileParts = alpha.parts.filter((part) => part.path);
  assert.deepEqual(
    fileParts.map((part) => [part.path, part.type]),
    loaded.files.map((file) => [file.path, file.role]),
    'the files of the tax are the files that load at launch, in the same order',
  );
  for (const part of fileParts) {
    assert.equal(part.bytes, statSync(part.path).size, part.label);
    assert.equal(part.tokens, tokens(part.bytes), part.label);
  }
  assert.ok(fileParts.some((part) => part.type === 'rule' && part.label === '~/.claude/rules/deep/naming.md'), 'a rule file without paths is part of the tax');
  assert.ok(!alpha.parts.some((part) => part.label === '~/.claude/rules/style.md'), 'a rule file with a paths pattern is not');
  assert.ok(!alpha.parts.some((part) => part.label?.includes('packages/web')), 'a nested memory file loads on demand and is not');

  const listing = (place, type) => place.parts.find((part) => part.type === type);
  // Eight user skills, one of them hidden from the model, plus the one of the project.
  assert.deepEqual([listing(alpha, 'skill-listing').count, listing(alpha, 'skill-listing').hidden], [8, 1]);
  assert.equal(listing(alpha, 'command-listing').count, 3);
  assert.equal(listing(taxOf(mainChecks, null), 'skill-listing').count, 7);
  assert.equal(listing(taxOf(mainChecks, main.project('beta-tool')), 'command-listing').count, 2);

  for (const place of mainChecks.contextTax) {
    assert.equal(place.tokens, place.parts.reduce((sum, part) => sum + part.tokens, 0), 'the parts add up to the total');
    assert.equal(place.bytes, place.parts.reduce((sum, part) => sum + part.bytes, 0));
    assert.deepEqual(place.notCounted, ['agent-descriptions']);
    assert.equal(mainChecks.metrics.contextTokens[place.key], place.tokens);
  }
  assert.ok(taxOf(mainChecks, main.project('alpha-service')).tokens > taxOf(mainChecks, null).tokens);
  assert.equal(taxOf(mainChecks, null).autoMemory, null, 'the user files alone have no project and so no auto memory');
  assert.equal(mainChecks.limits.bytesPerToken.documented, false, 'bytes per token is a default of this tool');
});

test('the listing counts name, description and when_to_use, at most 1,536 characters of text for each', (t) => {
  const local = materialise('clean');
  t.after(() => local.cleanup());
  const skills = path.join(local.home, '.claude', 'skills');
  rmSync(skills, { recursive: true });
  rmSync(path.join(local.home, '.claude', 'commands'), { recursive: true });
  const listing = () => {
    const place = taxOf(runChecks(scan({ home: local.home })), null);
    return place.parts.find((part) => part.type === 'skill-listing') ?? null;
  };
  assert.equal(listing(), null, 'no skills, no listing');

  write(path.join(skills, 'short-one', 'SKILL.md'), '---\nname: short-one\ndescription: Does a thing.\nwhen_to_use: Use when asked.\n---\n\nBody text that is not listed.\n');
  assert.deepEqual(listing(), { type: 'skill-listing', count: 1, hidden: 0, bytes: 'short-one Does a thing. Use when asked.'.length, tokens: 10 });

  write(path.join(skills, 'long-one', 'SKILL.md'), `---\nname: long-one\ndescription: ${'x'.repeat(4000)}\n---\n`);
  const both = listing();
  assert.equal(both.count, 2);
  assert.equal(both.bytes, 'short-one Does a thing. Use when asked.'.length + 'long-one '.length + LIMITS.skillDescriptionChars.value);

  write(path.join(skills, 'hidden-one', 'SKILL.md'), `---\nname: hidden-one\ndescription: ${'y'.repeat(900)}\ndisable-model-invocation: true\n---\n`);
  const withHidden = listing();
  assert.deepEqual([withHidden.count, withHidden.hidden, withHidden.bytes], [2, 1, both.bytes], 'a skill the model is not offered adds nothing');

  // Descriptions of agents are not counted, whatever their size.
  const beforeAgent = taxOf(runChecks(scan({ home: local.home })), null).tokens;
  write(path.join(local.home, '.claude', 'agents', 'chatty.md'), `---\nname: chatty\ndescription: ${'z'.repeat(5000)}\n---\n`);
  assert.equal(taxOf(runChecks(scan({ home: local.home })), null).tokens, beforeAgent);
});

// --- auto memory --------------------------------------------------------------------------------

function withAutoMemory(t, bytes) {
  const local = materialise('main');
  t.after(() => local.cleanup());
  const project = local.project('alpha-service');
  const folder = path.join(local.home, '.claude', 'projects', autoMemoryDirName(project));
  const line = '- AUTO-MEMORY-MARKER a remembered line of the index.\n';
  write(path.join(folder, 'memory', 'MEMORY.md'), `# AUTO-MEMORY-HEADING\n\n${line.repeat(Math.ceil(bytes / line.length))}`.slice(0, bytes));
  write(path.join(folder, 'memory', 'topic-notes.md'), '# TOPIC-MARKER\n\n- a note next to the index\n');
  write(path.join(folder, 'session-0001.jsonl'), '{"type":"user","text":"TRANSCRIPT-MARKER"}\n');
  write(path.join(folder, 'CLAUDE.md'), '# TRANSCRIPT-FOLDER-MARKER\n');
  return { local, project, folder };
}

test('auto memory index: its size is counted, capped at what loads; nothing of it or next to it is read', (t) => {
  const { local, project, folder } = withAutoMemory(t, 40000);
  const result = scan({ home: local.home, projects: [local.projects] });
  assert.deepEqual(
    result.autoMemory.map((entry) => [path.basename(entry.project), entry.found, entry.bytes]),
    [
      ['alpha-service', true, 40000],
      ['beta-tool', false, 0],
    ],
  );
  assert.equal(result.autoMemory[0].path, `${folder.replace(/\\/g, '/')}/memory/MEMORY.md`);

  const checks = runChecks(result);
  const alpha = taxOf(checks, project);
  assert.deepEqual(alpha.autoMemory, { path: result.autoMemory[0].path, found: true, bytes: 40000, counted: 25000 });
  const part = alpha.parts.find((entry) => entry.type === 'auto-memory');
  assert.deepEqual([part.bytes, part.tokens], [25000, 6250], 'only the first 25 KB load, so only they are counted');
  const beta = taxOf(checks, local.project('beta-tool'));
  assert.deepEqual([beta.autoMemory.found, beta.autoMemory.counted], [false, 0]);
  assert.ok(!beta.parts.some((entry) => entry.type === 'auto-memory'), 'a missing index counts for nothing');
  assert.equal(alpha.tokens - 6250, taxOf(runChecks(scan({ home: main.home, projects: [main.projects] })), main.project('alpha-service')).tokens);

  const view = buildView({ scan: result, checks, lang: 'en' });
  const html = renderStateView(view);
  const everything = JSON.stringify([result, checks, view]) + html;
  for (const marker of ['AUTO-MEMORY-MARKER', 'AUTO-MEMORY-HEADING', 'TOPIC-MARKER', 'TRANSCRIPT-MARKER', 'TRANSCRIPT-FOLDER-MARKER', 'topic-notes', 'session-0001']) {
    assert.ok(!everything.includes(marker), `${marker} reached the result`);
  }
  const listed = [...result.files, ...result.settings, ...result.skipped, ...result.linked].map((entry) => entry.path);
  assert.deepEqual(
    listed.filter((file) => file.includes('/.claude/projects/')),
    [],
    'a file of the per-project folders was listed',
  );
  assert.ok(!result.projects.some((entry) => entry.path.includes('/.claude/')), 'the folder of transcripts was taken for a project');
  assert.match(html, /Only its size was read/);

  // Not even when asked: the folders that hold transcripts are never scanned as projects.
  for (const asked of [path.join(local.home, '.claude', 'projects'), folder, path.join(folder, 'memory')]) {
    assert.throws(() => scan({ home: local.home, projects: [asked] }), /holds session data and is never scanned/, asked);
  }

  // Nor through the folder around them: with ~/.claude itself named as a project, the walk for
  // memory files in subfolders stays out of the session data.
  const around = scan({ home: local.home, projects: [path.join(local.home, '.claude')] });
  const aroundText = JSON.stringify([around, runChecks(around)]);
  for (const marker of ['TRANSCRIPT-FOLDER-MARKER', 'AUTO-MEMORY-HEADING', 'TOPIC-MARKER']) assert.ok(!aroundText.includes(marker), `${marker} was read`);
  assert.ok(!around.files.some((file) => file.path.includes('/.claude/projects/')), 'a file of the session data was listed');

  // A small index is counted whole.
  const small = withAutoMemory(t, 1200);
  const smallTax = taxOf(runChecks(scan({ home: small.local.home, projects: [small.local.projects] })), small.project);
  assert.deepEqual([smallTax.autoMemory.bytes, smallTax.autoMemory.counted], [1200, 1200]);
});

test('auto memory index: the folder name is derived one way, and a miss is "not found", never a guess', (t) => {
  assert.equal(autoMemoryDirName('C:\\work\\demo-app'), 'C--work-demo-app');
  assert.equal(autoMemoryDirName('C:/work/demo-app'), 'C--work-demo-app');
  assert.equal(autoMemoryDirName('/srv/work/demo app.v2'), '-srv-work-demo-app-v2');

  const local = materialise('main');
  t.after(() => local.cleanup());
  const project = local.project('alpha-service');
  // An index under a folder with a near-miss name is not the index of this project.
  write(path.join(local.home, '.claude', 'projects', 'alpha-service', 'memory', 'MEMORY.md'), '# NEAR-MISS\n');
  write(path.join(local.home, '.claude', 'projects', `${autoMemoryDirName(project)}-old`, 'memory', 'MEMORY.md'), '# NEAR-MISS\n');
  const found = autoMemoryIndex(local.home, project);
  assert.deepEqual([found.found, found.bytes], [false, 0]);
  assert.ok(found.path.endsWith(`/.claude/projects/${autoMemoryDirName(project)}/memory/MEMORY.md`));
  const view = buildView({ scan: scan({ home: local.home, projects: [local.projects] }), checks: runChecks(scan({ home: local.home, projects: [local.projects] })), lang: 'en' });
  const place = view.contextTax.places.find((entry) => entry.project === project);
  assert.equal(place.autoMemory.found, false);
  assert.match(place.autoMemory.text, /not found at .*MEMORY\.md\. Nothing was counted for it and nothing else was looked for\./);
  // A folder where the index should be is not an index.
  mkdirSync(path.join(local.home, '.claude', 'projects', autoMemoryDirName(project), 'memory', 'MEMORY.md'), { recursive: true });
  assert.equal(autoMemoryIndex(local.home, project).found, false);
});

test('auto memory index: the module asks for the size of one file and can do nothing else; only tokens.mjs reads transcripts', () => {
  const source = readFileSync(path.join(SCRIPTS, 'lib', 'automemory.mjs'), 'utf8');
  const fsImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs'/g)].flatMap((match) => match[1].split(',').map((name) => name.trim()));
  assert.deepEqual(fsImports, ['lstatSync'], 'the module imports more of the file system than the one call it needs');
  assert.ok(!/from\s*'node:fs\/promises'|\bimport\(/.test(source));
  for (const call of ['readFileSync', 'readdirSync', 'opendirSync', 'openSync', 'createReadStream', 'readFile', 'readdir', 'scandir', 'existsSync']) {
    assert.ok(!source.includes(call), `automemory.mjs mentions ${call}`);
  }
  // No other module names the per-project folders of the home configuration.
  const modules = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? modules(path.join(dir, entry.name)) : entry.name.endsWith('.mjs') ? [path.join(dir, entry.name)] : [],
    );
  for (const file of modules(SCRIPTS)) {
    if (path.basename(file) === 'automemory.mjs') continue;
    // The token report is the one reader of transcripts (decided 8 Oct 2026), and it only reads.
    if (path.relative(SCRIPTS, file) === 'tokens.mjs') {
      const tokens = readFileSync(file, 'utf8');
      const reads = [...tokens.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs'/g)].flatMap((match) => match[1].split(',').map((name) => name.trim()));
      assert.deepEqual(reads.sort(), ['readFileSync', 'readdirSync', 'statSync'], 'tokens.mjs imports more of the file system than reading');
      assert.ok(!/from\s*'node:fs\/promises'|\bimport\(|child_process|apply\.mjs/.test(tokens), 'tokens.mjs reaches for more than reading');
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const code = text.replace(/\/\/.*$/gm, '');
    assert.ok(!/\.claude['"`]?\s*[,/\\+]\s*['"`]?projects\b/.test(code), `${path.basename(file)} builds a path into the projects folder of the home configuration`);
    assert.ok(!/MEMORY\.md/.test(code) || path.basename(file) === 'facts.mjs', `${path.basename(file)} names the index file in code`);
    assert.ok(!/\.jsonl/.test(text), `${path.basename(file)} names a transcript`);
  }
});

test('auto memory index: a file that cannot be opened is still measured (where the platform has permission bits)', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('needs permission bits that the current user cannot bypass');
    return;
  }
  const { local, project, folder } = withAutoMemory(t, 3000);
  const index = path.join(folder, 'memory', 'MEMORY.md');
  // No read permission on the file; search-only permission on the two folders, so listing them fails.
  chmodSync(index, 0o000);
  chmodSync(path.join(folder, 'memory'), 0o100);
  chmodSync(folder, 0o100);
  t.after(() => {
    chmodSync(folder, 0o700);
    chmodSync(path.join(folder, 'memory'), 0o700);
    chmodSync(index, 0o600);
  });
  assert.throws(() => readFileSync(index), /EACCES/, 'the test file can be read, so the test proves nothing');
  assert.throws(() => readdirSync(folder), /EACCES/);
  const result = scan({ home: local.home, projects: [local.projects] });
  assert.deepEqual([result.autoMemory[0].found, result.autoMemory[0].bytes], [true, 3000]);
  assert.deepEqual(
    result.skipped.filter((entry) => entry.path.includes('/.claude/projects/')),
    [],
    'the scanner tried to enter the folder',
  );
  assert.equal(taxOf(runChecks(result), project).autoMemory.counted, 3000);
});

// --- claudeMdExcludes ---------------------------------------------------------------------------

test('claudeMdExcludes: every settings layer in effect counts, the lists add up, and an excluded file brings no imports', (t) => {
  const local = materialise('field');
  t.after(() => local.cleanup());
  const outer = local.project('outer-app');
  const group = (checks, project) => checks.alwaysLoaded.find((entry) => entry.project === project);
  const labels = (checks, project) => group(checks, project).files.map((file) => file.label);
  const excluded = (checks, project) => group(checks, project).excluded.map((file) => [file.label, file.pattern]);
  const run = () => runChecks(scan({ home: local.home, projects: [local.projects] }));

  // The local settings of the project add a pattern to the one in its shared settings.
  write(path.join(outer, '.claude', 'settings.local.json'), JSON.stringify({ claudeMdExcludes: ['**/rules/general.md'] }));
  let checks = run();
  assert.deepEqual(excluded(checks, outer), [
    ['~/.claude/shared/everywhere.md', '**/.claude/shared/everywhere.md'],
    ['outer-app/.claude/rules/general.md', '**/rules/general.md'],
  ]);
  assert.deepEqual(labels(checks, outer), ['~/.claude/CLAUDE.md', '~/.claude/rules/always.md', 'outer-app/CLAUDE.md']);
  assert.deepEqual(excluded(checks, null), [], 'a setting of one project does not reach the user files');
  assert.deepEqual(excluded(checks, local.project('agents-only')), [], 'nor another project');
  assert.ok(!taxOf(checks, outer).parts.some((part) => part.label === '~/.claude/shared/everywhere.md'), 'an excluded file costs no context');
  assert.ok(taxOf(checks, null).parts.some((part) => part.label === '~/.claude/shared/everywhere.md'));

  // A pattern in the user settings holds everywhere. The excluded memory file is not loaded, so
  // what it imports is not loaded either, and its lines are not checked.
  write(path.join(local.home, '.claude', 'CLAUDE.md'), '# User\n\n- Never commit secrets, unless they are test fixtures.\n\n@shared/everywhere.md\n');
  assert.equal(run().candidates.filter((candidate) => candidate.check === 'exception' && candidate.file === `${local.home}/.claude/CLAUDE.md`).length, 1);
  write(path.join(local.home, '.claude', 'settings.local.json'), JSON.stringify({ claudeMdExcludes: [`${local.home}/.claude/CLAUDE.md`] }));
  checks = run();
  assert.deepEqual(excluded(checks, null), [['~/.claude/CLAUDE.md', `${local.home}/.claude/CLAUDE.md`]], 'an exact absolute path is a pattern too');
  assert.deepEqual(labels(checks, null), ['~/.claude/rules/always.md']);
  assert.ok(!labels(checks, outer).includes('~/.claude/CLAUDE.md'));
  assert.equal([...checks.findings, ...checks.candidates].filter((entry) => entry.file === `${local.home}/.claude/CLAUDE.md`).length, 0, 'a file that loads nowhere is not checked line by line');

  // A pattern that is not a usable glob is skipped; the run goes on.
  write(path.join(local.home, '.claude', 'settings.local.json'), JSON.stringify({ claudeMdExcludes: ['x'.repeat(600), '[', 7, null] }));
  assert.deepEqual(excluded(run(), null), []);
});

test('globs are matched against the absolute path with forward slashes', () => {
  const matches = (pattern, file, platform = 'linux') => globMatcher(pattern, platform)(file);
  assert.equal(matches('**/.claude/shared/everywhere.md', '/home/u/.claude/shared/everywhere.md'), true);
  assert.equal(matches('**/everywhere.md', '/everywhere.md'), true, '"**/" also matches no folder at all');
  assert.equal(matches('/home/u/work/*/CLAUDE.md', '/home/u/work/app/CLAUDE.md'), true);
  assert.equal(matches('/home/u/work/*/CLAUDE.md', '/home/u/work/app/pkg/CLAUDE.md'), false, 'one star stays inside one folder name');
  assert.equal(matches('/home/u/work/**', '/home/u/work/app/pkg/CLAUDE.md'), true);
  assert.equal(matches('**/CLAUDE.?d', '/x/CLAUDE.md'), true);
  assert.equal(matches('**/{CLAUDE,AGENTS}.md', '/x/AGENTS.md'), true);
  assert.equal(matches('**/note[12].md', '/x/note2.md'), true);
  assert.equal(matches('**/note[12].md', '/x/note3.md'), false);
  assert.equal(matches('**/a.md', '/x/aXmd'), false, 'a dot is a dot');
  assert.equal(matches('**/a+b (1).md', '/x/a+b (1).md'), true, 'other characters stand for themselves');
  assert.equal(matches('everywhere.md', '/home/u/.claude/shared/everywhere.md'), false, 'a bare name is not an absolute path');
  assert.equal(matches('C:\\work\\**\\CLAUDE.md', 'C:/work/app/CLAUDE.md', 'win32'), true, 'a pattern written with backslashes');
  assert.equal(matches('**/claude.md', '/x/CLAUDE.md', 'win32'), true, 'letter case is ignored where the file system ignores it');
  assert.equal(matches('**/claude.md', '/x/CLAUDE.md', 'linux'), false);
});

test('a glob of any shape never stops the check and never takes long: it matches, or it matches nothing', () => {
  const file = `/home/u/${Array.from({ length: 14 }, (_, index) => `folder-${index}`).join('/')}/CLAUDE.md`;
  const timed = (pattern, target = file, platform = 'linux') => {
    const started = performance.now();
    const result = globMatcher(pattern, platform)(target);
    return { result, ms: performance.now() - started };
  };
  // A pattern is a line of a settings file in a scanned repository. One that a regular expression
  // would refuse, or would take minutes to give up on, is still only a pattern.
  const shapes = {
    'a reversed range': '**/[z-a]/CLAUDE.md',
    'a range that ends in a bracket': '**/[a-',
    'a group that never closes': '**/{a,b/CLAUDE.md',
    'ten times any folders': `${'**/'.repeat(10)}zz`,
    'forty times any folders': `${'**/'.repeat(40)}zz`,
    'thirty stars in one name': `/home/u/${'*a'.repeat(30)}zz`,
    'a hundred alternatives of stars': `**/{${'f*r*,'.repeat(100)}x}/zz`,
    'groups that multiply': `${'{a,b,c,d}'.repeat(40)}`,
    'a line break and a group': '**/{a,\nb}/(CLAUDE.md',
    'question marks': `/${'?'.repeat(400)}`,
  };
  for (const [what, pattern] of Object.entries(shapes)) {
    let outcome;
    assert.doesNotThrow(() => (outcome = timed(pattern)), `${what} stops the check`);
    assert.equal(outcome.result, false, what);
    assert.ok(outcome.ms < 300, `${what} took ${Math.round(outcome.ms)} ms for one file`);
  }
  // The same shapes still match what they describe.
  assert.equal(timed(`${'**/'.repeat(40)}CLAUDE.md`).result, true);
  assert.equal(timed(`/home/u/${'*/'.repeat(14)}CLAUDE.md`).result, true);
  assert.equal(timed('**/folder-[0-9]/**/CLAUDE.md').result, true);
  assert.equal(timed('**/folder-[!0-9]/**').result, false);
  assert.equal(timed('**/{x,folder-1{0,3}}/**').result, false, 'a group inside a group is not a group');
  assert.equal(timed('**/[z-a]older-0/**').result, false, 'a range that holds nothing matches nothing');
  assert.equal(timed('/home/u/[', '/home/u/[').result, true, 'a bracket that never closes is a bracket');
  assert.equal(timed('/home/u/{a', '/home/u/{a').result, true, 'a brace that never closes is a brace');
});

test('a permission rule of any shape is read without a search that never ends', () => {
  const command = 'a'.repeat(40);
  for (const stars of [8, 30, 200]) {
    const started = performance.now();
    assert.equal(ruleCoversCommand(`Bash(${'*a'.repeat(stars)}b)`, command), false);
    assert.ok(performance.now() - started < 300, `a rule with ${stars} stars took ${Math.round(performance.now() - started)} ms`);
  }
  assert.equal(ruleCoversCommand(`Bash(${'*a'.repeat(30)})`, command), true);
  assert.equal(ruleCoversCommand('Bash(git * --force *)', 'git push --force origin main'), true);
  assert.equal(ruleCoversCommand('Bash(git * --force *)', 'git push --force'), true, 'a closing " *" also covers the command alone');
  assert.equal(ruleCoversCommand('Bash(git * --force *)', 'git push --forced'), false);
  assert.equal(ruleCoversCommand('Bash(a.c)', 'abc'), false, 'a dot is a dot');
  assert.equal(ruleCoversCommand('Bash((x|y)+ [z-a] *)', '(x|y)+ [z-a] now'), true, 'every other character stands for itself');
});

// --- AGENTS.md ----------------------------------------------------------------------------------

test('AGENTS.md is listed, and counted only where it stands in for a missing memory file', (t) => {
  const local = materialise('field');
  t.after(() => local.cleanup());
  const outer = local.project('outer-app');
  const lonely = local.project('agents-only');
  write(path.join(lonely, '.claude', 'AGENTS.md'), '# More notes\n\n- Never rename public functions, unless the owner agrees.\n');
  // A nested repository without a memory file of its own, below a project that has one.
  rmSync(path.join(outer, 'clones', 'worktree-kit', 'CLAUDE.md'));
  write(path.join(outer, 'clones', 'worktree-kit', '.claude', 'settings.json'), '{}');
  write(path.join(outer, 'clones', 'worktree-kit', 'AGENTS.md'), '# Notes\n\n- One line.\n');

  const result = scan({ home: local.home, projects: [local.projects], nested: true });
  const agents = result.files.filter((file) => file.kind === 'agents-md').map((file) => [file.path.slice(local.projects.length + 1), file.loads, file.lines]);
  assert.deepEqual(agents.sort(), [
    ['agents-only/.claude/AGENTS.md', 'launch', 3],
    ['agents-only/AGENTS.md', 'launch', 4],
    ['outer-app/AGENTS.md', 'never', 3],
    ['outer-app/clones/worktree-kit/AGENTS.md', 'never', 3],
  ]);

  const checks = runChecks(result);
  const group = (project) => checks.alwaysLoaded.find((entry) => entry.project === project);
  assert.deepEqual(
    group(lonely).files.filter((file) => file.role === 'agents-md').map((file) => [file.label, file.lines]),
    [
      ['agents-only/AGENTS.md', 4],
      ['agents-only/.claude/AGENTS.md', 3],
    ],
  );
  assert.ok(!group(outer).files.some((file) => file.label.endsWith('AGENTS.md')), 'next to a CLAUDE.md it is not read, so it is not counted');
  assert.ok(taxOf(checks, lonely).parts.some((part) => part.type === 'agents-md'));
  const about = [...checks.findings, ...checks.candidates].filter((entry) => entry.file.endsWith('AGENTS.md'));
  assert.deepEqual(about, [], 'its lines are counted, not checked: this tool does not edit that file');

  const view = buildView({ scan: result, checks, lang: 'en' });
  assert.deepEqual(
    view.inventory.agentsMd.map((file) => [file.label, file.loads]),
    [
      ['agents-only/AGENTS.md', 'launch'],
      ['agents-only/.claude/AGENTS.md', 'launch'],
      ['outer-app/AGENTS.md', 'never'],
      ['worktree-kit/AGENTS.md', 'never'],
    ],
  );
  assert.match(view.inventory.agentsMd[0].text, /is read: there is no CLAUDE\.md/);
  assert.match(view.inventory.agentsMd[2].text, /is not read: a memory file sits beside or above it/);
});

// --- what a reader makes of the candidates ------------------------------------------------------

test('a candidate is confirmed with the exact text of every line it names, or dismissed with a reason', () => {
  const user = `${main.home}/.claude/CLAUDE.md`;
  const alpha = `${main.project('alpha-service')}/CLAUDE.md`;
  const pair = mainChecks.candidates.find((candidate) => candidate.check === 'conflict-candidate');
  const hooks = mainChecks.candidates.filter((candidate) => candidate.check === 'automation-in-memory');
  const confirmation = {
    candidate: pair.id,
    title: 'Tabs or spaces',
    severity: 'medium',
    file: alpha,
    line: 7,
    quote: '- Never use tabs for indentation; use two spaces.',
    related: [{ file: user, line: 7, quote: '- Always use tabs for indentation in TypeScript files.' }],
    message: 'The project forbids tabs and the user file demands them for TypeScript.',
    why: 'Both lines load in this project and nothing says which one holds.',
    kind: 'review-conflict',
    detail: 'Say in the user file that a project rule wins.',
  };
  const dismissal = { candidate: hooks[1].id, dismissed: true, reason: 'names no command to run; it reads as guidance' };
  const judged = runChecks(mainScan, { judgement: [confirmation, dismissal] });

  const finding = judged.findings.find((entry) => entry.check === 'judgement');
  assert.equal(finding.candidate, pair.id);
  assert.deepEqual(finding.related, [{ file: user, line: 7, endLine: 7, quote: '- Always use tabs for indentation in TypeScript files.' }]);
  assert.equal(judged.findings.length, mainChecks.findings.length + 1, 'only the confirmed candidate becomes a finding');
  const status = Object.fromEntries(judged.candidates.map((candidate) => [candidate.id, [candidate.status, candidate.reason ?? null, candidate.finding ?? null]]));
  assert.deepEqual(status[pair.id], ['confirmed', null, finding.id]);
  assert.deepEqual(status[hooks[1].id], ['dismissed', dismissal.reason, null]);
  assert.deepEqual(status[hooks[0].id], ['open', null, null]);
  assert.deepEqual(judged.metrics.candidates, { total: 15, open: 13, confirmed: 1, dismissed: 1 });
  assert.deepEqual(judged.metrics.conflictPairs, { found: 1, compared: 1, confirmed: 1, leftOut: 0 });
  assert.equal(finding.origin, 'conflict-candidate', 'a confirmed candidate keeps the check that found it');
  assert.equal(judged.metrics.findings.medium, mainChecks.metrics.findings.medium + 1);

  const refuse = (entries, pattern) => assert.throws(() => runChecks(mainScan, { judgement: entries }), pattern);
  refuse([{ ...confirmation, related: [{ file: user, line: 7, quote: '- Always use tabs.' }] }], /no quote, no finding/);
  refuse([{ ...confirmation, related: [{ file: user, line: 8, quote: confirmation.related[0].quote }] }], /no quote, no finding/);
  refuse([{ ...confirmation, related: 'the user file' }], /related must be a list/);
  refuse([{ ...confirmation, candidate: 'conflict-candidate-0000000000' }], /is not the id of a candidate of this run/);
  refuse([confirmation, { candidate: pair.id, dismissed: true, reason: 'changed my mind' }], /judged twice/);
  refuse([{ candidate: hooks[0].id, dismissed: true }], /needs a one-line reason/);
  refuse([{ candidate: hooks[0].id, dismissed: true, reason: '   ' }], /needs a one-line reason/);
  refuse([{ dismissed: true, reason: 'nothing to dismiss' }], /names the candidate it dismisses/);
  refuse(['not an object'], /must be an object/);

  const view = buildView({ scan: mainScan, checks: judged, lang: 'en' });
  assert.equal(view.candidates.conflictPairs.text, 'Pairs found by shared words: 1. Compared: 1. Confirmed: 1.');
  assert.match(view.candidates.sentence, /Read so far: 2 \(1 confirmed, 1 dismissed, 13 still to read\)/);
  const dismissed = view.candidates.groups.flatMap((group) => group.items).find((item) => item.id === hooks[1].id);
  assert.deepEqual([dismissed.status, dismissed.statusLabel, dismissed.reason], ['dismissed', 'dismissed', dismissal.reason]);
});
