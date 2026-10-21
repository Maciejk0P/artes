// The two shell shims: the only place in the package that starts a program, and the program is
// node with the check. Each is run where its shell exists, with stand-ins for `claude` and for
// everything that opens a browser first on the PATH, to prove that none of them is started.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PACKAGE_ROOT, materialise } from './helpers/fixtures.mjs';

const SH_SHIM = path.join(PACKAGE_ROOT, 'claude-health');
const CMD_SHIM = path.join(PACKAGE_ROOT, 'claude-health.cmd');
const isWindows = process.platform === 'win32';

// The full path of a program on the PATH of this process, or null.
function which(name) {
  const endings = isWindows ? ['', '.exe', '.cmd'] : [''];
  for (const folder of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ending of endings) {
      const file = path.join(folder, name + ending);
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
  }
  return null;
}

const sh = which('sh');
const cmd = isWindows ? which('cmd') : null;
const slash = (file) => file.replace(/\\/g, '/');

// What the shims started before the cut of 2 Oct 2026, and what opens a file on each system.
const NEVER_STARTED = ['claude', 'opener', 'explorer', 'open', 'xdg-open', 'wslview', 'cygpath', 'mktemp', 'findstr'];

// A temp folder with a stand-in for each of them, first on the PATH. A stand-in writes down that
// it was called and with what; the tests expect that file never to appear.
function fakes(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-health-check-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'log.txt');
  const bin = path.join(dir, 'bin');
  const temp = path.join(dir, 'temp');
  mkdirSync(bin);
  mkdirSync(temp);
  for (const name of NEVER_STARTED) {
    writeFileSync(path.join(bin, name), ['#!/bin/sh', `printf '%s|%s\\n' ${name} "$*" >> "$FAKE_LOG"`, ''].join('\n'));
    chmodSync(path.join(bin, name), 0o755);
    writeFileSync(path.join(bin, `${name}.cmd`), ['@echo off', `>>"%FAKE_LOG%" echo ${name}^|%*`, ''].join('\r\n'));
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) : []);
  return { dir, bin, temp, log, calls };
}

// A copy of the two shims next to a stand-in for the launcher. It writes down how it was reached,
// prints what it is told to, and ends with the status it is told to.
function shimCopy(t, folder = null) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'claude-health-check-copy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = folder === null ? base : path.join(base, folder);
  mkdirSync(dir, { recursive: true });
  cpSync(SH_SHIM, path.join(dir, 'claude-health'));
  cpSync(CMD_SHIM, path.join(dir, 'claude-health.cmd'));
  mkdirSync(path.join(dir, 'bin'));
  writeFileSync(
    path.join(dir, 'bin', 'claude-health.mjs'),
    [
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "appendFileSync(process.env.REACHED, JSON.stringify({ args: process.argv.slice(2), tty: process.env.CLAUDE_HEALTH_TTY ?? null }) + '\\n');",
      "if (process.env.CLAUDE_HEALTH_NEXT) writeFileSync(process.env.CLAUDE_HEALTH_NEXT, process.env.FAKE_PRINT ?? '');",
      "process.stdout.write(process.env.FAKE_PRINT ?? '');",
      'process.exitCode = Number(process.env.FAKE_STATUS ?? 0);',
      '',
    ].join('\n'),
  );
  return dir;
}

