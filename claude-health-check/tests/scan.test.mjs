import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { load, materialise, runJson, runScript } from './helpers/fixtures.mjs';

const { runChecks } = await load('checks.mjs');
const { ALLOWED_KINDS, isProject, scan } = await load('scan.mjs');

let fx;
before(() => {
  fx = materialise('main');
});
after(() => fx.cleanup());

const byKind = (result, kind) => result.files.filter((file) => file.kind === kind);
const relative = (file) => file.path.slice(fx.root.length + 1);
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

test('the result names everything a caller builds on, and a folder can be checked before it is scanned', () => {
  const result = scan({ home: fx.home, projects: [fx.projects] });
  assert.deepEqual(Object.keys(result), [
    'scannedAt', 'home', 'scope', 'capped', 'projects', 'nestedRepositories', 'files', 'settings', 'linked', 'autoMemory', 'skipped',
  ]);
  assert.deepEqual(result.scope, { user: true, projects: [fx.projects], machine: false, nested: false, limits: { maxFiles: 2000, maxDirs: 20000, maxDepth: 6 } });
  assert.deepEqual(result.projects.map((project) => Object.keys(project)), [
    ['path', 'name', 'markers', 'nestedIn', 'memoryAbove'],
    ['path', 'name', 'markers', 'nestedIn', 'memoryAbove'],
  ]);
  assert.deepEqual(result.nestedRepositories, []);
  assert.deepEqual(result.linked, []);
  assert.ok(ALLOWED_KINDS.includes('agents-md'));

  assert.equal(isProject(fx.project('alpha-service')), true);
  assert.equal(isProject(fx.project('beta-tool')), true);
  assert.equal(isProject(fx.projects), false, 'a folder of projects is not a project');
  assert.equal(isProject(path.join(fx.root, 'no-such-folder')), false);
});

test('the progress callback is told each phase as it ends, so a caller can show the scan while it runs', () => {
  const events = [];
  const result = scan({ home: fx.home, projects: [fx.projects], machine: true, onProgress: (event) => events.push(event) });
  assert.deepEqual([...new Set(events.map((event) => event.phase))], ['user', 'discover', 'project', 'imports']);
  assert.equal(events[0].files, result.files.filter((file) => file.scope === 'user' && file.kind !== 'import').length);
  assert.deepEqual(events.filter((event) => event.phase === 'project').map((event) => event.projects), [1, 2, 3, 4]);
  assert.equal(events.at(-1).files, result.files.length);
  const discovered = events.find((event) => event.phase === 'discover');
  assert.ok(discovered.dirs > 0 && discovered.found === 2);
  // A callback is optional, and what it throws is the caller's business, not swallowed.
  assert.throws(() => scan({ home: fx.home, onProgress: () => {
    throw new Error('from the callback');
  } }), /from the callback/);
});

test('scan requires an existing home folder', () => {
  assert.throws(() => scan({}), /home/);
  assert.throws(() => scan({ home: path.join(fx.root, 'no-such-home') }), /does not exist/);
});

test('user scope: memory, skills, commands, agents, rules and settings are listed', () => {
  const result = scan({ home: fx.home });
  assert.deepEqual(byKind(result, 'memory').map(relative), ['home/.claude/CLAUDE.md']);
  assert.equal(byKind(result, 'skill').length, 8);
  assert.deepEqual(byKind(result, 'command').map(relative).sort(), [
    'home/.claude/commands/deploy.md',
    'home/.claude/commands/git/sync.md',
  ]);
  assert.equal(byKind(result, 'agent').length, 2);
  assert.deepEqual(byKind(result, 'rule').map(relative).sort(), [
    'home/.claude/rules/deep/naming.md',
    'home/.claude/rules/style.md',
  ]);
  assert.ok(result.files.every((file) => file.scope === 'user' && file.project === null));
  assert.deepEqual(result.settings.map((entry) => entry.kind).sort(), ['settings', 'settings-local']);
});

