// The one module that reads the surroundings: whether somebody is looking, colour, Unicode, the
// width, whether the run is inside a Claude Code session, the language of the system, and how a
// command is shown so that it can be pasted.

import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './helpers/fixtures.mjs';

const { colourSupported, localeLanguage, shellLine, surroundings, unicodeSupported } = await load('lib/surroundings.mjs');
const { WIDTH } = await load('lib/term.mjs');

const tty = { isTTY: true };
const pipe = { isTTY: false };

test('colour is off without a terminal, with NO_COLOR and with TERM=dumb, and can be forced', () => {
  assert.equal(colourSupported({}, true), true);
  assert.equal(colourSupported({}, false), false);
  assert.equal(colourSupported({ NO_COLOR: '1' }, true), false);
  assert.equal(colourSupported({ TERM: 'dumb' }, true), false);
  assert.equal(colourSupported({ FORCE_COLOR: '1' }, false), true);
  assert.equal(colourSupported({ FORCE_COLOR: '0' }, false), false);
  assert.equal(colourSupported({ FORCE_COLOR: '1', NO_COLOR: '1' }, true), false, 'NO_COLOR wins');
});

test('Unicode is kept where the glyphs render one column wide, and dropped elsewhere', () => {
  assert.equal(unicodeSupported({ WT_SESSION: 'x' }, 'win32'), true);
  assert.equal(unicodeSupported({ TERM_PROGRAM: 'vscode' }, 'win32'), true);
  assert.equal(unicodeSupported({}, 'win32'), false, 'the legacy Windows console');
  assert.equal(unicodeSupported({ TERM: 'xterm-256color' }, 'linux'), true);
  assert.equal(unicodeSupported({ TERM: 'linux' }, 'linux'), false, 'the Linux virtual console');
  assert.equal(unicodeSupported({ TERM: 'xterm', LANG: 'ja_JP.UTF-8' }, 'linux'), false, 'glyphs render two columns wide there');
  assert.equal(unicodeSupported({ TERM: 'xterm', LC_ALL: 'zh_CN.UTF-8' }, 'darwin'), false);
  assert.equal(unicodeSupported({ WT_SESSION: 'x', CLAUDE_HEALTH_ASCII: '1' }, 'win32'), false);
});

test('the skin follows the flags first, then the environment', () => {
  const skin = (given) => {
    const { colour, unicode, watched } = surroundings(given);
    return { colour, unicode, watched };
  };
  const terminal = { env: { WT_SESSION: 'x' }, platform: 'win32', input: tty, output: tty };
  assert.deepEqual(skin(terminal), { colour: true, unicode: true, watched: true });
  assert.deepEqual(skin({ ...terminal, flags: { plain: true } }), { colour: false, unicode: true, watched: false });
  assert.deepEqual(skin({ ...terminal, flags: { ascii: true } }), { colour: true, unicode: false, watched: true });
  // Piped: no colour, Unicode kept (a file or a pipe shows what it is given).
  assert.deepEqual(skin({ env: {}, platform: 'win32', input: pipe, output: pipe }), { colour: false, unicode: true, watched: false });
  assert.deepEqual(skin({ env: {}, platform: 'win32', input: pipe, output: pipe, flags: { color: true } }), { colour: true, unicode: true, watched: false });
  // Git Bash gives Node no terminal; the shell script says there is one.
  assert.deepEqual(skin({ env: { CLAUDE_HEALTH_TTY: '1', MSYSTEM: 'MINGW64' }, platform: 'win32', input: pipe, output: pipe }), { colour: true, unicode: true, watched: true });
  assert.equal(skin({ env: { NO_COLOR: '1' }, platform: 'linux', input: tty, output: tty, flags: { color: true } }).colour, true, 'a flag is an explicit wish');
  // Called with nothing, it answers for a run nobody watches.
  assert.deepEqual(skin({}), { colour: false, unicode: true, watched: false });
});

test('whether anybody can answer, and whether what is typed has to be written out', () => {
  const answer = (given) => {
    const { watched, unattended, echo } = surroundings({ platform: 'linux', env: {}, ...given });
    return { watched, unattended, echo };
  };
  // A terminal on both ends: questions are asked, and the terminal shows what is typed.
  assert.deepEqual(answer({ input: tty, output: tty }), { watched: true, unattended: false, echo: false });
  // Answers from a pipe: questions are asked, and each answer is written after its prompt.
  assert.deepEqual(answer({ input: pipe, output: pipe }), { watched: false, unattended: false, echo: true });
  // Git Bash, as the shell script reports it.
  assert.deepEqual(answer({ input: pipe, output: pipe, env: { CLAUDE_HEALTH_TTY: '1' } }), { watched: true, unattended: false, echo: false });
  // The output goes to a file and the keyboard is a terminal: a question would be asked into the file.
  assert.deepEqual(answer({ input: tty, output: pipe }), { watched: false, unattended: true, echo: false });
  // Started by an agent inside Claude Code: nobody is there to answer.
  assert.deepEqual(answer({ input: pipe, output: pipe, env: { CLAUDECODE: '1' } }), { watched: false, unattended: true, echo: true });
  // Inside a session with a terminal on both ends, somebody is: --plain says to behave as if not.
  assert.deepEqual(answer({ input: tty, output: tty, env: { CLAUDECODE: '1' } }), { watched: true, unattended: false, echo: false });
  assert.deepEqual(answer({ input: tty, output: tty, env: { CLAUDECODE: '1' }, flags: { plain: true } }), { watched: false, unattended: true, echo: false });
});