function suite(name, available, run) {
  const shimOf = (dir) => path.join(dir, name === 'cmd' ? 'claude-health.cmd' : 'claude-health');
  const env = (fx, fake, extra = {}) => ({
    ...process.env,
    HOME: fx.home,
    USERPROFILE: fx.home,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: fake.temp,
    TEMP: fake.temp,
    TMP: fake.temp,
    FAKE_LOG: fake.log,
    REACHED: path.join(fake.dir, 'reached.txt'),
    CLAUDE_HEALTH_TTY: '1',
    // The variable that named the program to open a report with: nothing reads it any more.
    CLAUDE_HEALTH_OPENER: path.join(fake.bin, isWindows && name === 'cmd' ? 'opener.cmd' : 'opener'),
    PATH: [fake.bin, process.env.PATH].join(path.delimiter),
    NO_COLOR: '1',
    ...extra,
  });
  const reached = (fake) => (existsSync(path.join(fake.dir, 'reached.txt')) ? readFileSync(path.join(fake.dir, 'reached.txt'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);

  test(`${name} shim: runs the check, and starts neither a browser nor claude`, (t) => {
    if (!available) return t.skip(`no ${name} on this machine`);
    const fx = materialise('main');
    t.after(() => fx.cleanup());
    const fake = fakes(t);
    const result = run(shimOf(PACKAGE_ROOT), ['check', '--lang', 'en', '--user-only'], { env: env(fx, fake) });
    assert.equal(result.status, 0, result.stderr);
    const stamp = /run-(\d{8}-\d{6})/.exec(result.stdout)[1];
    assert.ok(existsSync(path.join(fx.home, '.claude', 'health-check', `state-${stamp}.html`)), 'the check did not run');
    assert.match(result.stdout, /file:\/\/\S+state-\d{8}-\d{6}\.html/, 'the link to report 1 is printed');
    assert.match(result.stdout, new RegExp(`\\n {9}claude\\n[^\\n]*\\n {9}/claude-health resume ${stamp}\\n`), 'how to continue is printed');
    assert.deepEqual(fake.calls(), [], 'the shim started a program besides node');
    assert.deepEqual(readdirSync(fake.temp), [], 'the shim left a file in the temp folder');

    // When the check fails, its exit code is the shim's.
    const failed = run(shimOf(PACKAGE_ROOT), ['check', '--frobnicate'], { env: env(fx, fake) });
    assert.equal(failed.status, 2);
    assert.match(failed.stderr, /Unknown option --frobnicate/);
    assert.deepEqual(fake.calls(), []);
  });

  test(`${name} shim: whatever the check prints or writes, nothing is started after it`, (t) => {
    if (!available) return t.skip(`no ${name} on this machine`);
    const fx = materialise('clean');
    t.after(() => fx.cleanup());
    const fake = fakes(t);
    const copy = shimCopy(t);
    const next = path.join(fake.dir, 'next.txt');
    // What the launcher wrote for the shim before the cut, and text a shell would act on.
    for (const print of ['open+claude 20261001-131730\r\n', 'claude 20261001-131730\n', 'open 20261001-131730\r\n', 'claude $(touch pwned)\n', 'claude `touch pwned`\n', 'claude 20261001-131730&echo pwned\r\n', 'open %USERPROFILE%\r\n']) {
      for (const status of ['0', '3']) {
        const result = run(shimOf(copy), ['check'], { env: env(fx, fake, { FAKE_PRINT: print, FAKE_STATUS: status, CLAUDE_HEALTH_NEXT: next }), cwd: copy });
        assert.equal(result.status, Number(status), `${JSON.stringify(print)}: ${result.stderr}`);
        assert.deepEqual(fake.calls(), [], `the shim acted on ${JSON.stringify(print)}`);
        assert.deepEqual(readdirSync(fake.temp), []);
      }
    }
    assert.ok(reached(fake).length === 14, 'the stand-in for the launcher was not reached, so this proves nothing');
    assert.ok(!existsSync(path.join(copy, 'pwned')) && !existsSync(path.join(PACKAGE_ROOT, 'pwned')), 'what the check printed was run as a command');
  });

  test(`${name} shim: the arguments reach the check as they were typed`, (t) => {
    if (!available) return t.skip(`no ${name} on this machine`);
    const fx = materialise('clean');
    t.after(() => fx.cleanup());
    const fake = fakes(t);
    const copy = shimCopy(t);
    const args = ['check', '--lang', 'sk', '--projects', 'my project', 'other', '--ascii'];
    const result = run(shimOf(copy), args, { env: env(fx, fake), cwd: copy });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(reached(fake).map((entry) => entry.args), [args]);
  });

  test(`${name} shim: without Node on the PATH it says what it needs and starts nothing`, (t) => {
    if (!available) return t.skip(`no ${name} on this machine`);
    const fx = materialise('clean');
    t.after(() => fx.cleanup());
    const fake = fakes(t);
    // A PATH with the system tools of the shell and no node.
    const system = name === 'cmd' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : path.dirname(sh);
    if (existsSync(path.join(system, isWindows ? 'node.exe' : 'node'))) return t.skip('node sits next to the system tools here');
    const result = run(shimOf(PACKAGE_ROOT), ['check', '--lang', 'en', '--user-only'], { env: env(fx, fake, { PATH: [fake.bin, system].join(path.delimiter) }) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs Node\.js 20 or newer/);
    assert.deepEqual(fake.calls(), []);
    assert.ok(!existsSync(path.join(fx.home, '.claude', 'health-check')));
  });

  test(`${name} shim: a folder name that a shell has to quote does not break the start`, (t) => {
    if (!available) return t.skip(`no ${name} on this machine`);
    const fx = materialise('clean');
    t.after(() => fx.cleanup());
    // An apostrophe, a space, brackets and a semicolon: all legal in a folder name on every system.
    for (const folder of ["tool o'co", 'tool (x86) co', 'tool;co']) {
      const fake = fakes(t);
      const copy = shimCopy(t, folder);
      const result = run(shimOf(copy), ['check'], { env: env(fx, fake), cwd: copy });
      assert.equal(result.status, 0, `${folder}: ${result.stderr}`);
      assert.deepEqual(reached(fake).map((entry) => entry.args), [['check']], `${folder}: the launcher was not reached`);
      assert.deepEqual(fake.calls(), [], folder);
    }
  });
}

suite('sh', Boolean(sh), (shim, args, options) => {
  const result = spawnSync(sh, [slash(shim), ...args], { encoding: 'utf8', cwd: options.cwd ?? PACKAGE_ROOT, env: options.env, input: '' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
});

suite('cmd', Boolean(cmd), (shim, args, options) => {
  const line = [`"${shim}"`, ...args.map((arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg}"` : arg))].join(' ');
  const result = spawnSync(line, { encoding: 'utf8', cwd: options.cwd ?? PACKAGE_ROOT, env: options.env, shell: cmd, input: '', windowsHide: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
});

test('sh shim: it tells the check whether a terminal is on both ends, and a setting that turns path conversion off does not stop it', (t) => {
  if (!sh) return t.skip('no sh on this machine');
  const fx = materialise('main');
  t.after(() => fx.cleanup());
  const fake = fakes(t);
  const base = { ...process.env, HOME: fx.home, USERPROFILE: fx.home, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', FAKE_LOG: fake.log, NO_COLOR: '1', PATH: [fake.bin, process.env.PATH].join(path.delimiter) };
  delete base.CLAUDE_HEALTH_TTY;
  // Started with pipes on both ends, as here: no terminal, so nothing waits for Enter.
  const copy = shimCopy(t);
  const reachedFile = path.join(fake.dir, 'reached.txt');
  const piped = spawnSync(sh, [slash(path.join(copy, 'claude-health')), 'check'], { encoding: 'utf8', cwd: copy, env: { ...base, REACHED: reachedFile }, input: '' });
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(JSON.parse(readFileSync(reachedFile, 'utf8').trim()).tty, '0');
  // Git Bash with MSYS_NO_PATHCONV=1 (a common setting for container tools): the request file the
  // shim once made was handed to node in a spelling node could not open, and the run ended with
  // an error after the whole report. There is no such file any more.
  for (const setting of [{ MSYS_NO_PATHCONV: '1' }, { MSYS2_ARG_CONV_EXCL: '*' }, { MSYS2_ARG_CONV_EXCL: '' }, { MSYSTEM: 'MINGW64' }]) {
    const result = spawnSync(sh, [slash(SH_SHIM), 'check', '--lang', 'en', '--user-only'], { encoding: 'utf8', cwd: PACKAGE_ROOT, env: { ...base, CLAUDE_HEALTH_TTY: '1', ...setting }, input: '' });
    assert.equal(result.status, 0, `${JSON.stringify(setting)}: ${result.stderr}`);
    assert.match(result.stdout, /\n {9}claude\n[^\n]*\n {9}\/claude-health resume \d{8}-\d{6}\n/, JSON.stringify(setting));
    assert.deepEqual(fake.calls(), []);
  }
});

test('cmd shim: started from inside a repository, it runs none of that repository\'s programs', (t) => {
  if (!cmd) return t.skip('no cmd on this machine');
  const fx = materialise('main');
  t.after(() => fx.cleanup());
  const fake = fakes(t);
  // A cloned repository that ships programs named like the ones the shim calls, and like the ones
  // it called before the cut. cmd looks in the working directory before the PATH, unless it is told not to.
  const repository = mkdtempSync(path.join(os.tmpdir(), 'claude-health-check-repo-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  for (const name of ['where', 'node', 'findstr', 'claude', 'start', 'explorer']) {
    writeFileSync(path.join(repository, `${name}.cmd`), ['@echo off', `>>"%FAKE_LOG%" echo planted-${name}`, 'exit /b 0', ''].join('\r\n'));
  }
  // A person's own cmd window does not have the switch that turns this lookup off; a shell
  // started by an agent may, so it is taken out of the environment of this run.
  const env = { ...process.env, HOME: fx.home, USERPROFILE: fx.home, TEMP: fake.temp, TMP: fake.temp, FAKE_LOG: fake.log, CLAUDE_HEALTH_TTY: '1', NO_COLOR: '1', PATH: [fake.bin, process.env.PATH].join(path.delimiter) };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[key];
  const line = `"${CMD_SHIM}" check --lang en --user-only`;
  const result = spawnSync(line, { encoding: 'utf8', cwd: repository, env, shell: cmd, input: '', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Report 1/, 'the check did not run');
  assert.deepEqual(fake.calls(), [], 'a program of the repository was run, or one the shim no longer starts');

  // The switch is what keeps them out: the same start without it runs the planted node.
  const without = readFileSync(CMD_SHIM, 'utf8').replace(/^set "NoDefaultCurrentDirectoryInExePath=1"\r\n/m, '');
  assert.notEqual(without, readFileSync(CMD_SHIM, 'utf8'), 'the shim no longer sets the switch');
  const copy = mkdtempSync(path.join(os.tmpdir(), 'claude-health-check-copy-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  writeFileSync(path.join(copy, 'claude-health.cmd'), without);
  const open = spawnSync(`"${path.join(copy, 'claude-health.cmd')}" check`, { encoding: 'utf8', cwd: repository, env, shell: cmd, input: '', windowsHide: true });
  assert.ok(fake.calls().some((entry) => entry.startsWith('planted-')), `without the switch nothing of the repository ran either, so the test above proves nothing: ${open.stderr}`);
});

test('the shims are where the README says, with the line endings and the mode their shells need', (t) => {
  const posix = readFileSync(SH_SHIM, 'utf8');
  assert.ok(posix.startsWith('#!/bin/sh\n'));
  assert.ok(!posix.includes('\r'), 'the sh shim has a carriage return; sh would take it for part of a command');
  const batch = readFileSync(CMD_SHIM, 'utf8');
  assert.ok(batch.startsWith('@echo off\r\n'));
  assert.equal(batch.split('\n').filter((line) => line !== '' && !line.endsWith('\r')).length, 0, 'a line of the cmd shim does not end in CRLF');

  const attributes = readFileSync(path.join(PACKAGE_ROOT, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^\/claude-health text eol=lf$/m);
  assert.match(attributes, /^\*\.cmd text eol=crlf$/m);

  if (isWindows) t.diagnostic('the executable bit of the file is not checked on Windows');
  else assert.ok(statSync(SH_SHIM).mode & 0o111, 'the sh shim is not executable; run: chmod +x claude-health');

  // What a clone receives is the mode git recorded, and git on Windows records none by itself.
  const git = which('git');
  const listed = git ? spawnSync(git, ['ls-files', '--stage', '--', 'claude-health'], { cwd: PACKAGE_ROOT, encoding: 'utf8' }) : null;
  const entry = listed && listed.status === 0 ? listed.stdout.trim() : '';
  if (entry === '') t.diagnostic('the sh shim is not in a git index here, so its recorded mode is not checked');
  else assert.match(entry, /^100755 /, 'git records the sh shim as not executable, so ./claude-health fails in every clone; run: git update-index --chmod=+x claude-health');
});

test('the code of each shim is these lines and no other', () => {
  // Every line that is no comment and not blank, whole. A line that is added or changed fails
  // here whatever it begins with: a quote, a variable, a program. So does the line that tells the
  // check whether a terminal is on both ends. A deliberate change to a shim is made together
  // with its list.
  const code = (text, comment) => text.split(/\r?\n/).filter((line) => line.trim() !== '' && !comment.test(line));
  assert.deepEqual(code(readFileSync(SH_SHIM, 'utf8'), /^#/), [
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && { pwd -W 2>/dev/null || pwd; }) || exit 1',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "claude-health needs Node.js 20 or newer on the PATH. / claude-health potrebuje Node.js 20 alebo novší v PATH." >&2',
    '  exit 1',
    'fi',
    'tty=0',
    'if [ -t 0 ] && [ -t 1 ]; then tty=1; fi',
    'CLAUDE_HEALTH_TTY="${CLAUDE_HEALTH_TTY:-$tty}" exec node "$here/bin/claude-health.mjs" "$@"',
  ]);
  const batch = readFileSync(CMD_SHIM, 'utf8');
  assert.deepEqual(code(batch, /^rem( |$)/), [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "NoDefaultCurrentDirectoryInExePath=1"',
    'set "here=%~dp0"',
    'where node >nul 2>nul',
    'if errorlevel 1 goto :no_node',
    'node "%here%bin\\claude-health.mjs" %*',
    'exit /b %errorlevel%',
    ':no_node',
    'echo claude-health needs Node.js 20 or newer on the PATH. / claude-health potrebuje Node.js 20 alebo novsi v PATH. 1>&2',
    'exit /b 1',
  ]);
  // cmd still acts on a redirection that stands in a comment, so a comment holds none of the
  // characters cmd gives a meaning to.
  for (const line of batch.split(/\r?\n/).filter((text) => /^rem( |$)/.test(text))) assert.ok(!/[&|<>^%!]/.test(line), `a comment of the cmd shim holds a character cmd acts on: ${line}`);
});

test('the shims are the only place that starts a program, and they start one: node with the check', () => {
  // Every command word of a shim, comments and blank lines left out.
  const words = (text, comment, word) => [...new Set(text.split(/\r?\n/).filter((line) => line.trim() !== '' && !comment.test(line)).flatMap((line) => [...line.matchAll(word)].map((match) => match[1].toLowerCase())))].sort();
  const posix = readFileSync(SH_SHIM, 'utf8');
  // A command stands at the start of a line, after "then", "&&", "||", "{", "!" or "$(".
  const posixWords = words(posix, /^\s*#/, /(?:^\s*|\bthen\s+|&&\s*|\|\|\s*|\{\s*|!\s+|\$\(\s*)(?:[A-Z_]+=\S*\s+)*([a-z_][\w-]*|\[)(?=\s|$)/g);
  // What sh does itself (the POSIX built-ins), dirname for the folder of the script, and node.
  assert.deepEqual(posixWords, ['[', 'cd', 'command', 'dirname', 'echo', 'exec', 'exit', 'fi', 'if', 'pwd'], 'the sh shim runs something it did not run before');
  assert.equal(posix.split('\n').filter((line) => /^[A-Z_]+="\$\{CLAUDE_HEALTH_TTY:-\$tty\}" exec node "\$here\/bin\/claude-health\.mjs" "\$@"$/.test(line)).length, 1, 'node is started once, in place of the shell, with the launcher and the arguments as they were typed');
  // Every expansion of a variable that holds a path is inside double quotes.
  for (const line of posix.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const bare = line.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    assert.ok(!/\$(here|HOME|USERPROFILE|TMPDIR)\b/.test(bare), `an unquoted path in the sh shim: ${line}`);
    assert.ok(!/\beval\b/.test(bare), `eval in the sh shim: ${line}`);
  }

  const batch = readFileSync(CMD_SHIM, 'utf8');
  const batchWords = words(batch, /^\s*(rem\b|::|:[a-z_]+\s*$)/i, /^\s*@?(?:if\s+(?:not\s+)?(?:errorlevel\s+\d+|"[^"]*"=="[^"]*"|defined\s+\S+|exist\s+"[^"]*")\s+)?([a-z]+)\b/gi);
  // What cmd does itself, where.exe to look for node, and node.
  assert.deepEqual(batchWords, ['echo', 'exit', 'goto', 'node', 'set', 'setlocal', 'where'], 'the cmd shim runs something it did not run before');
  assert.equal(batch.split(/\r?\n/).filter((line) => /^node "%here%bin\\claude-health\.mjs" %\*$/.test(line)).length, 1);
  for (const line of batch.split(/\r?\n/)) {
    if (/^\s*(rem\b|::|@echo)/i.test(line)) continue;
    const bare = line.replace(/"[^"]*"/g, '""');
    assert.ok(!/%(here|USERPROFILE|TEMP)%/.test(bare), `an unquoted path in the cmd shim: ${line}`);
  }
  // Neither names a program that opens a browser, Claude Code, or the file the two once passed between them.
  for (const [name, text] of [['claude-health', posix], ['claude-health.cmd', batch]]) {
    const code = text.split(/\r?\n/).filter((line) => !/^\s*(#|rem\b)/i.test(line)).join('\n');
    for (const gone of [/\bclaude\b(?!-health)/, /\bexplorer\b/, /\bxdg-open\b/, /\bwslview\b/, /\bstart\b/, /\bopen\b/, /CLAUDE_HEALTH_NEXT/, /CLAUDE_HEALTH_OPENER/, /\bmktemp\b/, /\bfindstr\b/, /\bcygpath\b/, /MSYS/]) {
      assert.ok(!gone.test(code), `${name} still holds ${gone}`);
    }
  }
});