test('a memory file is described by size and structure, never by its body', () => {
  const result = scan({ home: fx.home });
  const memory = byKind(result, 'memory')[0];
  assert.equal(memory.lines, 238);
  assert.ok(memory.bytes > 0);
  assert.equal(memory.approxTokens, Math.ceil(memory.bytes / 4));
  assert.deepEqual(
    memory.sections.map((section) => section.heading),
    ['Personal defaults', 'Style', 'Tools', 'Release procedure', 'Project notes', 'Imports', 'Reference: error codes'],
  );
  const reference = memory.sections.find((section) => section.heading === 'Reference: error codes');
  assert.equal(reference.lines, 192);
  assert.equal(memory.sections[0].lines, 238);

  const text = JSON.stringify(result);
  assert.ok(!text.includes('Keep answers short and direct'), 'a memory line leaked into the scan');
  assert.ok(!text.includes('Checklist item'), 'a skill body leaked into the scan');
});

test('front matter of skills, commands, agents and rules is parsed', () => {
  const result = scan({ home: fx.home });
  const skill = byKind(result, 'skill').find((file) => file.name === 'good-skill');
  assert.equal(skill.frontMatter.valid, true);
  assert.equal(skill.frontMatter.data.name, 'good-skill');
  assert.match(skill.frontMatter.data.description, /Use when/);
  const unreachable = byKind(result, 'skill').find((file) => file.name === 'unreachable-skill');
  assert.equal(unreachable.frontMatter.data['disable-model-invocation'], true);
  assert.equal(unreachable.frontMatter.data['user-invocable'], false);
  const rule = byKind(result, 'rule').find((file) => file.path.endsWith('rules/style.md'));
  assert.deepEqual(rule.frontMatter.data.paths, ['**/*.ts']);
  const command = byKind(result, 'command').find((file) => file.path.endsWith('deploy.md'));
  assert.equal(command.frontMatter.present, false);
});

test('settings are summarised without values that could be secrets', () => {
  const result = scan({ home: fx.home, projects: [fx.projects] });
  const user = result.settings.find((entry) => entry.kind === 'settings' && entry.scope === 'user');
  assert.equal(user.valid, true);
  assert.deepEqual(user.keys, ['model', 'env', 'permissions', 'hooks', 'customUnknownKey']);
  assert.deepEqual(user.envKeys, ['API_TOKEN']);
  // Of the permission rules: how many each list holds and which name an MCP server. No text of
  // a rule, which can hold a credential, and nothing about the permission mode.
  assert.deepEqual(user.permissions, { allow: 2, ask: 0, deny: 0, mcp: [] });
  const alpha = result.settings.find((entry) => entry.kind === 'settings' && entry.project === fx.project('alpha-service'));
  assert.deepEqual(alpha.permissions, { allow: 1, ask: 0, deny: 1, mcp: [] });
  for (const word of ['defaultMode', 'bypassPermissions', 'Read(./docs', 'npm run test']) assert.ok(!JSON.stringify(result).includes(word), `the scan carries "${word}"`);
  assert.deepEqual(
    user.hooks.map((hook) => hook.event),
    ['PreToolUse', 'PostToolUse', 'AfterEverything'],
  );
  assert.equal(user.hooks[0].matcher, 'Bash');
  assert.equal(user.hooks[0].command, 'bash ~/.claude/hooks/existing-hook.sh');

  const local = result.settings.find((entry) => entry.kind === 'settings-local');
  assert.equal(local.valid, false);
  assert.ok(local.error);

  const mcp = result.settings.find((entry) => entry.kind === 'mcp');
  assert.deepEqual(mcp.servers, ['tracker', 'search']);
  assert.deepEqual(Object.keys(mcp).sort(), ['bytes', 'error', 'kind', 'path', 'project', 'scope', 'servers', 'valid']);

  assert.ok(!JSON.stringify(result).includes('FIXTURE-SECRET-VALUE'), 'a secret value leaked into the scan');
});

