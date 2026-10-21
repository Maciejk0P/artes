// Contracts of the console as a whole: every question has a flag, every flag is told about,
// every string of the console is used and exists for every case a template can ask for.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, SCRIPTS, SKILL_DIR, load } from './helpers/fixtures.mjs';
import { LAUNCHER } from './helpers/console.mjs';

const { CHECKS } = await load('checks.mjs');
const { SUGGESTION_KINDS } = await load('lib/kinds.mjs');
const render = await load('lib/render.mjs');
const { LANGS, STRINGS } = await load('lib/strings.mjs');
const { CHANGES, NEVER } = await load('lib/promise.mjs');
const { BY_HAND, SUBCOMMANDS } = await load('ui.mjs');
const launcher = await import(pathToFileURL(LAUNCHER).href);

const read = (...parts) => readFileSync(path.join(PACKAGE_ROOT, ...parts), 'utf8');

function sources() {
  const files = [LAUNCHER];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.mjs') && name !== 'strings.mjs') files.push(full);
    }
  };
  walk(SCRIPTS);
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

test('every question of the launcher has a flag, and --help and the README name every flag', () => {
  const flags = Object.keys(launcher.OPTIONS);
  // The three questions: language, scope (three answers), nested repositories. After the report
  // nothing is asked: the launcher opens nothing and starts nothing, so there is nothing to choose.
  assert.deepEqual(flags, ['lang', 'user-only', 'projects', 'machine', 'nested', 'plain', 'ascii', 'color', 'home', 'max-files', 'max-dirs', 'max-depth', 'help', 'version']);
  const readme = read('README.md');
  const told = flags.filter((flag) => !flag.startsWith('max-'));
  for (const lang of LANGS) {
    const help = STRINGS[lang]['ui.help'];
    for (const flag of told) assert.ok(help.includes(`--${flag}`), `--help (${lang}) does not name --${flag}`);
    // And --help names no option the launcher does not have.
    for (const named of help.match(/--[a-z][a-z-]*/g)) assert.ok(flags.includes(named.slice(2)), `--help (${lang}) names ${named}, which the launcher does not have`);
    for (const line of help.split('\n')) assert.ok([...line].length <= 76, `a line of --help (${lang}) is ${[...line].length} wide: ${line}`);
  }
  // --plain is said in --help as the table of the README says it: the two lists do not wait.
  // Every question still waits for its answer, so "nothing waits" would be false.
  const plainRow = /^\| `--plain` \| (.+) \|$/m.exec(readme)?.[1];
  assert.equal(plainRow, 'no colour, and the two lists do not wait for Enter');
  const said = { en: /^ {2}--plain {16}no colour, and the two lists do not wait for Enter$/m, sk: /^ {2}--plain {16}bez farieb; dva zoznamy nečakajú na Enter$/m };
  for (const lang of LANGS) {
    const help = STRINGS[lang]['ui.help'];
    assert.match(help, said[lang], `--help (${lang}) does not say of --plain what the README says`);
    assert.ok(!/nothing waits|bez čakania/i.test(help), `--help (${lang}) says that nothing waits for Enter; every question does`);
  }
  for (const flag of told.filter((name) => !['help', 'version'].includes(name))) assert.ok(readme.includes(`\`--${flag}`), `the README does not name --${flag}`);
  // The table of options in the README has a row for each of them and for nothing else.
  const rows = [...readme.matchAll(/^\| `--([a-z][a-z-]*)[^`]*` \|/gm)].map((match) => match[1]);
  assert.deepEqual(rows, told.filter((name) => !['help', 'version'].includes(name)), 'the table of options in the README is not the options of the launcher');
});

test('the README, --help and the wizard prompt describe a launcher that opens nothing, starts nothing and reads no single key', () => {
  const readme = read('README.md');
  const section = (heading) => {
    const start = readme.indexOf(`\n${heading}\n`);
    assert.ok(start !== -1, `the README has no section "${heading}"`);
    const next = readme.indexOf('\n## ', start + 1);
    return readme.slice(start, next === -1 ? undefined : next);
  };
  // What the cuts of 2 Oct 2026 removed, in the words the old text used for it.
  const gone = [
    [/--then\b|--no-open\b/, 'an option that chose what the launcher script started'],
    [/arrow keys?|←|→ arrows|left and right arrows|single keys?/i, 'keys that are no longer read'],
    [/cursor movement|repaint|one page whose panels|collapses to one line|viewer/i, 'a screen that changed in place'],
    [/CLAUDE_HEALTH_NEXT|CLAUDE_HEALTH_OPENER/, 'what the launcher and its script passed between them'],
    [/claude "\/+claude-health/, 'a command line whose argument begins with a slash'],
    [/two slashes|MSYS/, 'a spelling for one shell'],
  ];
  const launcherText = ['## Run it', '## What happens, step by step', '## The launcher', '## Inside Claude Code', '## What it never does', '## Tests', '## Layout'].map(section).join('\n');
  for (const [pattern, what] of gone) assert.ok(!pattern.test(launcherText), `the README still describes ${what}: ${pattern.exec(launcherText)?.[0]}`);
  // What the launcher scripts start, said where a reader looks for it.
  const never = section('## What it never does');
  assert.match(never, /the two launcher scripts start Node, with\s+the check, and nothing else/);
  assert.match(section('## The launcher'), /opens no browser and does not start Claude Code/);
  // How to continue, as the launcher prints it: the two lines, each alone.
  const steps = section('## What happens, step by step');
  assert.match(steps, /\n {3}claude\n/);
  assert.match(steps, /\n {3}\/claude-health resume <stamp>\n/);
  for (const lang of LANGS) {
    const help = STRINGS[lang]['ui.help'];
    for (const [pattern, what] of gone) assert.ok(!pattern.test(help), `--help (${lang}) still describes ${what}`);
    assert.ok(!/browser|prehliadač/i.test(help), `--help (${lang}) speaks of a browser`);
    // No string of the console names a key that is not read, or says that Claude Code is being started.
    const console_ = Object.entries(STRINGS[lang]).filter(([key]) => key.startsWith('ui.'));
    for (const [key, text] of console_) {
      assert.ok(!/Starting Claude Code|Spúšťam Claude Code|\{up\}|\{down\}|\{left\}|\{right\}|q quit|q koniec|\{command\}/i.test(text), `${lang} ${key} names what the cuts removed: ${text}`);
    }
    // A browser is spoken of in three places, and all three are said inside Claude Code by the
    // session: the two pickers that offer to open a report, which the person answers there, and
    // the line that says report 1 was written again. The launcher has no such sentence.
    assert.deepEqual(console_.filter(([, text]) => /browser|prehliadač/i.test(text)).map(([key]) => key), ['ui.judged.report', 'ui.pick.report1.q', 'ui.pick.report2.q'], lang);
  }
  // The wizard prompt: a run is picked up because the person typed the command, not because a script started the session.
  const skill = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(skill, /`resume <stamp>`: a launcher did the first half in a terminal and printed this command;\s+the user started Claude Code and typed it\./);
  assert.ok(!/handed over|hand-over|started by the launcher|the launcher starts/i.test(skill), 'the wizard prompt still speaks of a hand-over');
});

test('the README gives the three launch lines and says what the tool reads and never reads', () => {
  const readme = read('README.md');
  assert.match(readme, /^cmd {10}claude-health check$/m);
  assert.match(readme, /^PowerShell {3}\.\\claude-health check$/m);
  assert.match(readme, /^sh {11}\.\/claude-health check$/m);
  const order = ['## What it does', '## What it does not do', '## Run it', '## What it reads', '## What happens, step by step', '## Use it in every project', '## How this differs from what Claude Code has built in', '## The launcher', '## What it never does'];
  const at = order.map((heading) => readme.indexOf(`\n${heading}\n`));
  assert.ok(at.every((index) => index !== -1), `a section is missing: ${order.filter((_, index) => at[index] === -1).join(', ')}`);
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'the ninety-second part comes first, the reference after');
  assert.ok(readme.indexOf('```\ncmd') < 4200, 'the launch lines are too far down');
  for (const builtIn of ['`/memory`', '`/context`', '`/doctor`', '`/doctor prompt-audit`']) assert.ok(readme.includes(builtIn), `the README does not compare with ${builtIn}`);

  // "What it does not do": short bullets right after what it does, and the long form further down, linked.
  const section = (heading) => {
    const start = readme.indexOf(`\n${heading}\n`);
    const next = readme.indexOf('\n## ', start + 1);
    return readme.slice(start + heading.length + 2, next === -1 ? undefined : next);
  };
  const not = section('## What it does not do');
  const bullets = not.split('\n### ')[0].split('\n').filter((line) => line.startsWith('- '));
  assert.ok(bullets.length >= 6 && bullets.length <= 8, `${bullets.length} bullets`);
  for (const bullet of bullets) assert.ok(bullet.length <= 130, `a bullet is not short: ${bullet}`);
  const said = (pattern, what) => assert.match(not, pattern, `"What it does not do" does not say: ${what}`);
  said(/source code/, 'no source code');
  said(/session transcript/, 'no session transcripts');
  said(/sends nothing anywhere/i, 'nothing sent anywhere');
  said(/git, secrets or how open your permissions are/, 'no verdict on git, secrets or permissions');
  said(/only at how well the setup works for the AI/, 'what it looks at instead');
  said(/quality of what a skill says/, 'no judgement of the content of a skill');
  said(/tokens of a running session/, 'no token count of a running session');
  said(/whether a hook script works/, 'no check of a hook script');
  // The rest of the list is the screen the tool itself shows: no yes, no change; no apply-all;
  // nothing deleted or overwritten; other people's skills; nothing outside the setup.
  said(/### What it changes, and what it never changes\n/, 'the two lists');
  for (const line of ['only after your yes to that one change', 'there is no "apply all"', 'none is deleted, none is overwritten', 'third-party skills', 'anything outside your Claude Code setup']) {
    assert.ok(not.includes(line), `"What it does not do" does not say: ${line}`);
  }
  said(/\[What it never does\]\(#what-it-never-does\)/, 'where the long form is');
  // Nothing is said twice in two wordings: the short section speaks of changes only through the two lists.
  assert.ok(!bullets.some((bullet) => /overwrit|delet|apply all|third-party|other people/i.test(bullet)), 'a bullet repeats a line of the two lists');
  // The section on what is read says what is read; what is never read is in the list above it.
  assert.ok(!/\| Never \|/.test(section('## What it reads')), 'the "never" column is back');
  // The sample screen is a real one: the overview panel of the main fixture, as the golden file has it.
  const golden = read('tests', 'golden', 'launcher.en.unicode.txt');
  const sample = /```\n( {5}\[ Overview \][\s\S]*?)\n {3}```/.exec(readme)[1].split('\n').map((line) => line.slice(3));
  for (const line of sample.filter((text) => text.trim() !== '')) assert.ok(golden.includes(`\n${line}\n`), `the sample screen of the README is not what the tool prints: ${line}`);
  // Every subcommand of the wizard's script is in the reference, and the layout lists the new files.
  for (const name of SUBCOMMANDS) assert.ok(new RegExp(`ui\\.mjs.*\\b${name}\\b`).test(readme), `the README does not list ui.mjs ${name}`);
  for (const file of ['claude-health, claude-health.cmd', 'bin/claude-health.mjs', 'recipes.md', 'ui.mjs', 'lib/pipeline.mjs', 'lib/render.mjs', 'lib/prompt.mjs', 'lib/surroundings.mjs', 'lib/term.mjs', 'tests/golden/']) {
    assert.ok(readme.includes(file), `the layout does not list ${file}`);
  }
  assert.equal(JSON.parse(read('package.json')).scripts.check, 'node bin/claude-health.mjs check');
});

test('nothing a person is shown is a command line with an argument that begins with a slash', () => {
  // Git Bash rewrites such an argument into a Windows path before a Windows program sees it.
  // The launcher, the session, the README and the golden copies of both are looked through: a
  // program a person could be asked to start, followed by an argument that begins with a slash,
  // bare or in quotes. A command of Claude Code stands alone, with nothing in front of it.
  // Options may stand between the program and that argument.
  const risky = /(?:^|[\s`"'(])(?:claude|claude-health(?:\.cmd)?|node|npx|sh|bash|cmd|powershell|explorer(?:\.exe)?|open|xdg-open|start)(?:[ \t]+--?[A-Za-z][\w-]*)*[ \t]+["'`]?\/+[A-Za-z]/m;
  assert.match('  run   claude "/claude-health resume 20261001-131730"', risky, 'the pattern no longer finds what it is there to find');
  assert.match('claude //claude-health resume 20261001-131730', risky);
  assert.match('claude --continue "/claude-health resume 20261001-131730"', risky);
  assert.match('claude -p --verbose /claude-health', risky);
  assert.doesNotMatch('         /claude-health resume 20261001-131730', risky);
  assert.doesNotMatch('open a terminal in the folder of this tool:\n         /work/demo/tool', risky);
  assert.doesNotMatch('./claude-health check --lang en --projects ~/work/my-project', risky);
  const golden = path.join(PACKAGE_ROOT, 'tests', 'golden');
  const texts = [
    ...LANGS.flatMap((lang) => Object.entries(STRINGS[lang]).map(([key, text]) => [`${lang} ${key}`, text])),
    ...readdirSync(golden).map((name) => [`tests/golden/${name}`, readFileSync(path.join(golden, name), 'utf8')]),
    ['README.md', read('README.md')],
    // What the scripts say outside the string table: refusals and the next step they name.
    ...[LAUNCHER, path.join(SCRIPTS, 'ui.mjs'), path.join(SCRIPTS, 'lib', 'pipeline.mjs'), path.join(SCRIPTS, 'lib', 'render.mjs')].map((file) => [path.basename(file), (readFileSync(file, 'utf8').match(/(['`])(?:(?!\1).)*\1/g) ?? []).join('\n')]),
  ];
  assert.ok(texts.length > 1000 && texts.some(([name]) => name === 'tests/golden/session.en.txt'), 'almost nothing was looked through');
  for (const [name, text] of texts) assert.ok(!risky.test(text), `${name} holds a command line whose argument begins with a slash: ${risky.exec(text)?.[0]}`);
  // Where the command of Claude Code is printed, it is the whole line.
  for (const name of readdirSync(golden)) {
    for (const line of readFileSync(path.join(golden, name), 'utf8').split('\n')) {
      if (/\/claude-health(?![\w-])/.test(line)) assert.match(line, /^\s+\/claude-health resume (\d{8}-\d{6}|STAMP)$/, `${name}: ${line}`);
    }
  }
});

test('every string of the console is used, and exists for every case a template asks for', () => {
  const source = sources();
  const prefixes = [...new Set([...source.matchAll(/[`'](ui\.[\w.-]*?)\$\{/g)].map((match) => match[1]))];
  const dead = Object.keys(STRINGS.en).filter((key) => key.startsWith('ui.') && !source.includes(`'${key}'`) && !prefixes.some((prefix) => key.startsWith(prefix)));
  assert.deepEqual(dead, [], 'strings nothing asks for');
  const needed = [
    ...render.STEPS.map((step) => `ui.rail.${step}`),
    ...render.PANELS.map((panel) => `ui.tab.${panel}`),
    ...['high', 'medium', 'low', 'review'].map((key) => `ui.sev.${key}`),
    ...['user', 'project', 'imports', 'rules', 'autoMemory', 'listing'].flatMap((key) => [`ui.stage.${key}`, `ui.stage.${key}.short`]),
    ...['user', 'projects', 'nested', 'imports', 'settings', 'checks', 'tax', 'report'].map((key) => `ui.progress.${key}.k`),
    ...['language', 'scope', 'nested'].map((key) => `ui.answer.${key}`),
    ...['title', 'needs', 's1', 's1.then', 's2', 'waits', 'stale'].map((key) => `ui.next.${key}`),
    ...['missing', 'none', 'session', 'found', 'ask', 'outside'].map((key) => `ui.scope.folder.${key}`),
    ...['applied', 'by-hand', 'still-there', 'skipped', 'skipped-kind', 'skipped-file', 'resolved', 'stopped'].map((status) => `ui.receipt.${status}`),
    ...[...CHANGES.map((line) => line.key), 'folder'].map((key) => `ui.promise.changes.${key}`),
    ...NEVER.map((key) => `ui.promise.never.${key}`),
    ...['lines', 'created', 'settings', 'kept', 'nochange'].map((part) => `ui.receipt.part.${part}`),
    ...[...SUGGESTION_KINDS, 'byhand'].map((kind) => `ui.pick.card.q.${kind}`),
    ...BY_HAND.map((check) => `ui.manual.${check}`),
    ...LANGS.flatMap((lang) => [`ui.lang.${lang}`, `ui.pick.lang.${lang}.d`]),
  ];
  for (const lang of LANGS) {
    for (const key of needed) assert.ok(typeof STRINGS[lang][key] === 'string', `${lang} lacks ${key}`);
  }
  assert.ok(BY_HAND.every((check) => CHECKS.includes(check)), 'a by-hand card for a check that does not exist');
  // The walk is ordered by file (lib/order.mjs), so no kind of change needs a rank of its own;
  // what every kind does need is its name on a card and in the header of a file.
  for (const lang of LANGS) for (const kind of SUGGESTION_KINDS) assert.ok(STRINGS[lang][`suggestion.${kind}`], `${lang} lacks the name of ${kind}`);
  // A card question is a question, and names the place it is about where it has one.
  for (const lang of LANGS) {
    for (const kind of [...SUGGESTION_KINDS, 'byhand']) assert.ok(STRINGS[lang][`ui.pick.card.q.${kind}`].endsWith('?'), `${lang} ${kind}`);
  }
});

test('glyphs are placeholders in the console strings, so the ASCII skin can replace every one', () => {
  for (const lang of LANGS) {
    for (const [key, text] of Object.entries(STRINGS[lang])) {
      if (!key.startsWith('ui.')) continue;
      assert.ok(!/[·…→≈≠×─►│√▲■●○█░▓║↑↓←]/.test(text), `${lang} ${key} holds a glyph; use its placeholder`);
    }
  }
  const o = { lang: 'en', colour: false, unicode: false };
  assert.equal(render.text(o)('ui.next.report'), 'Report 1 - the state of your setup');
  assert.equal(render.text({ ...o, unicode: true })('ui.next.report'), 'Report 1 · the state of your setup');
  assert.equal(render.text(o)('ui.context.moreplaces', { count: 2 }), '... 2 more places in the report');
  assert.equal(render.text({ ...o, unicode: true })('ui.context.moreplaces', { count: 2 }), '… 2 more places in the report');
  // English needs two forms of a noun; the form follows the number.
  assert.equal(render.text(o)('ui.overview.counts', { files: 1, projects: 2 }), '1 file - 2 projects');
  assert.equal(render.text(o)('ui.overview.counts', { files: 30, projects: 1 }), '30 files - 1 project');
  assert.throws(() => render.text(o)('ui.overview.counts', { files: 1 }), /needs a value for \{projects\}/);
  assert.throws(() => render.text(o)('ui.no.such.key'), /Unknown string/);
});
