import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './helpers/fixtures.mjs';

const { parseArgs, requireOption } = await load('lib/cli.mjs');
const { parseFrontMatter } = await load('lib/frontmatter.mjs');
const { fenceMask, findImports, findSections, instructionLines, normaliseInstruction, splitLines } = await load('lib/markdown.mjs');
const { resolveHookScript, scriptTokens, summariseHookCommand } = await load('lib/hooks.mjs');
const { displayPath, isInside, isSkippedDir, timestamp } = await load('lib/paths.mjs');
const { maskSecrets } = await load('lib/secrets.mjs');

test('parseArgs: strings, numbers, flags, repeated lists and positionals', () => {
  const spec = { home: 'string', projects: 'list', machine: 'boolean', 'max-files': 'number' };
  const args = parseArgs(['state', '--home', '/h', '--projects', 'a', 'b', '--projects', 'c', '--machine', '--max-files=7'], spec);
  assert.deepEqual(args, { _: ['state'], projects: ['a', 'b', 'c'], machine: true, home: '/h', 'max-files': 7 });
  assert.throws(() => parseArgs(['--nope'], spec), /Unknown option --nope/);
  assert.throws(() => parseArgs(['--home'], spec), /needs a value/);
  assert.throws(() => parseArgs(['--max-files', 'many'], spec), /whole number/);
  assert.throws(() => requireOption(parseArgs([], spec), 'projects'), /--projects/);
});

test('splitLines counts lines the same for LF and CRLF, with or without a final newline', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b']);
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
});

test('code fences are masked, so nothing inside one is read as structure', () => {
  const lines = splitLines('# Title\n```\n# not a heading\n@not/an-import.md\n```\n## Real\n~~~js\n1. x\n~~~\ntext');
  assert.deepEqual(fenceMask(lines), [false, true, true, true, true, false, true, true, true, false]);
  assert.deepEqual(
    findSections(lines).map((section) => [section.heading, section.level, section.line, section.lines]),
    [
      ['Title', 1, 1, 10],
      ['Real', 2, 6, 5],
    ],
  );
  assert.deepEqual(findImports(lines), []);
});

test('block-level HTML comments are masked: what Claude Code strips is not read as an instruction', async () => {
  const { commentMask, commentSize, instructionLines } = await load('lib/markdown.mjs');
  const mask = (text) => commentMask(splitLines(text)).map((masked) => (masked ? 'x' : '.')).join('');
  assert.equal(mask('# T\n<!--\n- old rule\n-->\n- rule'), '.xxx.');
  assert.equal(mask('<!-- one line -->\n- rule'), 'x.');
  assert.equal(mask('   <!-- three spaces in -->\n    <!-- four: code, not a comment -->'), 'x.');
  assert.equal(mask('- rule <!-- inside a line -->\n- rule'), '..', 'a comment inside a line is part of the line');
  assert.equal(mask('<!-- opens\n- a\ncloses --> and text goes on\n- b'), '....', 'text after the closing mark: nothing is masked');
  assert.equal(mask('<!-- never closed\n- a\n- b'), '...', 'a comment that never closes is text');
  assert.equal(mask('```\n<!--\n```\n- a\n-->'), '.....', 'a comment mark inside a code block opens nothing');
  assert.equal(mask('<!-- a -->\n<!-- b\n-->\n- c\n<!-- d -->'), 'xxx.x');
  const lines = splitLines('# T\n<!--\n- Never do X.\n-->\n- Do Y.');
  const fences = fenceMask(lines);
  const comments = commentMask(lines, fences);
  assert.deepEqual(instructionLines(lines, fences.map((masked, index) => masked || comments[index])).map((item) => item.line), [5]);
  // Lines and bytes, with the line endings the file has.
  assert.deepEqual(commentSize('# T\n<!--\n- old\n-->\n- rule\n'), { lines: 3, bytes: 15 });
  assert.deepEqual(commentSize('# T\r\n<!--\r\n- old\r\n-->\r\n- rule\r\n'), { lines: 3, bytes: 18 });
  assert.deepEqual(commentSize('- rule\n'), { lines: 0, bytes: 0 });
  // A file of nothing but opening marks is read in one pass.
  const started = performance.now();
  commentMask(Array.from({ length: 200000 }, () => '<!--'));
  assert.ok(performance.now() - started < 2000, 'the search for a closing mark starts over at every line');
});