test('project scope: memory, local memory, nested memory, skills, commands, agents, rules', () => {
  const result = scan({ home: fx.home, projects: [fx.projects] });
  assert.deepEqual(
    result.projects.map((project) => project.name),
    ['alpha-service', 'beta-tool'],
  );
  const alpha = result.files.filter((file) => file.project === fx.project('alpha-service'));
  const kinds = (kind) => alpha.filter((file) => file.kind === kind).map(relative);
  assert.deepEqual(kinds('memory'), ['projects/alpha-service/CLAUDE.md']);
  assert.deepEqual(kinds('memory-local'), ['projects/alpha-service/CLAUDE.local.md']);
  assert.deepEqual(kinds('memory-nested'), ['projects/alpha-service/packages/web/CLAUDE.md']);
  assert.deepEqual(kinds('skill'), ['projects/alpha-service/.claude/skills/shared-skill/SKILL.md']);
  assert.deepEqual(kinds('command'), ['projects/alpha-service/.claude/commands/release.md']);
  assert.deepEqual(kinds('agent'), ['projects/alpha-service/.claude/agents/tester.md']);
  assert.deepEqual(kinds('rule'), ['projects/alpha-service/.claude/rules/api.md']);
  assert.ok(alpha.every((file) => file.scope === 'project'));
  assert.deepEqual(result.projects[0].markers, ['package.json']);
  assert.deepEqual(result.projects[1].markers, ['Cargo.toml']);
});

test('--projects accepts a project folder itself as well as a folder of projects', () => {
  const result = scan({ home: fx.home, projects: [fx.project('beta-tool')] });
  assert.deepEqual(
    result.projects.map((project) => project.name),
    ['beta-tool'],
  );
  assert.throws(() => scan({ home: fx.home, projects: [path.join(fx.root, 'missing')] }), /does not exist/);
});

test('nothing outside the allowed kinds and locations is ever returned', () => {
  const result = scan({ home: fx.home, projects: [fx.projects], machine: true });
  for (const file of result.files) {
    assert.ok(ALLOWED_KINDS.includes(file.kind), `unexpected kind ${file.kind}`);
    assert.ok(file.path.endsWith('.md'), `unexpected file ${file.path}`);
  }
  const text = JSON.stringify(result);
  const listed = [...result.files, ...result.settings, ...result.skipped].map((entry) => entry.path);
  assert.ok(!listed.some((file) => file.includes('/hooks/')), 'a hook script was listed as a scanned file');
  for (const forbidden of ['private.txt', 'handler.ts', 'main.ts', 'node_modules', 'some-pkg']) {
    assert.ok(!text.includes(forbidden), `${forbidden} must not appear in the scan`);
  }
});

test('imports are resolved hop by hop and never read outside the scanned roots', (t) => {
  const local = materialise('main');
  t.after(() => local.cleanup());
  const outside = path.join(local.root, 'outside-import.md');
  writeFileSync(outside, '# Outside\n\n- SHOULD-NOT-BE-READ\n');
  const project = path.join(local.root, 'projects', 'beta-tool', 'CLAUDE.md');
  writeFileSync(project, `# beta-tool\n\n@../../outside-import.md\n@types/node is a package, not an import.\n`);

  const result = scan({ home: local.home, projects: [local.projects] });
  const user = byKind(result, 'memory').find((file) => file.scope === 'user');
  assert.deepEqual(
    user.imports.map((entry) => [entry.raw, entry.exists, entry.hop]),
    [
      ['shared/git.md', true, 1],
      ['shared/missing.md', false, 1],
      ['shared/chain-1.md', true, 1],
      ['shared/reference.md', true, 1],
    ],
  );
  const imported = byKind(result, 'import');
  const hops = Object.fromEntries(imported.map((file) => [path.basename(file.path), file.hop]));
  assert.deepEqual(hops, {
    'git.md': 1,
    'chain-1.md': 1,
    'reference.md': 1,
    'chain-2.md': 2,
    'chain-3.md': 3,
    'chain-4.md': 4,
    'api-notes.md': 1,
  });
  const chain4 = imported.find((file) => file.path.endsWith('chain-4.md'));
  assert.deepEqual(
    chain4.imports.map((entry) => [entry.raw, entry.exists, entry.hop, entry.tooDeep]),
    [['chain-5.md', true, 5, true]],
  );

  const beta = byKind(result, 'memory').find((file) => file.project === local.project('beta-tool'));
  assert.equal(beta.imports.length, 1, 'a bare @word that is not a file is not an import');
  assert.equal(beta.imports[0].outside, true);
  assert.ok(result.skipped.some((entry) => entry.reason === 'import-outside-scope'));
  assert.ok(!imported.some((file) => file.path.endsWith('outside-import.md')));
});