test('a run is inside a Claude Code session when Claude Code says so, and for no other reason', () => {
  const session = (env, streams = { input: pipe, output: pipe }) => surroundings({ env, platform: 'win32', ...streams }).session;
  assert.equal(session({ CLAUDECODE: '1' }), true);
  assert.equal(session({ CLAUDECODE: '1' }, { input: tty, output: tty }), true);
  assert.equal(session({}), false);
  assert.equal(session({ CLAUDECODE: '0' }), false);
  assert.equal(session({ CLAUDECODE: '' }), false);
  // A run whose output goes to a file is unattended, and that does not make it a session.
  assert.equal(session({}, { input: tty, output: pipe }), false);
  assert.equal(session({ CLAUDE_HEALTH_TTY: '1', MSYSTEM: 'MINGW64', TERM_PROGRAM: 'vscode' }), false);
});

test('one width whatever the window: the size of the window is never an answer', () => {
  for (const [columns, rows] of [[40, 10], [78, 25], [80, 24], [300, 90], [undefined, undefined]]) {
    const around = surroundings({ env: { WT_SESSION: 'x' }, platform: 'win32', input: tty, output: { isTTY: true, columns, rows } });
    assert.equal(around.width, WIDTH, `${columns}x${rows}`);
    assert.deepEqual(Object.keys(around).sort(), ['colour', 'echo', 'session', 'unattended', 'unicode', 'watched', 'width']);
  }
  // A stream that would answer for its size is never asked.
  const asked = [];
  const output = new Proxy({ isTTY: true }, { get: (target, name) => (asked.push(name), target[name]) });
  surroundings({ env: {}, platform: 'linux', input: tty, output });
  assert.deepEqual([...new Set(asked)], ['isTTY']);
});

test('the language a run starts in follows the system: Slovak when it says so, else English', () => {
  assert.equal(localeLanguage({ LANG: 'sk_SK.UTF-8' }), 'sk');
  assert.equal(localeLanguage({ LC_ALL: 'sk_SK.UTF-8', LANG: 'en_US.UTF-8' }), 'sk', 'LC_ALL comes first');
  assert.equal(localeLanguage({ LC_MESSAGES: 'sk_SK', LANG: 'en_US.UTF-8' }), 'sk');
  assert.equal(localeLanguage({ LC_ALL: 'en_US.UTF-8', LANG: 'sk_SK.UTF-8' }), 'en');
  assert.equal(localeLanguage({ LANG: 'de_DE.UTF-8' }), 'en');
  // The locale the caller names (the launcher's tests do) comes before the environment.
  assert.equal(localeLanguage({ LANG: 'en_US.UTF-8' }, 'sk-SK'), 'sk');
  assert.equal(localeLanguage({ LANG: 'sk_SK.UTF-8' }, 'en-US'), 'en');
});

test('a command to paste is a program and plain words: nothing a shell could rewrite', () => {
  assert.equal(shellLine('claude'), 'claude');
  assert.equal(shellLine('claude-health', ['check', '--lang', 'en']), 'claude-health check --lang en');
  // Git Bash turns an argument that begins with a slash into a Windows path. Which shell a line
  // is pasted into cannot be known, so such a line is never made.
  for (const argument of ['/claude-health resume 20261001-131730', '//claude-health', '"/claude-health resume 20261001-131730"', "'/x'", '/x']) {
    assert.throws(() => shellLine('claude', [argument]), /cannot be shown as a command to paste/, argument);
  }
  // Nor one that needs quoting, which every shell does its own way.
  for (const argument of ['two words', 'a"b', '$HOME', '`id`', 'a;b', 'a&b', 'a|b', '%TEMP%', '', '~/x', 'C:\\x']) {
    assert.throws(() => shellLine('claude', [argument]), /cannot be shown as a command to paste/, JSON.stringify(argument));
  }
  assert.throws(() => shellLine('/bin/claude'), /cannot be shown as a command to paste/);
});
