// The launcher from end to end: with flags and no keyboard, with answers piped in, and with a
// fake terminal on both ends whose lines are typed by the test.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, SCRIPTS, SKILL_DIR, emptySetup, load, materialise } from './helpers/fixtures.mjs';
import { KEY_TIMEOUT, LAUNCHER, changedFiles, childEnv, controlsIn, fakeInput, fakeOutput, listing, playWindow, readJson, runLauncher } from './helpers/console.mjs';

const { STAMP_PATTERN, VERSION, isStamp, projectsIn } = await load('lib/pipeline.mjs');
const { LANGS, STRINGS } = await load('lib/strings.mjs');
const { strip, widthOf } = await load('lib/term.mjs');
const launcher = await import(pathToFileURL(LAUNCHER).href);
const { main } = launcher;

const STAMP = /\d{8}-\d{6}/;
const NOT_ASCII = /[^\x00-\x7f -ſ]/;

function fixture(t, name = 'main') {
  const fx = materialise(name);
  t.after(() => fx.cleanup());
  return fx;
}

const stampOf = (text) => STAMP.exec(text)[0];
const healthOf = (fx) => path.join(fx.home, '.claude', 'health-check');

// The folder of this tool as the launcher prints it, on a line of its own: the one place where
// Claude Code has the skill. Like the link it is never cut, whatever its length.
const TOOL_FOLDER = path.resolve(PACKAGE_ROOT).replace(/\\/g, '/');
const TOOL_LINE = `         ${TOOL_FOLDER}`;
const neverCut = (line) => /^\s*file:\/\//.test(line) || line === TOOL_LINE;
// The lines on which `claude` stands as a command: not as part of a path, a file name or the
// name of this tool.
const commandLines = (out) => out.split('\n').filter((line) => line !== TOOL_LINE && /(?<![\w./-])claude(?![\w./-])/.test(line));
// The lines that hold the command typed inside Claude Code.
const insideLines = (out) => out.split('\n').filter((line) => line !== TOOL_LINE && /\/claude-health(?![\w-])/.test(line));