test('an import is read only from where its importing file may reach, and only when it is a text file', (t) => {
  const local = materialise('main');
  t.after(() => local.cleanup());
  const write = (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write(path.join(local.home, '.secrets', 'creds.env'), '# CREDS-HEADING\nsecret_access_key = CREDS-VALUE\n');
  write(path.join(local.home, '.secrets', 'notes.md'), '# HIDDEN-NOTES\n');
  write(path.join(local.home, 'notes', 'plain.md'), '# HOME-NOTES\n');
  write(path.join(local.project('alpha-service'), '.env'), '# ENV-HEADING\nPASSWORD=ENV-VALUE\n');
  write(
    path.join(local.project('beta-tool'), 'CLAUDE.md'),
    [
      '# beta-tool',
      '',
      '@~/.secrets/creds.env',
      '@~/.secrets/notes.md',
      '@~/notes/plain.md',
      '@../alpha-service/docs/api-notes.md',
      '@~/.claude/shared/git.md',
      '@Cargo.toml',
      '',
    ].join('\n'),
  );
  write(
    path.join(local.project('alpha-service'), 'CLAUDE.md'),
    ['# alpha-service', '', '@.env', '@src/api/handler.ts', '@package.json', '@docs/api-notes.md', ''].join('\n'),
  );
  write(path.join(local.home, '.claude', 'CLAUDE.md'), '# User\n\n@~/notes/plain.md\n@shared/git.md\n');

  const result = scan({ home: local.home, projects: [local.projects] });
  const text = JSON.stringify(result);
  for (const marker of ['CREDS-HEADING', 'CREDS-VALUE', 'HIDDEN-NOTES', 'HOME-NOTES', 'ENV-HEADING', 'ENV-VALUE']) {
    assert.ok(!text.includes(marker), `${marker} was read`);
  }
  const memoryOf = (project) => result.files.find((file) => file.kind === 'memory' && file.project === project);
  const beta = memoryOf(local.project('beta-tool'));
  assert.deepEqual(
    beta.imports.map((entry) => [entry.raw, entry.outside, entry.exists, entry.notText ?? false]),
    [
      ['~/.secrets/creds.env', true, null, false],
      ['~/.secrets/notes.md', true, null, false],
      ['~/notes/plain.md', true, null, false],
      ['../alpha-service/docs/api-notes.md', true, null, false],
      ['~/.claude/shared/git.md', false, true, false],
      ['Cargo.toml', false, null, true],
    ],
  );
  const alpha = memoryOf(local.project('alpha-service'));
  assert.deepEqual(
    alpha.imports.map((entry) => [entry.raw, entry.exists, entry.notText ?? false]),
    [
      ['.env', null, true],
      ['src/api/handler.ts', null, true],
      ['package.json', null, true],
      ['docs/api-notes.md', true, false],
    ],
  );
  const user = result.files.find((file) => file.kind === 'memory' && file.scope === 'user');
  assert.deepEqual(
    user.imports.map((entry) => [entry.raw, entry.outside]),
    [
      ['~/notes/plain.md', true],
      ['shared/git.md', false],
    ],
  );
  assert.ok(result.files.every((file) => /\.(md|mdc|txt)$/i.test(file.path)), 'a file that is not text was listed');
  const skippedAs = (reason) => result.skipped.filter((entry) => entry.reason === reason).map((entry) => path.basename(entry.path));
  assert.deepEqual(skippedAs('import-not-text').sort(), ['.env', 'Cargo.toml', 'handler.ts', 'package.json']);
  assert.deepEqual(skippedAs('import-outside-scope').sort(), ['api-notes.md', 'creds.env', 'notes.md', 'plain.md']);

  const checks = JSON.stringify(runChecks(result));
  for (const marker of ['CREDS-VALUE', 'ENV-VALUE', 'HOME-NOTES']) assert.ok(!checks.includes(marker), `${marker} reached the findings`);
});

test('an import that passes through a link is listed as skipped and never opened', (t) => {
  const local = materialise('main');
  t.after(() => local.cleanup());
  const outside = path.join(local.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'notes.md'), '# LINKED-HEADING\n\n- LINKED-LINE\n');
  const project = local.project('beta-tool');
  try {
    symlinkSync(outside, path.join(project, 'linked'), 'junction');
  } catch (error) {
    t.skip(`this platform refused to create a link: ${error.code}`);
    return;
  }
  writeFileSync(path.join(project, 'CLAUDE.md'), '# beta-tool\n\n@linked/notes.md\n');

  const result = scan({ home: local.home, projects: [local.projects] });
  assert.ok(!JSON.stringify(result.files).includes('LINKED-HEADING'), 'the file behind the link was read');
  assert.ok(!result.files.some((file) => file.path.includes('/linked/')), 'the file behind the link is listed');
  assert.ok(result.skipped.some((entry) => entry.reason === 'symlink' && entry.path.endsWith('beta-tool/linked')));
  const [entry] = result.files.find((file) => file.kind === 'memory' && file.project === project).imports;
  assert.deepEqual([entry.raw, entry.exists], ['linked/notes.md', null]);
  assert.ok(!JSON.stringify(runChecks(result)).includes('LINKED-LINE'));
});