test('imports: paths are imports, package names and addresses are not', () => {
  const lines = [
    'See @docs/guide.md and @~/notes/all.md.',
    'Install @types/node and write to me@example.com.',
    'Read `@in/code.md` only as text; (@./relative.md) counts.',
    '@README',
    '@My\\ Docs/api.md',
    // A quoted path is not imported: the memory page says so.
    'See @"docs/quoted.md" and @\'docs/single.md\' for the rest.',
  ];
  assert.deepEqual(
    findImports(lines).map((entry) => [entry.raw, entry.line, entry.bare]),
    [
      ['docs/guide.md', 1, false],
      ['~/notes/all.md', 1, false],
      ['types/node', 2, true],
      ['./relative.md', 3, false],
      ['README', 4, true],
      ['My Docs/api.md', 5, false],
    ],
  );
});

test('the same instruction normalises equal whatever its marker, case, emphasis or spacing', () => {
  const variants = ['- Keep answers short.', '* **Keep** answers  short', '3. keep answers short!', '  + Keep answers `short`.'];
  assert.deepEqual([...new Set(variants.map(normaliseInstruction))], ['keep answers short']);
  const lines = splitLines('# H\n\n- one\n| a | b |\n---\n> quoted\n```\ncode\n```\n');
  assert.deepEqual(
    instructionLines(lines).map((entry) => [entry.line, entry.norm]),
    [
      [3, 'one'],
      [6, '> quoted'],
    ],
  );
});

test('front matter: scalars, quotes, block scalars, lists and nested maps', () => {
  const parsed = parseFrontMatter(
    [
      '---',
      '# a comment',
      'name: my-skill',
      'description: "Does a thing: carefully. Use when asked."',
      "argument-hint: '[issue]'",
      'disable-model-invocation: true',
      'maxTurns: 5',
      'when_to_use: >',
      '  Use it when',
      '  the user asks.',
      'notes: |',
      '  line one',
      '  line two',
      'paths:',
      '  - "src/**/*.ts"',
      '  - docs/*.md',
      'allowed-tools: [Read, "Bash(git status)"]',
      'tools:',
      '- Read',
      '- Grep',
      'metadata:',
      '  owner: team',
      '  tier: 2',
      'empty:',
      'long: first part',
      '  second part',
      '---',
      'body',
    ].join('\n'),
  );
  assert.equal(parsed.valid, true);
  assert.equal(parsed.endLine, 27);
  assert.deepEqual(parsed.data, {
    name: 'my-skill',
    description: 'Does a thing: carefully. Use when asked.',
    'argument-hint': '[issue]',
    'disable-model-invocation': true,
    maxTurns: 5,
    when_to_use: 'Use it when the user asks.',
    notes: 'line one\nline two',
    paths: ['src/**/*.ts', 'docs/*.md'],
    'allowed-tools': ['Read', 'Bash(git status)'],
    tools: ['Read', 'Grep'],
    metadata: { owner: 'team', tier: 2 },
    empty: null,
    long: 'first part second part',
  });
});

test('front matter: absent is fine, unclosed or malformed is reported, never guessed', () => {
  assert.deepEqual(parseFrontMatter('# Just a file\n'), { present: false, valid: true, error: null, data: {}, endLine: 0 });
  assert.equal(parseFrontMatter('---\nname: x\n').valid, false);
  assert.match(parseFrontMatter('---\nname: x\n').error, /not closed/);
  const malformed = parseFrontMatter('---\nname: x\nnot yaml at all\n---\n');
  assert.equal(malformed.valid, false);
  assert.deepEqual(malformed.data, {});
});

test('secrets are masked, ordinary commands and paths are not', () => {
  assert.equal(maskSecrets('deploy --token=abc123 --verbose'), 'deploy --token=*** --verbose');
  assert.equal(maskSecrets('curl -H "Authorization: Bearer abcdef123456"'), 'curl -H "Authorization: Bearer ***"');
  assert.equal(maskSecrets('API_KEY: zzz'), 'API_KEY: ***');
  assert.equal(maskSecrets('use a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8 here'), 'use *** here');
  for (const plain of ['bash ~/.claude/hooks/format-on-save.sh', 'npx prettier --write "$FILE"', 'Bash(npm run test:*)']) {
    assert.equal(maskSecrets(plain), plain);
  }
});