test('a run with flags needs no keyboard and writes the run folder and report 1, nothing else', (t) => {
  const fx = fixture(t);
  const before = listing(fx.root);
  const result = runLauncher(['check', '--lang', 'en', '--projects', fx.projects, '--plain'], { home: fx.home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const stamp = stampOf(result.stdout);
  assert.deepEqual(changedFiles(before, listing(fx.root)), [
    `home/.claude/health-check/run-${stamp}/checks.json`,
    `home/.claude/health-check/run-${stamp}/scan.json`,
    `home/.claude/health-check/run-${stamp}/session.json`,
    `home/.claude/health-check/state-${stamp}.html`,
  ]);

  const out = result.stdout;
  assert.ok(!out.includes('\u001b'), 'plain output holds no escape byte');
  for (const line of out.split('\n')) {
    if (!neverCut(line)) assert.ok(widthOf(line) <= 76, `${widthOf(line)} wide: ${line}`);
    assert.ok(!/\s$/.test(line), `a line ends in a space: "${line}"`);
  }
  // The sequence: banner, the two lists, the answers the flags gave, progress, four panels, the
  // link, how to continue.
  const order = [
    'A health check of your Claude Code setup.',
    // What it changes and what it never changes: said before anything is read.
    'WHAT IT CHANGES       only after your yes to that one change, backup first',
    '· settings: a hook or a permission rule is added, nothing is removed',
    'WHAT IT NEVER CHANGES',
    '· git: it does not stage, commit or upload',
    '√ Language  English',
    '√ Scope     user files + 2 projects (alpha-service, beta-tool)',
    '√ User files   21 files in ~/.claude',
    '√ Checks       29 checks · 18 findings · 15 candidates · 1 to review',
    'Done in ',
    '[ Overview ]   Findings 18     Context     Skills 9',
    'MEMORY FILES',
    '  Overview   [ Findings 18 ]   Context     Skills 9',
    'Candidates found by words only: 15. Claude reads them next.',
    '  Overview     Findings 18   [ Context ]   Skills 9',
    'CONTEXT TAX',
    '  Overview     Findings 18     Context   [ Skills 9 ]',
    'User skills · ~/.claude/skills (8)',
    'Report 1 · the state of your setup',
    `state-${stamp}.html`,
    '── How to continue ──',
    'Stopped here. Nothing was changed.',
    'The changes need Claude Code:',
    // The skill is a project skill of the tool's folder: Claude Code is started there, and the
    // folder is named, because the launcher may have been started from anywhere.
    `    1  open a terminal in the folder of this tool:\n${TOOL_LINE}\n       and start Claude Code there:\n         claude\n`,
    `    2  inside Claude Code, type:\n         /claude-health resume ${stamp}\n`,
    `The run folder waits in ~/.claude/health-check/run-${stamp}.`,
    'If your files change before you resume, the wizard scans again first.\n',
  ];
  let at = 0;
  for (const text of order) {
    const found = out.indexOf(text, at);
    assert.ok(found !== -1, `"${text}" is missing, or out of order`);
    at = found + text.length;
  }
  assert.equal(at, out.length, 'something is printed after how to continue');
  assert.ok(!out.includes('?  '), 'no question was asked');
  assert.ok(!/Type 1-/.test(out), 'no question was asked');
  assert.equal((out.match(/► REPORT/g) ?? []).length, 1, 'the rail of the report step is printed once');
  for (const [name, count] of [['[ Overview ]', 1], ['[ Findings 18 ]', 1], ['[ Context ]', 1], ['[ Skills 9 ]', 1]]) assert.equal(out.split(name).length - 1, count, `the panel ${name} is printed once`);

  const url = /file:\/\/\S+/.exec(out)[0];
  assert.equal(url, pathToFileURL(path.join(healthOf(fx), `state-${stamp}.html`)).href);
  const session = readJson(path.join(healthOf(fx), `run-${stamp}`, 'session.json'));
  assert.deepEqual(
    { version: session.version, tool: session.tool, stamp: session.stamp, lang: session.lang, startedBy: session.startedBy, machine: session.scope.machine, nested: session.scope.nested },
    { version: 1, tool: VERSION, stamp, lang: 'en', startedBy: 'launcher', machine: false, nested: false },
  );
  assert.deepEqual(session.scope.resolved, [fx.project('alpha-service'), fx.project('beta-tool')]);
  assert.equal(readJson(path.join(healthOf(fx), `run-${stamp}`, 'scan.json')).projects.length, 2);
  assert.equal(readJson(path.join(healthOf(fx), `run-${stamp}`, 'checks.json')).findings.length, 18);
  assert.match(readFileSync(path.join(healthOf(fx), `state-${stamp}.html`), 'utf8'), /^<!doctype html>/);
});

test('the clean fixture in Slovak: nothing to change, and nothing to continue', (t) => {
  const fx = fixture(t, 'clean');
  const before = listing(fx.root);
  const result = runLauncher(['check', '--lang', 'sk', '--projects', fx.projects], { home: fx.home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Kontrola tvojho nastavenia Claude Code\./);
  assert.match(result.stdout, /\n {2}ČO MENÍ {5,}až po tvojom áno na tú jednu zmenu, najprv záloha\n[\s\S]*\n {2}ČO NIKDY NEMENÍ\n {2}· zdrojový kód ani nič mimo tvojho nastavenia Claude Code\n/);
  assert.ok(result.stdout.indexOf('ČO NIKDY NEMENÍ') < result.stdout.indexOf('√ Jazyk'), 'the two lists come before anything is read');
  assert.match(result.stdout, /√ Jazyk {5}Slovensky/);
  assert.match(result.stdout, /Správa 1 · stav tvojho nastavenia\n {2}file:\/\/\S+\n\n {2}√ Nie je čo meniť\. To je dobrý výsledok\.\n$/, 'the run ends with the link and the good news');
  assert.deepEqual([commandLines(result.stdout), insideLines(result.stdout)], [[], []], 'there is nothing to resume');
  assert.equal(changedFiles(before, listing(fx.root)).length, 4);
});

test('colour can be forced, and adds nothing but escape codes; --ascii drops the glyphs', (t) => {
  const fx = fixture(t);
  const args = ['check', '--lang', 'en', '--projects', fx.projects];
  const normal = (text) => strip(text).replace(/\d{8}-\d{6}/g, 'STAMP').replace(/\d+ ms/g, 'N ms').replace(/Done in [\d.]+ s/, 'Done in N s').replace(/ +(?=N ms)/g, ' ');
  const plain = runLauncher([...args, '--plain'], { home: fx.home });
  const coloured = runLauncher([...args, '--color'], { home: fx.home });
  assert.equal(coloured.status, 0, coloured.stderr);
  assert.match(coloured.stdout, /\u001b\[31m▲\u001b\[0m 1 high/);
  assert.equal(normal(coloured.stdout), normal(plain.stdout));
  assert.deepEqual(controlsIn(coloured.stdout), [], 'colour is the only thing a terminal is asked to do');

  const ascii = runLauncher([...args, '--ascii'], { home: fx.home });
  assert.equal(ascii.status, 0, ascii.stderr);
  assert.ok(!NOT_ASCII.test(ascii.stdout), `a glyph outside ASCII: ${NOT_ASCII.exec(ascii.stdout)}`);
  assert.match(ascii.stdout, /! HIGH 1/);
  const env = runLauncher(args, { home: fx.home, env: { NO_COLOR: '1', CLAUDE_HEALTH_ASCII: '1' } });
  assert.ok(!NOT_ASCII.test(env.stdout) && !env.stdout.includes('\u001b'));
  const forced = runLauncher(args, { home: fx.home, env: { FORCE_COLOR: '1' } });
  assert.ok(forced.stdout.includes('\u001b[31m'));
});

// --- after the report --------------------------------------------------------------------------------

test('after the report: the link, then how to continue as two lines no shell can damage', (t) => {
  const fx = fixture(t);
  for (const lang of LANGS) {
    for (const [name, extra, env] of [['plain', ['--plain'], {}], ['a terminal', [], { CLAUDE_HEALTH_TTY: '1' }], ['colour', ['--color'], {}], ['ascii', ['--ascii'], {}], ['a pipe', [], {}]]) {
      const result = runLauncher(['check', '--lang', lang, '--user-only', ...extra], { home: fx.home, env });
      assert.equal(result.status, 0, `${lang} ${name}: ${result.stderr}`);
      const out = strip(result.stdout);
      const stamp = stampOf(out);
      // Claude Code is started by its bare name, and what it is to be told is typed inside it:
      // each on a line of its own, so nothing that begins with a slash is an argument of anything.
      assert.deepEqual(commandLines(out), ['         claude'], `${lang} ${name}`);
      assert.deepEqual(insideLines(out), [`         /claude-health resume ${stamp}`], `${lang} ${name}`);
      assert.ok(out.indexOf('\n         claude\n') < out.indexOf('\n         /claude-health resume'), 'start first, then type');
      assert.match(out, /\n {2}file:\/\/\S+state-\d{8}-\d{6}\.html\n\n {2}[─-]{2} /, 'the link stands right above how to continue');
      assert.ok(!/["'`]\s*\/+claude-health|claude\s+["'`]?\//.test(out), `${lang} ${name}: a command line with an argument that begins with a slash`);
      assert.ok(!/\bresume\b.*\bclaude\b|\bclaude\b.*\bresume\b/.test(out.replaceAll('/claude-health', '')), `${lang} ${name}: the two are on one line`);
    }
  }
  // Nothing in the text the launcher can print asks for a browser, starts Claude Code or names a key.
  for (const lang of LANGS) {
    for (const [key, text] of Object.entries(STRINGS[lang])) {
      if (!key.startsWith('ui.') || key.startsWith('ui.pick.') || key.startsWith('ui.card.') || key.startsWith('ui.summary.')) continue;
      assert.ok(!/claude ["'`/]|\{command\}/.test(text), `${lang} ${key} puts an argument after claude`);
    }
  }
});

test('how to continue names the folder of this tool, wherever the launcher was started from', (t) => {
  const fx = fixture(t);
  // Started by its path from a project, from the home folder and from its own folder: Claude Code
  // has the skill only in the folder of the tool, so that folder is said, on a line of its own.
  const said = { en: ['open a terminal in the folder of this tool:', 'and start Claude Code there:'], sk: ['otvor terminál v priečinku tohto nástroja:', 'a spusti v ňom Claude Code:'] };
  for (const lang of LANGS) {
    for (const cwd of [fx.project('alpha-service'), fx.home, PACKAGE_ROOT]) {
      const result = runLauncher(['check', '--lang', lang, '--user-only', '--plain'], { home: fx.home, cwd });
      assert.equal(result.status, 0, result.stderr);
      const [open, then] = said[lang];
      assert.ok(result.stdout.includes(`\n    1  ${open}\n${TOOL_LINE}\n       ${then}\n         claude\n    2  `), `${lang}, started in ${cwd}: the folder of the tool does not stand above "claude":\n${result.stdout.slice(-700)}`);
      // It is information, not a command line: nothing stands on its line but the folder.
      assert.deepEqual(result.stdout.split('\n').filter((line) => line.includes(TOOL_FOLDER)), [TOOL_LINE], `${lang}, started in ${cwd}`);
    }
  }
  assert.equal(path.relative(TOOL_FOLDER, SKILL_DIR).replace(/\\/g, '/'), '.claude/skills/claude-health', 'the folder that is printed is not the one whose project skills hold this one');
});

// A run with no terminal, in this process, so the platform and the environment can be given.
async function quiet(fx, args, { env = {}, platform = process.platform, input = '' } = {}) {
  const output = fakeOutput({ tty: false });
  const error = fakeOutput({ tty: false });
  const stdin = fakeInput({ tty: false });
  stdin.end(input);
  const code = await main(args, { input: stdin, output, error, env, cwd: PACKAGE_ROOT, platform, home: fx.home, locale: 'en-US' });
  return { code, raw: output.text(), out: strip(output.text()), err: error.text() };
}

const timeless = (text) => text.replace(/\d{8}-\d{6}/g, 'STAMP').replace(/ +\d+ ms/g, ' N ms').replace(/(Done in|Hotovo za) [\d.,]+ s/, '$1 N s');

test('how to continue is the same in every shell: no variable of Git Bash changes a character of the run', async (t) => {
  const fx = fixture(t);
  const args = ['check', '--lang', 'en', '--user-only', '--plain'];
  const plain = await quiet(fx, args, { platform: 'linux' });
  assert.equal(plain.code, 0, plain.err);
  assert.deepEqual(commandLines(plain.out), ['         claude']);
  // Git Bash, Git Bash with its path conversion switched off in each of the three ways, a cmd
  // window that was started from Git Bash and carries its variables, and no Git Bash at all.
  for (const [platform, env] of [
    ['win32', { MSYSTEM: 'MINGW64' }],
    ['win32', { MSYSTEM: 'MINGW64', MSYS_NO_PATHCONV: '1' }],
    ['win32', { MSYSTEM: 'MINGW64', MSYS2_ARG_CONV_EXCL: '*' }],
    ['win32', { MSYSTEM: 'MINGW64', MSYS2_ARG_CONV_EXCL: '--path=' }],
    ['win32', { MSYSTEM: 'MINGW64', MSYS2_ARG_CONV_EXCL: '' }],
    ['win32', { MSYSTEM: 'MSYS', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PROMPT: '$P$G' }],
    ['win32', {}],
    ['linux', { MSYSTEM: 'MINGW64' }],
    ['darwin', {}],
  ]) {
    const other = await quiet(fx, args, { platform, env });
    assert.equal(other.code, 0, other.err);
    assert.equal(timeless(other.out), timeless(plain.out), `${platform} ${JSON.stringify(env)}`);
  }
});

test('nothing is opened and nothing is started: no request is written, and the options that asked for one are gone', (t) => {
  const fx = fixture(t);
  // What the shell script once prepared for the launcher: the name of a file for one line.
  const next = path.join(fx.root, 'next.txt');
  const precious = path.join(fx.root, 'precious.txt');
  writeFileSync(precious, 'a file of yours\n');
  const before = listing(fx.root);
  for (const file of [next, precious]) {
    const result = runLauncher(['check', '--lang', 'en', '--user-only'], { home: fx.home, env: { CLAUDE_HEALTH_NEXT: file, CLAUDE_HEALTH_TTY: '1', CLAUDE_HEALTH_OPENER: path.join(fx.root, 'opener') } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(commandLines(strip(result.stdout)), ['         claude']);
  }
  assert.ok(!existsSync(next), 'a request for the shell script was written');
  assert.equal(readFileSync(precious, 'utf8'), 'a file of yours\n');
  const written = changedFiles(before, listing(fx.root));
  assert.equal(written.length, 8, written.join(', '));
  assert.ok(written.every((file) => file.startsWith('home/.claude/health-check/')), written.join(', '));

  assert.deepEqual(Object.keys(launcher).sort(), ['OPTIONS', 'main'], 'the launcher exports the table of what "what next?" asked the shell script for');
  for (const [args, message] of [
    [['check', '--then', 'quit'], /Unknown option --then/],
    [['check', '--then', 'report'], /Unknown option --then/],
    [['check', '--no-open'], /Unknown option --no-open/],
  ]) {
    const refused = runLauncher(['--lang', 'en', ...args], { home: fx.home });
    assert.equal(refused.status, 2, args.join(' '));
    assert.match(refused.stderr, message);
    assert.equal(refused.stdout, '');
  }
  // No module of the package looks for a program on the PATH or names the file of a request.
  for (const file of [LAUNCHER, ...readdirSync(SCRIPTS).filter((name) => name.endsWith('.mjs')).map((name) => path.join(SCRIPTS, name)), ...readdirSync(path.join(SCRIPTS, 'lib')).map((name) => path.join(SCRIPTS, 'lib', name))]) {
    const source = readFileSync(file, 'utf8');
    for (const gone of [/CLAUDE_HEALTH_NEXT/, /CLAUDE_HEALTH_OPENER/, /PATHEXT/, /\bonPath\b/, /MSYS_NO_PATHCONV|MSYS2_ARG_CONV_EXCL/]) assert.ok(!gone.test(source), `${path.basename(file)} still holds ${gone}`);
  }
});

// --- answers from standard input ------------------------------------------------------------------------

test('every question is a numbered list, answered by a number and Enter, and answers come from standard input', (t) => {
  const fx = fixture(t);
  // Slovak, folders I name, one folder, end of the list.
  const input = `2\n3\n${fx.projects}\n\n`;
  const result = runLauncher(['check', '--plain'], { home: fx.home, input });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, /\? Language \/ Jazyk\n {4}1 {2}English\n {4}2 {2}Slovensky\n {2}Type 1-2 and press Enter \[\d\]: 2\n/);
  // The two lists follow the language at once, in that language, and take no line of the input.
  assert.match(out, /Enter \[\d\]: 2\n\n {2}ČO MENÍ {5,}\S[\s\S]*\n {2}· git: nič nepridáva do indexu, necommituje a neodosiela\n\n {2}√ Jazyk ─ ► ROZSAH/);
  assert.match(out, /√ Jazyk {5}Slovensky/);
  assert.match(out, /Napíš 1-3 a stlač Enter \[1\]: 3\n\n {2}\? Priečinok/, 'a blank line stands between an answer and the next question');
  assert.match(out, /\? Priečinok \(prázdny riadok ukončí zoznam\)\n {2}› .*projects\n {4}√ nájdené projekty: 2 · alpha-service, beta-tool\n {2}› \n/);
  assert.match(out, /√ Rozsah {4}používateľské súbory \+ projekty: 2 \(alpha-service, beta-tool\)/);
  // After the report nothing is asked: the link, then how to continue.
  assert.match(out, /── Ako pokračovať ─+\n {2}Tu sa končí\. Nič sa nezmenilo\.\n {2}Na zmeny treba Claude Code:\n\n {4}1 {2}otvor terminál v priečinku tohto nástroja:\n {9}\S[^\n]*\n {7}a spusti v ňom Claude Code:\n {9}claude\n {4}2 {2}v Claude Code napíš:\n {9}\/claude-health resume \d{8}-\d{6}\n/);
  assert.equal((out.match(/Enter \[\d\]:/g) ?? []).length, 2, 'two questions were asked, and none after the report');
  assert.ok(!out.includes('\u001b'));

  // A bare Enter takes the default, which the prompt names.
  const defaults = runLauncher(['check', '--plain'], { home: fx.home, input: '\n\n' });
  assert.match(defaults.stdout, /Type 1-2 and press Enter \[1\]: \n/);
  assert.match(defaults.stdout, /√ Language {2}English/);
  assert.match(defaults.stdout, /Type 1-3 and press Enter \[1\]: \n/);
  assert.match(defaults.stdout, /√ Scope {5}user files only/);
  assert.ok(!defaults.stdout.includes('No more input'));

  // What is no number of the list is said once, and the question waits.
  const wrong = runLauncher(['check', '--lang', 'en', '--plain'], { home: fx.home, input: 'q\n9\n\u001b[B\n1\n' });
  assert.equal((wrong.stdout.match(/Type a number from 1 to 3\./g) ?? []).length, 3);
  assert.match(wrong.stdout, /√ Scope {5}user files only/);

  // A folder that is not there is refused at once, and the list goes on.
  const typo = runLauncher(['check', '--lang', 'en', '--plain'], { home: fx.home, input: `3\n${fx.root}/nowhere\n${fx.project('beta-tool')}\n\n` });
  assert.match(typo.stdout, /× that folder does not exist:\s+\S*nowhere\n {2}› .*beta-tool\n {4}√ projects found: 1 · beta-tool/);
  assert.match(typo.stdout, /√ Scope {5}user files \+ 1 project \(beta-tool\)/);

  // The input ends early: the defaults are taken, and the program says so.
  const ended = runLauncher(['check', '--plain'], { home: fx.home, input: '' });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal((ended.stdout.match(/No more input: the default was taken/g) ?? []).length, 2);
  assert.match(ended.stdout, /√ Scope {5}user files only/);
});

test('the language offered first follows the system: a bare Enter goes on in that language', (t) => {
  const fx = fixture(t);
  const slovak = runLauncher(['check', '--plain'], { home: fx.home, env: { LANG: 'sk_SK.UTF-8', LC_ALL: 'sk_SK.UTF-8' }, input: '\n\n' });
  assert.equal(slovak.status, 0, slovak.stderr);
  // The first question is asked in the language of the system, and its default is that language.
  assert.match(slovak.stdout, /\? Language \/ Jazyk\n {4}1 {2}English\n {4}2 {2}Slovensky\n {2}Napíš 1-2 a stlač Enter \[2\]: \n/);
  assert.match(slovak.stdout, /√ Jazyk {5}Slovensky/);
  assert.match(slovak.stdout, /√ Rozsah {4}len používateľské súbory/);
  const english = runLauncher(['check', '--plain'], { home: fx.home, env: { LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8' }, input: '\n\n' });
  assert.match(english.stdout, /Type 1-2 and press Enter \[1\]: \n/);
  assert.match(english.stdout, /√ Language {2}English/);
  // The other language is one number away, whatever the system says.
  const chosen = runLauncher(['check', '--plain'], { home: fx.home, env: { LANG: 'sk_SK.UTF-8', LC_ALL: 'sk_SK.UTF-8' }, input: '1\n\n' });
  assert.match(chosen.stdout, /√ Language {2}English/);
});

test('the launcher ends by itself and gives the prompt back when the keyboard stays open', { timeout: KEY_TIMEOUT }, async (t) => {
  const fx = fixture(t);
  // A terminal never ends its input. A pipe that is written to and never ended stands in for it:
  // the two answers are typed, and nothing more comes.
  const child = spawn(process.execPath, [LAUNCHER, 'check', '--plain'], { cwd: PACKAGE_ROOT, env: childEnv(fx.home), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (out += chunk));
  child.stdin.write('1\n1\n');
  const ended = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still running'), KEY_TIMEOUT / 2);
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  assert.match(out, /How to continue/, 'the run did not reach its end, so this proves nothing');
  assert.equal(ended, 0, 'everything was printed, and the program still holds the keyboard');
});

test('answers piped into a run whose output is a terminal are not held up by the two lists, and the end of the input ends its line', async (t) => {
  const fx = fixture(t);
  // The output is a terminal and the answers come from a pipe: Enter cannot be pressed, so the
  // lists do not wait, and no answer is taken for that Enter.
  const output = fakeOutput({ tty: true });
  const input = fakeInput({ tty: false });
  const error = fakeOutput({ tty: false });
  input.end(`3\n${fx.projects}\n\n`);
  const code = await main(['check', '--lang', 'en'], { input, output, error, env: { WT_SESSION: '1' }, cwd: PACKAGE_ROOT, platform: process.platform, home: fx.home, locale: 'en-US' });
  assert.equal(code, 0, error.text());
  const out = strip(output.text());
  assert.ok(!out.includes('Press Enter to continue'), 'the two lists waited for an Enter that nobody can press');
  assert.match(out, /√ Scope {5}user files \+ 2 projects \(alpha-service, beta-tool\)/, 'the answer to the scope was taken for the Enter under the two lists');

  // Where the shell script reports a terminal and the input ends at a question, nobody typed the
  // line break that ends the line of the prompt: the program writes it.
  const cut = strip(runLauncher(['check', '--lang', 'en'], { home: fx.home, env: { CLAUDE_HEALTH_TTY: '1' }, input: '\n' }).stdout);
  assert.match(cut, /\n {2}Type 1-3 and press Enter \[1\]: \n {2}No more input: the default was taken \(1\)\.\n/);
  const folders = strip(runLauncher(['check', '--lang', 'en'], { home: fx.home, env: { CLAUDE_HEALTH_TTY: '1' }, input: '\n3\n' }).stdout);
  assert.match(folders, /\n {2}› \n\n {2}√ Language ─ √ Scope ─ ► SCAN/);
});

test('with a terminal the two lists wait for Enter as a typed line, and only when a question follows', (t) => {
  const fx = fixture(t);
  // The launcher script says a terminal is on both ends; Node sees pipes. Enter, then scope 3 and a folder.
  const result = runLauncher(['check', '--lang', 'sk'], { home: fx.home, env: { CLAUDE_HEALTH_TTY: '1' }, input: `\n3\n${fx.projects}\n\n` });
  assert.equal(result.status, 0, result.stderr);
  const out = strip(result.stdout);
  assert.match(out, /\n {2}· git: nič nepridáva do indexu, necommituje a neodosiela\n\n {2}Pokračuj klávesom Enter: \n? *\n {2}√ Jazyk ─ ► ROZSAH/, 'the lists do not wait before the scope is asked');
  assert.match(out, /√ Rozsah {4}používateľské súbory \+ projekty: 2 \(alpha-service, beta-tool\)/, 'the line typed for the lists was taken for the scope');
  assert.deepEqual(controlsIn(result.stdout), []);
  // With the scope given by a flag nothing is asked next, and nothing waits.
  const flagged = strip(runLauncher(['check', '--lang', 'sk', '--user-only'], { home: fx.home, env: { CLAUDE_HEALTH_TTY: '1' }, input: '' }).stdout);
  assert.ok(!flagged.includes('Pokračuj klávesom Enter'));
  // Answers that come from a pipe are not held up either: one line per question, as before.
  const piped = runLauncher(['check', '--lang', 'en', '--plain'], { home: fx.home, input: '1\n' }).stdout;
  assert.ok(!piped.includes('Press Enter to continue'));
});

test('"this folder" is offered first when the program is started in a project, and never for the tool or the home folder', (t) => {
  const fx = fixture(t);
  const ask = (cwd, input = '') => runLauncher(['check', '--lang', 'en', '--plain'], { home: fx.home, cwd, input }).stdout;
  const inProject = ask(fx.project('alpha-service'), '1\n');
  assert.match(inProject, /\n {4}1 {2}This folder\n {9}\S*alpha-service\n {4}2 {2}Only my user files\n/);
  assert.match(inProject, /Type 1-4 and press Enter \[1\]: 1\n/);
  assert.match(inProject, /√ Scope {5}user files \+ 1 project \(alpha-service\)/);
  // A terminal opens in the home folder, and the home folder has a .claude folder: it is no project.
  for (const cwd of [fx.home, PACKAGE_ROOT]) {
    const out = ask(cwd);
    assert.ok(!out.includes('This folder'), `"this folder" is offered in ${cwd}`);
    assert.match(out, /Type 1-3 and press Enter \[1\]:/);
  }
});

test('repositories nested in a project: left out unless asked for, and the question is asked once', (t) => {
  const fx = fixture(t, 'field');
  const without = runLauncher(['check', '--lang', 'en', '--projects', fx.projects, '--plain'], { home: fx.home });
  assert.match(without.stdout, /√ Nested {7}2 repositories inside projects left out · --nested/);
  assert.match(without.stdout, /√ Projects {5}2 found/);
  const withNested = runLauncher(['check', '--lang', 'en', '--projects', fx.projects, '--nested', '--plain'], { home: fx.home });
  assert.match(withNested.stdout, /√ Projects {5}4 found/);
  assert.ok(!/√ Nested {7}/.test(withNested.stdout));
  assert.equal(readJson(path.join(healthOf(fx), `run-${stampOf(withNested.stdout.split('Report 1')[1])}`, 'session.json')).scope.nested, true);

  // Asked on the keyboard: language is given, scope is "folders I name", then the nested question.
  const asked = runLauncher(['check', '--lang', 'en', '--plain'], { home: fx.home, input: `3\n${fx.projects}\n\n2\n` });
  assert.match(asked.stdout, /Repositories with their own Claude Code files sit inside your projects:\s+2\. Include them\?/);
  assert.match(asked.stdout, /√ Nested {4}included: 2/);
  assert.match(asked.stdout, /√ Projects {5}4 found/);
  assert.equal((asked.stdout.match(/Include them\?/g) ?? []).length, 1);
});

test('the home-folder search by flag: the projects under the home folder, and the folders named next to it', (t) => {
  const fx = fixture(t);
  const machine = runLauncher(['check', '--lang', 'en', '--machine', '--plain'], { home: fx.home });
  assert.equal(machine.status, 0, machine.stderr);
  assert.match(machine.stdout, /√ Scope {5}user files \+ every project under the home folder \(2\)/);
  assert.match(machine.stdout, /√ Projects {5}2 found/);
  const both = runLauncher(['check', '--lang', 'en', '--machine', '--projects', fx.project('beta-tool'), '--plain'], { home: fx.home });
  assert.match(both.stdout, /√ Projects {5}3 found/);
  const session = readJson(path.join(healthOf(fx), `run-${stampOf(both.stdout)}`, 'session.json'));
  assert.deepEqual([session.scope.machine, session.scope.resolved.length], [true, 3]);

  // Asked on the keyboard: the four facts come before the search, then the folders outside.
  const asked = runLauncher(['check', '--lang', 'en', '--plain'], { home: fx.home, input: `2\n${fx.project('beta-tool')}\n\n` });
  assert.match(asked.stdout, /Enter \[1\]: 2\n\n {4}· The search covers your home folder, not the whole machine\.[\s\S]*It may take a minute\.\n {2}\? A project outside your home folder\?/);
  assert.match(asked.stdout, /√ Projects {5}3 found/);
});

test('a run on another home folder (--home) ends at the report: no way on is promised', (t) => {
  const fx = fixture(t);
  const other = fixture(t, 'field');
  // The home folder of this run is fx.home by its environment; --home names another one.
  const result = runLauncher(['check', '--lang', 'en', '--home', other.home, '--user-only'], { home: fx.home, env: { CLAUDE_HEALTH_TTY: '1' } });
  assert.equal(result.status, 0, result.stderr);
  const out = strip(result.stdout);
  assert.match(out, /file:\/\/\S+state-\d{8}-\d{6}\.html/);
  assert.match(out, /This run checked another home folder \(--home\), so it ends at the report\./);
  assert.deepEqual([commandLines(out), insideLines(out)], [[], []], 'a command is printed that cannot find this run');
  assert.ok(existsSync(path.join(healthOf(other), `state-${stampOf(out)}.html`)), 'the report is in the home folder that was checked');
  assert.ok(!existsSync(healthOf(fx)), 'nothing is written into the other home folder');

  // The same home folder named by --home is not another one: how to continue is printed as always.
  const same = runLauncher(['check', '--lang', 'en', '--home', fx.home, '--user-only'], { home: fx.home, env: { CLAUDE_HEALTH_TTY: '1' } });
  assert.equal(same.status, 0, same.stderr);
  assert.deepEqual(commandLines(strip(same.stdout)), ['         claude']);
  assert.ok(!same.stdout.includes('another home folder'));
});

// --- inside a Claude Code session -------------------------------------------------------------------------

// The lines of a run that speak of tokens.
const tokenLines = (out) => out.split('\n').filter((line) => /token/i.test(line));

test('started by an agent inside Claude Code: no question, the defaults, and what to type on a line of its own', (t) => {
  const fx = fixture(t);
  const result = runLauncher(['check'], { home: fx.home, env: { CLAUDECODE: '1', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }, input: '2\n2\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!/Type 1-/.test(result.stdout), 'a question was asked');
  assert.match(result.stdout, /√ Scope {5}user files only/);
  assert.match(result.stdout, /\n {2}Started from inside Claude Code, so no question was asked\. To go on, type:\n {9}\/claude-health resume \d{8}-\d{6}\n$/);
  // Claude Code is running already: nobody is told to start it.
  assert.deepEqual(commandLines(result.stdout), []);
  assert.equal(insideLines(result.stdout).length, 1);
});

test('the sentence about tokens is said outside a session and nowhere inside one, in both languages', async (t) => {
  const fx = fixture(t);
  const said = { en: [/^ {2}This program {3}1 language · 2 scope · 3 scan · 4 report {10}no tokens$/, /^ {2}Done in [\d.]+ s\. No tokens used, nothing changed, nothing sent anywhere\.$/], sk: [/^ {2}Tento program {2}1 jazyk · 2 rozsah · 3 sken · 4 správa {10}bez tokenov$/, /^ {2}Hotovo za [\d,]+ s\. Žiadne tokeny, žiadna zmena, nič nikam neodišlo\.$/] };
  for (const lang of LANGS) {
    const args = ['check', '--lang', lang, '--projects', fx.projects];
    const outside = await quiet(fx, args);
    assert.equal(outside.code, 0, outside.err);
    // Inside a session: started by an agent (no terminal), and typed by a person into a terminal that a session started.
    const tty = { input: fakeInput({ tty: true }), output: fakeOutput({ tty: true }), error: fakeOutput({ tty: false }) };
    const typed = await main(['check', '--lang', lang, '--user-only'], { ...tty, env: { CLAUDECODE: '1', WT_SESSION: '1' }, cwd: PACKAGE_ROOT, platform: process.platform, home: fx.home, locale: 'en-US' });
    assert.equal(typed, 0, tty.error.text());
    for (const [name, inside] of [['an agent', (await quiet(fx, args, { env: { CLAUDECODE: '1' } })).out], ['a terminal of a session', strip(tty.output.text())]]) {
      assert.ok(!/no tokens|bez tokenov|žiadne tokeny|used no tokens|nepoužil žiadne tokeny/i.test(inside), `${lang}, ${name}: the run says it used no tokens`);
      // What is left about tokens is the estimate of the setup, which the same run prints outside a session too.
      if (name === 'an agent') assert.deepEqual(tokenLines(inside).filter((line) => !tokenLines(outside.out).includes(line)), [], `${lang}, ${name}`);
      assert.match(inside, lang === 'en' ? /\n {2}Done in [\d.]+ s\. Nothing changed, nothing sent anywhere\.\n/ : /\n {2}Hotovo za [\d,]+ s\. Žiadna zmena, nič nikam neodišlo\.\n/);
      assert.match(inside, lang === 'en' ? /Steps 1 to 4 are done by a script and cost almost nothing\./ : /Kroky 1 až 4 robí skript a nestoja takmer nič\./);
    }
    // Outside a session it is true, and it is said: in the opening block and under the progress lines.
    const agent = (await quiet(fx, args, { env: { CLAUDECODE: '1' } })).out;
    const only = tokenLines(outside.out).filter((line) => !tokenLines(agent).includes(line));
    assert.equal(only.length, 2, only.join('\n'));
    only.forEach((line, index) => assert.match(line, said[lang][index]));
  }
  // The other reasons a run is unattended are no session: output into a file with a terminal for a keyboard.
  const filed = fakeOutput({ tty: false });
  const code = await main(['check', '--lang', 'en', '--user-only'], { input: fakeInput({ tty: true }), output: filed, error: fakeOutput({ tty: false }), env: {}, cwd: PACKAGE_ROOT, platform: process.platform, home: fx.home, locale: 'en-US' });
  assert.equal(code, 0);
  assert.match(filed.text(), /No tokens used/);
  assert.ok(!filed.text().includes('Started from inside Claude Code'), 'a run whose output goes to a file is told it is inside Claude Code');
  assert.deepEqual(commandLines(filed.text()), ['         claude']);
});

test('--help, --version and what is refused', (t) => {
  const fx = fixture(t);
  const before = listing(fx.root);
  const help = runLauncher(['--help', '--lang', 'en'], { home: fx.home });
  assert.equal(help.status, 0);
  for (const flag of ['--lang en|sk', '--user-only', '--projects <dir>', '--machine', '--nested', '--plain', '--ascii', '--color', '--home <dir>']) {
    assert.ok(help.stdout.includes(flag), `--help does not name ${flag}`);
  }
  for (const lang of LANGS) {
    const text = runLauncher(['--help', '--lang', lang], { home: fx.home }).stdout;
    assert.ok(!/--then|--no-open|browser|prehliadač|cursor|kurzor/i.test(text), `--help (${lang}) names what the cut removed`);
  }
  assert.match(runLauncher(['--help', '--lang', 'sk'], { home: fx.home }).stdout, /Použitie: claude-health check/);
  assert.equal(runLauncher(['--version'], { home: fx.home }).stdout.trim(), VERSION);
  assert.equal(VERSION, readJson(path.join(PACKAGE_ROOT, 'package.json')).version);

  for (const [args, message] of [
    [['check', '--lang', 'de'], /Unknown language "de"/],
    [['check', '--frobnicate'], /Unknown option --frobnicate/],
    [['resume', '20261001-131730'], /Unknown command "resume"/],
    [['check', '--user-only', '--machine'], /--user-only cannot be combined with --machine or --projects/],
    [['check', '--lang', 'en', '--projects', `${fx.root}/nowhere`], /The check could not finish: Project folder does not exist/],
  ]) {
    const refused = runLauncher(args, { home: fx.home });
    assert.notEqual(refused.status, 0, args.join(' '));
    assert.match(refused.stderr, message);
  }
  assert.deepEqual(changedFiles(before, listing(fx.root)), [], 'a refused run writes nothing');
});

test('the stamp has one shape, and nothing else is taken for one', () => {
  assert.ok(isStamp('20261001-131730'));
  for (const text of ['', '20261001', '20261001-13173', '20261001-1317300', '2026100a-131730', '20261001_131730', ' 20261001-131730', '20261001-131730\n', '../20261001-131730', '20261001-131730;x', null, undefined, 20261001]) {
    assert.equal(isStamp(text), false, JSON.stringify(text));
  }
  assert.equal(String(STAMP_PATTERN), '/^\\d{8}-\\d{6}$/');
});

test('a folder stands for the projects the scan would find in it', (t) => {
  const fx = fixture(t);
  assert.deepEqual(projectsIn(fx.home, fx.projects), { ok: true, projects: [fx.project('alpha-service'), fx.project('beta-tool')] });
  assert.deepEqual(projectsIn(fx.home, fx.project('beta-tool')), { ok: true, projects: [fx.project('beta-tool')] });
  assert.deepEqual(projectsIn(fx.home, `${fx.root}/nowhere`), { ok: false, reason: 'missing' });
  mkdirSync(`${fx.root}/empty/inside`, { recursive: true });
  assert.deepEqual(projectsIn(fx.home, `${fx.root}/empty`), { ok: false, reason: 'none' });
  assert.deepEqual(projectsIn(fx.home, `${fx.home}/.claude/projects`), { ok: false, reason: 'session' });
});

// --- with a terminal on both ends ---------------------------------------------------------------------

// A terminal: what is typed is echoed, raw mode can be asked for (and every request is written
// down), the window has a size and can change it.
function terminal(fx, { env = {}, columns = 100, rows = 40, cwd = PACKAGE_ROOT } = {}) {
  const output = fakeOutput({ columns, rows });
  const input = fakeInput({ echo: output });
  const error = fakeOutput({ tty: false });
  const io = { input, output, error, env: { WT_SESSION: '1', ...env }, cwd, platform: process.platform, home: fx.home, locale: 'en-US' };
  return { io, input, output, error };
}

// Types one line each time the launcher waits at a prompt. `between` runs before each line.
async function type(term, done, lines, between = () => {}) {
  let finished = false;
  done.then(() => (finished = true), () => (finished = true));
  for (const line of lines) {
    for (let tries = 0; tries < 5000 && !finished && !/(: |[›>] )$/.test(strip(term.output.text())); tries += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    if (finished) break;
    between(line);
    term.input.write(`${line}\r\n`);
  }
  return done;
}

const rowsWith = (lines, pattern) => lines.map(strip).filter((line) => pattern.test(line)).length;

test('with a terminal: questions are numbered lists, the keyboard stays in its own mode, and every block is printed once', { timeout: KEY_TIMEOUT }, async (t) => {
  const fx = fixture(t);
  const term = terminal(fx);
  // Language 2 (Slovensky), Enter at the two lists, scope 1 (only my user files).
  const code = await type(term, main(['check'], term.io), ['2', '', '1']);
  assert.equal(code, 0, term.error.text());
  const written = term.output.text();
  assert.deepEqual(term.input.rawModes, [], 'the keyboard was switched to single keys');
  assert.deepEqual(controlsIn(written), [], 'something other than colour was sent to the terminal');
  assert.ok(written.includes('\u001b[1;36m'), 'colour is on in a terminal');
  assert.equal(term.output.listenerCount('resize'), 0, 'the launcher watches the size of the window');
  assert.equal(term.error.text(), '');

  const text = strip(written);
  // Everything is printed under what came before: the questions stay where they were asked.
  const order = [
    'claude-health check',
    '► LANGUAGE ─ · Scope',
    '? Language / Jazyk\n    1  English\n    2  Slovensky\n  Type 1-2 and press Enter [1]: 2\n',
    'ČO MENÍ',
    'ČO NIKDY NEMENÍ',
    'Pokračuj klávesom Enter: \n',
    '√ Jazyk ─ ► ROZSAH',
    '? Ktoré projekty skontrolovať',
    'Napíš 1-3 a stlač Enter [1]: 1\n',
    '√ Jazyk ─ √ Rozsah ─ ► SKEN',
    '√ Rozsah    len používateľské súbory',
    'Hotovo za ',
    '√ Jazyk ─ √ Rozsah ─ √ Sken ─ ► SPRÁVA',
    '[ Prehľad ]',
    '[ Nálezy ',
    '[ Kontext ]',
    '[ Skilly ',
    'Správa 1 · stav tvojho nastavenia',
    '── Ako pokračovať ──',
    '\n         claude\n',
    '\n         /claude-health resume ',
  ];
  let at = 0;
  for (const part of order) {
    const found = text.indexOf(part, at);
    assert.ok(found !== -1, `"${part}" is missing, or out of order`);
    at = found + part.length;
    assert.equal(text.indexOf(part, at), -1, `"${part}" is printed twice`);
  }
  assert.ok(!/Enter (ďalej|continue) ·|↑↓|← →|q (koniec|quit)/.test(text), 'a line names keys that are not read');
  assert.ok(written.endsWith('\n'));
  for (const line of text.split('\n')) if (!neverCut(line)) assert.ok(widthOf(line) <= 76, line);
});

// Every way the launcher can be started. [name, arguments, what is typed, { env, tty, columns, rows }]
const MODES = [
  ['a terminal, everything asked', ['check'], ['1', '', '1'], {}],
  ['a terminal, flags only', ['check', '--lang', 'sk', '--user-only'], [], {}],
  ['a terminal, the home-folder search', ['check', '--lang', 'en'], ['', '2', ''], {}],
  ['a terminal, the home-folder search by flag', ['check', '--lang', 'en', '--machine'], [], {}],
  ['a terminal, folders named', ['check', '--lang', 'en'], ['', '3', '<projects>', '<root>/nowhere', ''], {}],
  ['a terminal, --plain', ['check', '--plain'], ['2', '1'], {}],
  ['a terminal, --ascii', ['check', '--lang', 'en', '--ascii'], ['', '1'], {}],
  ['a terminal, --color', ['check', '--lang', 'en', '--color', '--user-only'], [], {}],
  ['the classic window, 80 by 24', ['check'], ['2', '', '1'], { columns: 80, rows: 24 }],
  ['the terminal panel of an editor, 120 by 14', ['check', '--lang', 'en'], ['', '1'], { columns: 120, rows: 14 }],
  ['a narrow window, 60 by 30', ['check', '--lang', 'en'], ['', '1'], { columns: 60, rows: 30 }],
  ['a window of 20 by 5', ['check', '--lang', 'en'], ['', '1'], { columns: 20, rows: 5 }],
  ['a legacy console', ['check', '--lang', 'en', '--user-only'], [], { env: { WT_SESSION: '' } }],
  ['Git Bash, as its shell script reports it', ['check', '--lang', 'en'], ['', '1'], { tty: false, env: { CLAUDE_HEALTH_TTY: '1', MSYSTEM: 'MINGW64' } }],
  ['a pipe', ['check'], ['2', '3', '<projects>', ''], { tty: false }],
  // Answers that another program produced: the number and the folder carry what clears the
  // screen, sends the cursor home, rings the bell, returns the carriage and reorders the text.
  ['a pipe, answers with control characters', ['check', '--lang', 'en'], ['3\u001b[2J\u001b[H', '3', '<root>/no\u001b[2J\u001b[H\u0007\rwh\u009b2Jere\u202e', '<projects>', ''], { tty: false }],
  ['a pipe, colour forced', ['check', '--lang', 'en', '--user-only'], [], { tty: false, env: { FORCE_COLOR: '1' } }],
  ['inside Claude Code, by an agent', ['check'], [], { tty: false, env: { CLAUDECODE: '1' } }],
  ['inside Claude Code, in a terminal', ['check', '--lang', 'en'], ['', '1'], { env: { CLAUDECODE: '1' } }],
  ['another home folder', ['check', '--lang', 'en', '--user-only', '--home', '<other>'], [], {}],
];

test('no run of the launcher, in any mode, moves the cursor, clears anything or reads a single key', { timeout: 6 * KEY_TIMEOUT }, async (t) => {
  for (const name of ['main', 'clean']) {
    const fx = fixture(t, name);
    const other = fixture(t, 'field');
    for (const [mode, args, lines, { env = {}, tty = true, columns = 100, rows = 40 }] of MODES) {
      const fill = (text) => text.replace('<projects>', fx.projects).replace('<root>', fx.root).replace('<other>', other.home);
      const output = fakeOutput({ tty, columns, rows });
      const input = fakeInput({ tty, echo: tty ? output : null });
      const error = fakeOutput({ tty: false });
      const io = { input, output, error, env: { WT_SESSION: '1', ...env }, cwd: PACKAGE_ROOT, platform: process.platform, home: fx.home, locale: 'en-US' };
      const done = main(args.map(fill), io);
      if (tty) await type({ input, output }, done, lines.map(fill));
      else input.end(lines.map((line) => `${fill(line)}\n`).join(''));
      const what = `${name}, ${mode}`;
      assert.equal(await done, 0, `${what}: ${error.text()}`);
      const written = output.text();
      assert.match(strip(written), /state-\d{8}-\d{6}\.html/, `${what}: the run did not reach its report, so this proves nothing`);
      assert.deepEqual(controlsIn(written), [], `${what}: something other than colour was sent to the terminal`);
      // One layout for every window: what the program writes is at most 76 columns wide, in a
      // window of 20 columns and in one of 120. A line that was typed is as long as it was typed.
      for (const line of strip(written).split('\n')) if (!neverCut(line) && !/^ {2}[›>] /.test(line)) assert.ok(widthOf(line) <= 76, `${what}: ${widthOf(line)} wide: ${line}`);
      assert.deepEqual(input.rawModes, [], `${what}: the keyboard was switched to single keys`);
      assert.equal(output.listenerCount('resize'), 0, `${what}: the launcher watches the size of the window`);
      // Played in the window it was written to: the cursor is never sent anywhere, and no row is taken back.
      const { lines: played, clipped } = playWindow(written, columns, rows);
      assert.equal(clipped, 0, what);
      assert.equal(played.join('\n').replace(/\s+/g, ''), strip(written).replace(/\s+/g, ''), `${what}: a row that was printed is gone`);
    }
  }
  // The sources hold no sequence but colour: the one escape byte that is written is in lib/term.mjs.
  const modules = [LAUNCHER, ...readdirSync(SCRIPTS).filter((file) => file.endsWith('.mjs')).map((file) => path.join(SCRIPTS, file)), ...readdirSync(path.join(SCRIPTS, 'lib')).map((file) => path.join(SCRIPTS, 'lib', file))];
  const escapes = modules.filter((file) => /\\u001b|\\x1b|\\e\[|\\033/i.test(readFileSync(file, 'utf8'))).map((file) => path.basename(file));
  assert.deepEqual(escapes, ['term.mjs']);
  const sequences = [...readFileSync(path.join(SCRIPTS, 'lib', 'term.mjs'), 'utf8').matchAll(/`\\u001b\[[^`]*`/g)].map((match) => match[0]);
  assert.deepEqual(sequences, ['`\\u001b[${codes}m${text}\\u001b[0m`'], 'term.mjs writes a sequence that is not a colour');
  for (const file of modules) assert.ok(!/setRawMode|'resize'|\bwriteSync\b/.test(readFileSync(file, 'utf8')), `${path.basename(file)} reads keys, watches the window or writes past the stream`);
});

test('the size of the window changes nothing: the same answers give the same text in every window', { timeout: 2 * KEY_TIMEOUT }, async (t) => {
  const fx = fixture(t);
  // The scope is asked, so every kind of block is printed: the rail, a question, the two lists,
  // the progress lines, the four panels, the link and how to continue.
  const run = async (columns, rows) => {
    const term = terminal(fx, { columns, rows });
    const code = await type(term, main(['check', '--lang', 'en'], term.io), ['', '1']);
    assert.equal(code, 0, `${columns} by ${rows}: ${term.error.text()}`);
    return term.output.text();
  };
  const reference = await run(100, 40);
  assert.match(strip(reference), /How to continue/);
  const comparable = (written) => timeless(strip(written));
  for (const [columns, rows] of [[120, 14], [60, 30], [20, 5], [77, 24], [200, 60], [400, 100]]) {
    const written = await run(columns, rows);
    const [now, then] = [comparable(written).split('\n'), comparable(reference).split('\n')];
    const at = now.findIndex((line, index) => line !== then[index]);
    assert.equal(comparable(written), comparable(reference), `a window of ${columns} by ${rows} is laid out differently than one of 100 by 40, first at line ${at + 1}:\n  here:  ${now[at]}\n  there: ${then[at]}`);
  }
});

test('a typed answer of any length and any number of named folders leaves every line where it was printed', { timeout: 3 * KEY_TIMEOUT }, async (t) => {
  const fx = fixture(t);
  // Windows a page fits into and windows it does not: the ones a review found broken, and the
  // boundaries it measured (74 and 75 characters at 78 columns, 9 and 10 folders at 25 rows).
  for (const [columns, rows] of [[78, 25], [80, 24], [100, 30], [120, 14], [60, 30], [100, 40]]) {
    const long = `${fx.root}/${'a-folder-name-that-goes-on/'.repeat(12)}nowhere`;
    // With its prompt of four columns, a typed line that ends in the last column of the window,
    // one that is one character longer, and one that takes a row more.
    const full = Math.ceil((fx.root.length + 6) / columns) * columns;
    const exact = [full - 4, full - 3, full + columns].map((length) => `${fx.root}/`.padEnd(length, 'x'));
    const folders = [long, ...exact, ...Array.from({ length: 40 }, () => fx.projects), `${fx.root}/nowhere`, fx.project('beta-tool')];
    const term = terminal(fx, { columns, rows });
    // While the folders are typed the window is made smaller, then larger again.
    let typedSoFar = 0;
    const resize = () => {
      typedSoFar += 1;
      if (typedSoFar === 10) Object.assign(term.output, { columns: Math.max(20, columns - 30), rows: Math.max(5, rows - 10) });
      if (typedSoFar === 20) Object.assign(term.output, { columns: columns + 40, rows: rows + 20 });
      if (typedSoFar === 10 || typedSoFar === 20) term.output.emit('resize');
    };
    // The scope is first answered with a line longer than three rows of the window, which is no
    // number of the list; then with 3, "folders I name".
    const code = await type(term, main(['check', '--lang', 'en'], term.io), ['', '9'.repeat(3 * columns + 1), '3', ...folders, ''], resize);
    const what = `${columns} by ${rows}`;
    assert.equal(code, 0, `${what}: ${term.error.text()}`);
    const written = term.output.text();
    assert.deepEqual(controlsIn(written), [], what);
    assert.deepEqual(term.input.rawModes, [], what);
    const { lines, clipped } = playWindow(written, columns, rows);
    assert.equal(clipped, 0, `${what}: the cursor was sent above the window`);
    for (const [pattern, count] of [
      [/claude-health check/, 1],
      [/WHAT IT CHANGES/, 1],
      [/WHAT IT NEVER CHANGES/, 1],
      [/► SCOPE ─ · Scan/, 1],
      [/√ Scope ─ ► SCAN/, 1],
      [/√ Scan ─ ► REPORT/, 1],
      [/\? Which projects should be checked/, 1],
      [/Type a number from 1 to 3\./, 1],
      [/Type 1-3 and press Enter \[1\]:/, 2],
      [/\? Folder \(an empty line ends the list\)/, 1],
      [/√ projects found: 2 · alpha-service, beta-tool/, 40],
      [/√ projects found: 1 · beta-tool/, 1],
      [/× that folder does not exist:/, 5],
      [/How to continue/, 1],
    ]) {
      assert.equal(rowsWith(lines, pattern), count, `${what}: ${pattern} stands on ${rowsWith(lines, pattern)} rows`);
    }
    // Each folder is answered on the line under it, in the order it was typed.
    const text = strip(written);
    let at = text.indexOf('? Folder');
    for (const folder of folders) {
      const typed = text.indexOf(`› ${folder}\n    `, at);
      assert.ok(typed !== -1, `${what}: ${folder.slice(-40)} is not followed by its answer`);
      assert.match(text.slice(typed + folder.length + 3, typed + folder.length + 9), /^ {4}[√×] /, what);
      at = typed + 1;
    }
    assert.match(text, /√ Scope {5}user files \+ 2 projects \(alpha-service, beta-tool\)/, what);
  }
});

test('a folder typed with a tilde is looked for in the home folder of the person', async (t) => {
  const fx = fixture(t);
  mkdirSync(path.join(fx.home, 'work', 'my-app', '.claude'), { recursive: true });
  const typed = await quiet(fx, ['check', '--lang', 'en', '--plain'], { input: '3\n~/work/my-app\n\n' });
  assert.equal(typed.code, 0, typed.err);
  assert.match(typed.out, /projects found: 1 · my-app/);
  assert.match(typed.out, /√ Scope {5}user files \+ 1 project \(my-app\)/);
});

test('the scope line and the places name each project by its label, so two folders of one name stay apart', (t) => {
  const s = emptySetup();
  t.after(() => s.cleanup());
  s.write('home/.claude/CLAUDE.md', ['# User', '- Keep answers short.']);
  for (const [folder, title] of [['client-a/web', 'A'], ['client-b/web', 'B'], ['work/app', 'App'], ['old/app/web', 'Old'], ['new/web', 'New']]) s.write(`projects/${folder}/CLAUDE.md`, [`# ${title}`, '- Keep it.']);
  s.write('projects/work/app/web/CLAUDE.md', ['# Web of app', '- Keep it.']);
  const run = (folders) => runLauncher(['check', '--lang', 'en', '--projects', ...folders.map((folder) => `${s.projects}/${folder}`), '--plain'], { home: s.home });
  const same = run(['client-a/web', 'client-b/web']);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /√ Scope {5}user files \+ 2 projects \(client-a\/web, client-b\/web\)/);
  // "app" would lead "app/web": the file web/CLAUDE.md of the one and CLAUDE.md of the other would read the same.
  const led = run(['work/app', 'old/app/web', 'new/web']);
  const names = /√ Scope {5}user files \+ 3 projects \(([^)]*)\)/.exec(led.stdout)?.[1].split(', ').sort();
  assert.deepEqual(names, ['app/web', 'new/web', 'work/app'], 'a name that leads another one gets one more folder in front');
  assert.match(led.stdout, /\n {2}work\/app\/web\/CLAUDE\.md {2,}\d/);
  assert.match(led.stdout, /\n {2}app\/web\/CLAUDE\.md {2,}\d/);
});

test('the launcher cannot touch the setup, and its files are in place', () => {
  for (const file of [LAUNCHER, ...['pipeline.mjs', 'render.mjs', 'prompt.mjs', 'term.mjs', 'surroundings.mjs'].map((name) => path.join(SCRIPTS, 'lib', name))]) {
    assert.ok(!/apply\.mjs/.test(readFileSync(file, 'utf8')), `${path.basename(file)} names the module that writes`);
  }
  assert.deepEqual(readdirSync(path.join(PACKAGE_ROOT, 'bin')), ['claude-health.mjs']);
});