test('symbolic links and junctions are reported, never followed', (t) => {
  const local = materialise('main');
  t.after(() => local.cleanup());
  const target = path.join(local.root, 'link-target');
  mkdirSync(path.join(target, 'linked-skill'), { recursive: true });
  writeFileSync(path.join(target, 'linked-skill', 'SKILL.md'), '---\nname: linked-skill\ndescription: x\n---\n');
  writeFileSync(path.join(target, 'CLAUDE.md'), '# Linked memory\n');
  try {
    symlinkSync(path.join(target, 'linked-skill'), path.join(local.home, '.claude', 'skills', 'linked-skill'), 'junction');
    symlinkSync(target, path.join(local.home, 'code', 'linked-project'), 'junction');
    symlinkSync(target, path.join(local.project('alpha-service'), 'linked-dir'), 'junction');
  } catch (error) {
    t.skip(`this platform refused to create a link: ${error.code}`);
    return;
  }
  const result = scan({ home: local.home, projects: [local.projects], machine: true });
  const text = JSON.stringify(result.files);
  assert.ok(!text.includes('linked-skill'), 'a linked skill folder was followed');
  assert.ok(!text.includes('link-target'), 'a link target was read');
  assert.ok(!result.projects.some((project) => project.name === 'linked-project'));
  const reasons = result.skipped.filter((entry) => entry.reason === 'symlink').map((entry) => path.basename(entry.path));
  assert.ok(reasons.includes('linked-skill'));
  assert.ok(reasons.includes('linked-project'));
  assert.ok(reasons.includes('linked-dir'));
});

test('the machine scan finds project folders, skips dependency folders and the home itself', () => {
  const result = scan({ home: fx.home, machine: true });
  assert.deepEqual(result.projects.map((project) => project.name).sort(), ['delta-lib', 'gamma-app']);
  assert.equal(result.scope.machine, true);
  assert.equal(result.capped.hit, false);
  assert.deepEqual(result.capped.reasons, []);
  assert.ok(byKind(result, 'memory').some((file) => file.path.endsWith('code/gamma-app/CLAUDE.md')));
  assert.ok(result.settings.some((entry) => entry.path.endsWith('code/delta-lib/.claude/settings.json')));
});