test('paths: containment, labels, skipped folders, timestamps', () => {
  assert.equal(isInside('/a/b/c.md', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/bc/c.md', '/a/b'), false);
  assert.equal(isInside('/a/c.md', '/a/b'), false);
  assert.equal(displayPath('/h/.claude/CLAUDE.md', '/h', ['/h/code/app']), '~/.claude/CLAUDE.md');
  assert.equal(displayPath('/h/code/app/docs/x.md', '/h', ['/h/code/app']), 'app/docs/x.md');
  assert.equal(displayPath('/h/code/app', '/h', ['/h/code/app']), 'app');
  for (const name of ['node_modules', '.git', '.cache', 'AppData', 'Library', 'dist']) assert.equal(isSkippedDir(name), true, name);
  for (const name of ['src', 'projects', 'work', 'dev', 'sys', 'proc', 'snap']) assert.equal(isSkippedDir(name), false, name);
  for (const name of ['build', 'env', 'out', 'target', 'vendor', 'dist']) {
    assert.equal(isSkippedDir(name), true, `${name} is build output inside a project`);
    assert.equal(isSkippedDir(name, { buildOutput: false }), false, `${name} can hold projects near the home folder`);
  }
  assert.equal(isSkippedDir('node_modules', { buildOutput: false }), true);
  assert.equal(timestamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405');
});

test('a heading with a very long run of spaces is handled in linear time', () => {
  const started = performance.now();
  const hostile = [`# ${' '.repeat(20000)}x`, `## ${' '.repeat(20000)}`, `- ${'.'.repeat(20000)}x`, '## Real'];
  const sections = findSections(hostile);
  instructionLines(hostile);
  findImports(hostile);
  const matter = parseFrontMatter(`---\nname: x # a comment\ndescription: a${' '.repeat(20000)}b\nwide: c${' '.repeat(20000)}# d\n---\n`);
  assert.ok(performance.now() - started < 1000, 'structure parsing took over a second');
  assert.deepEqual(
    sections.map((section) => section.heading),
    ['Real'],
    'a line over the length cap is not parsed as structure',
  );
  assert.deepEqual([matter.valid, matter.data.name, matter.data.description.length, matter.data.wide], [true, 'x', 20002, 'c']);

  const spaced = findSections([`#   ${' '.repeat(1500)}Wide   ##  `, '## C#', '### Closed ###', '#### #']);
  assert.deepEqual(
    spaced.map((section) => section.heading),
    ['Wide', 'C#', 'Closed', ''],
  );
});

test('secrets: flag values, URL credentials, basic auth, env-style names and long keys are masked', () => {
  const cases = [
    ['deploy.sh --token s3cr3tValue', 's3cr3tValue'],
    ['deploy.sh --api-key sk-live-12345', 'sk-live-12345'],
    ['x --password "two words" --verbose', 'two words'],
    ['curl -u admin:hunter2 https://host.example/x', 'hunter2'],
    ['git push https://user:hunter2@host.example/repo.git', 'hunter2'],
    ['curl -H "Authorization: Basic dXNlcjpwYXNz" https://host.example', 'dXNlcjpwYXNz'],
    ['mysql -uroot -pSecret123 db', 'Secret123'],
    ['upload wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY9 now', 'wJalrXUtnFEMI'],
    ['AUTH=abc123 PASS=hunter2 run.sh', 'abc123'],
    ['AUTH=abc123 PASS=hunter2 run.sh', 'hunter2'],
    ['DB_PWD="p w" ./start.sh', 'p w'],
  ];
  for (const [text, secret] of cases) {
    const masked = maskSecrets(text);
    assert.ok(!masked.includes(secret), `"${secret}" survived in: ${masked}`);
    assert.ok(masked.includes('***'));
  }
  assert.equal(maskSecrets('deploy.sh --token s3cr3tValue'), 'deploy.sh --token ***');
  assert.equal(maskSecrets('git push https://user:hunter2@host.example/repo.git'), 'git push https://***@host.example/repo.git');
  for (const plain of [
    'git push -u origin main',
    'Bash(git push --force:*)',
    'Read(./docs/**)',
    'Bash(./node_modules/typescript/bin/tsc --noEmit:*)',
    'python3 ~/.claude/hooks/format-on-save-for-typescript-files-v2.py',
    'Use when the user asks for a release. See https://code.claude.com/docs/en/skills.md',
  ]) {
    assert.equal(maskSecrets(plain), plain);
  }
});

test('a hook command is reduced to its program and script; every other argument is masked', () => {
  assert.equal(summariseHookCommand('bash ~/.claude/hooks/guard.sh'), 'bash ~/.claude/hooks/guard.sh');
  assert.equal(summariseHookCommand('python3 ~/.claude/hooks/check.py --token=abc --fast'), 'python3 ~/.claude/hooks/check.py ***');
  assert.equal(summariseHookCommand('"$CLAUDE_PROJECT_DIR"/.claude/hooks/run.sh hunter2'), '$CLAUDE_PROJECT_DIR/.claude/hooks/run.sh ***');
  assert.equal(summariseHookCommand('bash "/opt/my hooks/run.sh"'), 'bash "/opt/my hooks/run.sh"');
  for (const [command, secret] of [
    ['deploy.sh --token s3cr3tValue', 's3cr3tValue'],
    ['deploy.sh hunter2', 'hunter2'],
    ['curl -s https://hooks.host.example/services/T000/B000/XyZ123', 'T000/B000/XyZ123'],
    ['mysql -uroot -pSecret123 db', 'Secret123'],
    ['TOKEN=abc123 ./notify.sh', 'abc123'],
    ['bash -c "curl -u admin:hunter2 https://host.example/x"', 'hunter2'],
    ['node https://user:pw12345@host.example/x.js', 'pw12345'],
  ]) {
    const summary = summariseHookCommand(command);
    assert.ok(!summary.includes(secret), `"${secret}" survived in: ${summary}`);
  }
});

test('hook scripts: only the first word and the word after an interpreter can be the script', () => {
  assert.deepEqual(scriptTokens('bash ~/.claude/hooks/gone.sh; echo done'), ['~/.claude/hooks/gone.sh']);
  assert.deepEqual(scriptTokens('python3 "$CLAUDE_PROJECT_DIR"/.claude/hooks/check.py --x'), ['$CLAUDE_PROJECT_DIR/.claude/hooks/check.py']);
  assert.deepEqual(scriptTokens('./scripts/format.sh "$FILE"'), ['./scripts/format.sh']);
  assert.deepEqual(scriptTokens('node.exe tools/check.mjs'), ['tools/check.mjs']);
  for (const command of [
    'npx eslint --config=eslint.config.js --fix',
    'curl -s https://example.test/install.sh',
    'prettier --write src/index.ts',
    'bash -c "cd x && ./run.sh"',
    'node --require=./setup.js',
    'echo done',
  ]) {
    assert.deepEqual(scriptTokens(command), [], command);
  }
});

test('hook scripts: paths resolve against the home folder and the project, Git Bash drive paths on Windows', () => {
  const where = { home: '/h', project: '/p', platform: 'linux' };
  assert.equal(resolveHookScript('~/.claude/hooks/a.sh', where), '/h/.claude/hooks/a.sh');
  assert.equal(resolveHookScript('$HOME/.claude/hooks/a.sh', where), '/h/.claude/hooks/a.sh');
  assert.equal(resolveHookScript('$CLAUDE_PROJECT_DIR/.claude/hooks/a.sh', where), '/p/.claude/hooks/a.sh');
  assert.equal(resolveHookScript('${CLAUDE_PROJECT_DIR}/tools/a.sh', where), '/p/tools/a.sh');
  assert.equal(resolveHookScript('tools/a.sh', where), '/p/tools/a.sh');
  assert.equal(resolveHookScript('tools/a.sh', { ...where, project: null }), null, 'a relative path in user settings has no base');
  assert.equal(resolveHookScript('$CLAUDE_PROJECT_DIR/a.sh', { ...where, project: null }), null);
  assert.equal(resolveHookScript('$OTHER/a.sh', where), null, 'an unknown variable cannot be resolved');
  assert.equal(resolveHookScript('/d/work/hooks/ok.sh', { ...where, platform: 'win32' }), 'd:/work/hooks/ok.sh');
  assert.equal(resolveHookScript('/d/work/hooks/ok.sh', where), '/d/work/hooks/ok.sh');
});
