// Where this program runs. Every fact about its surroundings is read here and nowhere else:
// whether somebody is looking, whether colour and Unicode can be used, the width to lay out for,
// whether the run was started inside a Claude Code session, which language the system speaks,
// and how a command is shown so that it can be pasted.
//
// The launcher and ui.mjs ask; neither reads a variable of the environment or a property of a
// stream, and a test holds them to that (tests/audit.test.mjs). A fact read in two places is two
// answers to one question: that is how a window was taken for roomy after it had been made
// smaller, a cmd window for Git Bash, and a session for a terminal.
//
// What the answers are made from is handed in, so a test can stand in for all of it.

import { WIDTH } from './term.mjs';

// The language a run starts in before anyone chose: Slovak when the system says so, else English.
export function localeLanguage(env = {}, locale = null) {
  const name = locale || env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '';
  return /^sk/i.test(name) ? 'sk' : 'en';
}

export function colourSupported(env = {}, terminal = false) {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== '';
  return Boolean(terminal) && env.TERM !== 'dumb';
}

export function unicodeSupported(env = {}, platform = process.platform) {
  if (env.CLAUDE_HEALTH_ASCII) return false;
  // Under these locales the box and block glyphs render two columns wide and break the bars.
  if (/^(ja|ko|zh)/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) return false;
  if (platform !== 'win32') return env.TERM !== 'linux';
  // The legacy Windows console announces itself by announcing nothing.
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuTask || env.MSYSTEM || env.TERM);
}

// input, output: the two streams of the run. flags: { plain, color, ascii } from the command line.
export function surroundings({ env = {}, platform = process.platform, input = {}, output = {}, flags = {} } = {}) {
  // Git Bash may give Node pipes where the shell script still sees a terminal; it says so.
  const reported = env.CLAUDE_HEALTH_TTY === '1';
  // Somebody is looking: there is a terminal, and --plain did not ask to print as for a pipe.
  const watched = !flags.plain && (Boolean(output.isTTY) || reported);
  const session = env.CLAUDECODE === '1';
  return {
    watched,
    colour: flags.plain ? false : flags.color ? true : colourSupported(env, watched),
    unicode: flags.ascii ? false : watched ? unicodeSupported(env, platform) : !env.CLAUDE_HEALTH_ASCII,
    // One layout for every window. The size of the window is not read: nothing is repainted in
    // place, so a line that wraps or scrolls away is still a line that was printed once.
    width: WIDTH,
    // Started inside a Claude Code session: what is printed there is paid for from the person's plan.
    session,
    // Nobody can answer a question: started by an agent inside Claude Code, or the questions
    // would go to a file.
    unattended: (session && !watched) || (!output.isTTY && Boolean(input.isTTY) && !reported),
    // A pipe does not show what was typed; a terminal does.
    echo: !input.isTTY && !reported,
  };
}

// A command a person is asked to paste into a shell, as one line.
//
// Which shell the line ends up in cannot be told from here. Git Bash rewrites an argument that
// begins with a slash into a Windows path unless one of three settings says otherwise, and a cmd
// window started from Git Bash carries the same variables. Three repairs guessed the shell, and
// each was wrong one shell further. So the answer is the same everywhere: a line is a program
// and plain words, with nothing that begins with a slash and nothing a shell would have to be
// told to leave alone. A command of Claude Code, which does begin with a slash, is typed inside
// Claude Code; no shell ever sees it.
const PLAIN_WORD = /^[A-Za-z0-9_.=:-]+$/;

export function shellLine(program, args = []) {
  const words = [program, ...args];
  const odd = words.find((word) => !PLAIN_WORD.test(word));
  if (odd !== undefined) throw new Error(`"${odd}" cannot be shown as a command to paste: a shell may rewrite it, and which shell it will be is not known`);
  return words.join(' ');
}