test('the home scan enters folders of projects whose names also mean build output', (t) => {
  const local = materialise('clean');
  t.after(() => local.cleanup());
  const project = (...parts) => {
    const dir = path.join(local.home, ...parts);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'CLAUDE.md'), `# ${parts[parts.length - 1]}\n`);
  };
  project('dev', 'app-one');
  project('build', 'app-two');
  project('work', 'build', 'app-three');
  project('work', 'vendor', 'app-four');
  project('src', 'env', 'app-five');
  project('work', 'team', 'group', 'build', 'deep-output');
  project('work', 'node_modules', 'some-package');

  const result = scan({ home: local.home, machine: true });
  assert.deepEqual(
    result.projects.map((entry) => entry.name).sort(),
    ['app-five', 'app-four', 'app-one', 'app-three', 'app-two'],
    'build output deep in the tree and dependency folders stay skipped',
  );
  assert.equal(result.capped.hit, false);

  const named = scan({ home: local.home, projects: [path.join(local.home, 'work')] });
  assert.deepEqual(named.projects.map((entry) => entry.name).sort(), [], 'a folder of folders holds no project directly');
  const direct = scan({ home: local.home, projects: [path.join(local.home, 'work', 'build')] });
  assert.deepEqual(
    direct.projects.map((entry) => entry.name),
    ['app-three'],
  );
});

test('a hook command leaves the scanner as its program and script only', () => {
  const result = scan({ home: fx.home, projects: [fx.projects] });
  const user = result.settings.find((entry) => entry.kind === 'settings' && entry.scope === 'user');
  assert.deepEqual(
    user.hooks.map((hook) => [hook.command, hook.scripts]),
    [
      ['bash ~/.claude/hooks/existing-hook.sh', ['~/.claude/hooks/existing-hook.sh']],
      ['python3 ~/.claude/hooks/missing-hook.py ***', ['~/.claude/hooks/missing-hook.py']],
      ['echo ***', []],
    ],
  );
});

test('the machine scan says when a cap stopped it', () => {
  const byDirs = scan({ home: fx.home, machine: true, maxDirs: 2 });
  assert.equal(byDirs.capped.hit, true);
  assert.equal(byDirs.capped.reasons[0].cap, 'max-dirs');
  assert.equal(byDirs.capped.reasons[0].limit, 2);

  const byDepth = scan({ home: fx.home, machine: true, maxDepth: 1 });
  assert.equal(byDepth.capped.hit, true);
  assert.equal(byDepth.capped.reasons[0].cap, 'max-depth');
  assert.deepEqual(byDepth.projects, []);

  const byFiles = scan({ home: fx.home, maxFiles: 3 });
  assert.equal(byFiles.files.length, 3);
  assert.equal(byFiles.capped.hit, true);
  assert.equal(byFiles.capped.reasons[0].cap, 'max-files');
});

test('CLI prints the inventory as JSON and fails loudly without --home', () => {
  const result = runJson('scan.mjs', ['--home', fx.home, '--projects', fx.projects, '--max-files', '500']);
  assert.equal(result.home, fx.home);
  assert.equal(result.projects.length, 2);
  assert.match(result.scannedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.scope.limits.maxFiles, 500);

  const failed = runScript('scan.mjs', []);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /--home/);
});

test('what marks a skill as third-party: a front matter key, a licence file or a repository of its own', (t) => {
  const local = materialise('clean');
  t.after(() => local.cleanup());
  const skills = path.join(local.home, '.claude', 'skills');
  const skill = (name, frontMatter, extra = {}) => {
    write(path.join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Does it. Use when asked.\n${frontMatter}---\n\n# ${name}\n`);
    for (const [file, text] of Object.entries(extra)) write(path.join(skills, name, file), text);
  };
  skill('with-license-field', 'license: Complete terms in the file next to this one\n');
  skill('with-upstream', 'upstream: an example collection\n');
  skill('with-source', 'source: an example collection\n');
  skill('with-metadata', 'metadata:\n  author: Sample Author\n  version: 2\n');
  skill('with-licence-file', '', { LICENCE: 'sample' });
  skill('with-license-md', '', { 'license.md': 'sample' });
  skill('with-repository', '', { '.git/HEAD': 'ref: refs/heads/main\n' });
  skill('with-both', 'author: Sample Author\n', { 'LICENSE.txt': 'sample', '.git/HEAD': 'ref: refs/heads/main\n' });
  skill('plain', 'metadata:\n  version: 2\nallowed-tools: Read\n', { 'notes.md': 'the word license in a file of another name\n', 'reference/LICENSE': 'in a subfolder\n' });

  const found = Object.fromEntries(
    scan({ home: local.home })
      .files.filter((file) => file.kind === 'skill')
      .map((file) => [file.name, file.thirdParty]),
  );
  assert.deepEqual(found, {
    plain: null,
    'tidy-skill': null,
    'with-both': ['front-matter:author', 'license-file', 'repository'],
    'with-licence-file': ['license-file'],
    'with-license-field': ['front-matter:license'],
    'with-license-md': ['license-file'],
    'with-metadata': ['front-matter:author'],
    'with-repository': ['repository'],
    'with-source': ['front-matter:source'],
    'with-upstream': ['front-matter:upstream'],
  });
  // Only names in the skill folder are looked at: the licence file is not opened or listed.
  const result = scan({ home: local.home });
  assert.ok(!JSON.stringify(result).includes('LICENSE.txt'));
  assert.ok(!result.files.some((file) => /licen[cs]e|notes\.md|HEAD/i.test(path.basename(file.path))));
});

test('a rule file loads at launch unless it has a paths pattern, in whatever form the pattern is written', (t) => {
  const local = materialise('clean');
  t.after(() => local.cleanup());
  const rules = path.join(local.home, '.claude', 'rules');
  write(path.join(rules, 'none.md'), '# No front matter\n\n- A rule.\n');
  write(path.join(rules, 'described.md'), '---\ndescription: A rule with front matter and no paths.\n---\n\n- A rule.\n');
  write(path.join(rules, 'empty-list.md'), '---\npaths: []\n---\n\n- A rule.\n');
  write(path.join(rules, 'list.md'), '---\npaths:\n  - "src/**"\n---\n\n- A rule.\n');
  write(path.join(rules, 'inline.md'), '---\npaths: ["src/**", "lib/**"]\n---\n\n- A rule.\n');
  write(path.join(rules, 'string.md'), '---\npaths: src/**\n---\n\n- A rule.\n');
  write(path.join(rules, 'unreadable.md'), '---\npaths: src/**\nthis line is not yaml\n---\n\n- A rule.\n');
  write(path.join(rules, 'unreadable-plain.md'), '---\nthis line is not yaml\n---\n\n- A rule with the word paths: in its body.\n');
  const loads = Object.fromEntries(
    scan({ home: local.home })
      .files.filter((file) => file.kind === 'rule')
      .map((file) => [path.basename(file.path), file.loads]),
  );
  assert.deepEqual(loads, {
    'described.md': 'launch',
    'empty-list.md': 'launch',
    'inline.md': 'on-demand',
    'list.md': 'on-demand',
    'none.md': 'launch',
    'string.md': 'on-demand',
    'unreadable-plain.md': 'launch',
    'unreadable.md': 'on-demand',
  });
});

test('nested repositories: found at any depth, never entered unless asked for, and then walked for more of their kind', (t) => {
  const local = materialise('field');
  t.after(() => local.cleanup());
  const outer = local.project('outer-app');
  // A repository inside a nested repository, and one deep in plain folders.
  write(path.join(outer, 'clones', 'inner-kit', 'third-party', 'deep-kit', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(outer, 'clones', 'inner-kit', 'third-party', 'deep-kit', 'CLAUDE.md'), '# deep-kit\n\n- DEEP-KIT-LINE\n');
  write(path.join(outer, 'a', 'b', 'c', 'far-kit', '.git'), 'gitdir: elsewhere\n');
  write(path.join(outer, 'a', 'b', 'c', 'far-kit', '.claude', 'settings.json'), '{}');
  // Folders the walk never enters hold no repositories as far as the tool is concerned.
  write(path.join(outer, 'node_modules', 'some-package', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(outer, 'node_modules', 'some-package', 'CLAUDE.md'), '# NODE-MODULES-LINE\n');

  const names = (result) => result.nestedRepositories.map((entry) => [entry.name, path.basename(entry.parent), entry.setup, entry.included]);
  const plain = scan({ home: local.home, projects: [local.projects] });
  assert.deepEqual(names(plain), [
    ['inner-kit', 'outer-app', true, false],
    ['plain-repo', 'outer-app', false, false],
    ['worktree-kit', 'outer-app', true, false],
    ['far-kit', 'outer-app', true, false],
  ]);
  assert.ok(!JSON.stringify(plain).includes('DEEP-KIT-LINE') && !JSON.stringify(plain).includes('deep-kit'), 'a nested repository was entered without being asked for');

  const nested = scan({ home: local.home, projects: [local.projects], nested: true });
  assert.deepEqual(names(nested), [
    ['inner-kit', 'outer-app', true, true],
    ['plain-repo', 'outer-app', false, false],
    ['worktree-kit', 'outer-app', true, true],
    ['far-kit', 'outer-app', true, true],
    ['deep-kit', 'inner-kit', true, true],
  ]);
  assert.deepEqual(
    nested.projects.map((project) => [project.name, project.nestedIn === null ? null : path.basename(project.nestedIn)]),
    [
      ['agents-only', null],
      ['outer-app', null],
      ['inner-kit', 'outer-app'],
      ['worktree-kit', 'outer-app'],
      ['far-kit', 'outer-app'],
      ['deep-kit', 'inner-kit'],
    ],
  );
  const deep = nested.files.find((file) => file.path.endsWith('deep-kit/CLAUDE.md'));
  assert.deepEqual([deep.kind, path.basename(deep.project)], ['memory', 'deep-kit'], 'its memory file is its own, not nested memory of the repository around it');
  assert.ok(!JSON.stringify(nested).includes('NODE-MODULES-LINE') && !JSON.stringify(nested).includes('some-package'));

  // A nested repository that is named as a project is a project, whether or not nested ones are asked for.
  const named = scan({ home: local.home, projects: [outer, path.join(outer, 'clones', 'inner-kit')] });
  assert.deepEqual(named.projects.map((project) => [project.name, project.nestedIn]), [
    ['outer-app', null],
    ['inner-kit', null],
  ]);
  assert.equal(named.nestedRepositories.find((entry) => entry.name === 'inner-kit').included, true);
  assert.ok(!named.files.some((file) => file.kind === 'memory-nested' && file.path.includes('/inner-kit/')));
});

test('the home-folder search finds a nested repository below a project it found', (t) => {
  const local = materialise('field');
  t.after(() => local.cleanup());
  const project = path.join(local.home, 'work', 'found-app');
  write(path.join(project, 'CLAUDE.md'), '# found-app\n');
  write(path.join(project, 'libs', 'kit', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(project, 'libs', 'kit', 'CLAUDE.md'), '# kit\n');
  const plain = scan({ home: local.home, machine: true });
  assert.deepEqual(plain.projects.map((entry) => entry.name), ['found-app']);
  assert.deepEqual(plain.nestedRepositories.map((entry) => [entry.name, entry.included]), [['kit', false]]);
  const nested = scan({ home: local.home, machine: true, nested: true });
  assert.deepEqual(nested.projects.map((entry) => [entry.name, entry.nestedIn === null ? null : path.basename(entry.nestedIn)]), [
    ['found-app', null],
    ['kit', 'found-app'],
  ]);
});
