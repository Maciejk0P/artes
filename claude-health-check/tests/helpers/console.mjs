// Test support for the console: views that read the same on every machine, the list of screens
// the launcher shows, fake terminal streams, and the launcher and ui.mjs as child processes.

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { PACKAGE_ROOT, SCRIPTS, load, materialise } from './fixtures.mjs';

const { runChecks } = await load('checks.mjs');
const { buildView } = await load('lib/view.mjs');
const { scan } = await load('scan.mjs');
const render = await load('lib/render.mjs');

export const NOW = new Date('2026-10-01T13:17:30.000Z');
export const STAMP = '20261001-131730';
export const DEMO_ROOT = '/work/demo';
export const LAUNCHER = path.join(PACKAGE_ROOT, 'bin', 'claude-health.mjs');
export const SKINS = [
  { name: 'unicode', colour: false, unicode: true },
  { name: 'ascii', colour: false, unicode: false },
  { name: 'colour', colour: true, unicode: true },
];

// Every path of a result moved from the temp copy to one fixed folder, so that what is rendered
// from it has the same widths on every machine.
export function relocate(value, root) {
  return JSON.parse(JSON.stringify(value).split(root).join(DEMO_ROOT));
}

// { scan, checks, view } of a fixture, with paths under /work/demo. options: { nested, judgement }.
export function demo(name, lang, options = {}) {
  const fixture = materialise(name);
  try {
    const result = scan({ home: fixture.home, projects: [fixture.projects], nested: Boolean(options.nested), now: NOW });
    const judgement = typeof options.judgement === 'function' ? options.judgement(fixture) : options.judgement;
    const checks = runChecks(result, { lang, judgement, now: NOW });
    const moved = { scan: relocate(result, fixture.root), checks: relocate(checks, fixture.root) };
    return { ...moved, view: buildView({ ...moved, lang, now: NOW }) };
  } finally {
    fixture.cleanup();
  }
}

// The run as the launcher hands it to the renderer.
export const RUN = {
  stamp: STAMP,
  start: 'claude',
  inside: `/claude-health resume ${STAMP}`,
  report: { name: `state-${STAMP}.html`, url: `file://${DEMO_ROOT}/home/.claude/health-check/state-${STAMP}.html` },
};
export const INFO = { version: '0.0.0', reportName: RUN.report.name, timings: { scanMs: 41, checksMs: 75, reportMs: 26 }, capped: false };
// The folder of the tool, as the launcher names it under "how to continue".
export const TOOL = `${DEMO_ROOT}/tool`;

// Every screen the launcher can show for one view, in the order of a run: [name, lines].
export function launcherScreens(view, o) {
  const { compose } = render;
  const tr = render.text(o);
  const language = [['language', tr('ui.language.name')]];
  const scoped = [...language, ['scope', render.scopeText(view, o)]];
  const langQuestion = { question: tr('ui.lang.question'), options: [{ label: tr('ui.lang.en') }, { label: tr('ui.lang.sk') }], focused: 0 };
  const scopeQuestion = render.scopeQuestion({ here: `${DEMO_ROOT}/projects/alpha-service` }, o);
  const nestedQuestion = render.nestedQuestion(2, o);
  const link = render.reportLink(RUN, o);
  return [
    ['launch', compose.launch(INFO, langQuestion, o)],
    ['what it changes and never changes', render.promise(o)],
    ['scope', compose.ask(1, language, scopeQuestion, o)],
    ['scope, home folder', [...compose.ask(1, language, scopeQuestion, o), '', ...render.machineFacts({ maxDirs: 20000, maxDepth: 6 }, o), ...render.inputAsk(tr('ui.scope.folder.outside'), o)]],
    ['scope, nested', compose.ask(1, scoped, nestedQuestion, o)],
    ['scan', compose.scan([...scoped, ['nested', tr('ui.nested.value.no', { count: 2 })]], view, { ...INFO, capped: true }, o)],
    ['scan, inside Claude Code', compose.scan(scoped, view, { ...INFO, session: true }, o)],
    ...render.PANELS.map((key) => [`report, ${key}`, render.panel(key, view, o)]),
    // What follows the report: the link, then one of four endings.
    ['how to continue', [...link, '', ...render.wayOn(RUN, o, { folder: TOOL })]],
    ['how to continue, inside Claude Code', [...link, '', ...render.wayOn(RUN, o, { agent: true })]],
    ['nothing to change', [...link, '', ...render.cleanLine(view, o)]],
    ['another home folder', [...link, '', ...render.foreignHome(o)]],
    // What the session prints from the same view: the changes file by file, and the header of a file.
    ['session: the changes, file by file', render.changes(view, o)],
    ...view.changes.files.map((file) => [`session: the header of file ${file.k}`, render.fileHeader(file, o)]),
  ];
}

// --- fake terminal streams ---------------------------------------------------------------------------

// The keyboard of a terminal. Raw mode can be asked for, and every request is written down: the
// launcher never makes one. With `echo` what is typed appears on that output, line break
// included, as a terminal in its own mode shows it.
export function fakeInput({ tty = true, echo = null } = {}) {
  const stream = new PassThrough();
  stream.isTTY = tty;
  stream.rawModes = [];
  if (tty) {
    stream.setRawMode = (flag) => {
      stream.rawModes.push(flag);
      return stream;
    };
  }
  if (echo) {
    const write = stream.write.bind(stream);
    stream.write = (text, ...rest) => {
      echo.write(String(text).replace(/\r\n?/g, '\n'));
      return write(text, ...rest);
    };
  }
  return stream;
}

// A question nobody answers must fail its test, not hang the run.
export const KEY_TIMEOUT = 20_000;

// An output that keeps everything written to it, with the window a terminal would report.
export function fakeOutput({ tty = true, columns = 100, rows = 40 } = {}) {
  const output = new EventEmitter();
  output.isTTY = tty;
  output.columns = columns;
  output.rows = rows;
  output.getWindowSize = () => [output.columns, output.rows];
  output.chunks = [];
  output.write = (text, done) => {
    output.chunks.push(String(text));
    if (typeof done === 'function') setImmediate(done);
    return true;
  };
  output.text = () => output.chunks.join('');
  return output;
}

// Everything a terminal acts on instead of showing, but the colour codes the tool itself writes:
// an escape sequence that moves the cursor or clears something, a carriage return, a backspace,
// a bell, the control characters above ASCII (one of them starts a sequence by itself), the line
// and paragraph separators and the characters that reorder text. A run of the launcher writes
// none of them.
export const OWN_COLOUR = /\u001b\[(?:0|1|2|7|31|32|33|36|1;36)m/g;
export function controlsIn(text) {
  const rest = text.replace(OWN_COLOUR, '');
  return [...new Set(rest.match(/\u001b(?:\[[0-9;?]*[A-Za-z])?|[\u0000-\u0009\u000b-\u001a\u001c-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g) ?? [])].map((found) => JSON.stringify(found));
}

// A terminal with a window: a line wider than the window continues on the next row, and the
// cursor cannot be sent above the top row of the window. What has scrolled out of the window can
// no longer be erased. Returns the rows as a person would have them in the scrollback, and how
// often the cursor was sent above the window. It plays the sequences that move the cursor and
// erase, so a run that wrote one would show here as a row left behind or a row gone.
export function playWindow(text, columns, rows) {
  const lines = [[]];
  let row = 0;
  let col = 0;
  let top = 0;
  let pending = false;
  let clipped = 0;
  const grow = () => {
    while (lines.length <= row) lines.push([]);
    if (row - rows + 1 > top) top = row - rows + 1;
  };
  for (const match of text.matchAll(/\u001b\[(\??[0-9;]*)([A-Za-z])|\r\n|\n|\r|[^\u001b\r\n]/gu)) {
    const [whole, argument, command] = match;
    if (command) {
      const count = Number(argument) || 1;
      if (command === 'A') {
        pending = false;
        if (row - count < top) clipped += 1;
        row = Math.max(top, row - count);
      } else if (command === 'J') {
        lines[row] = lines[row].slice(0, col);
        lines.length = row + 1;
      } else if (command === 'K') lines[row] = lines[row].slice(0, col);
      continue;
    }
    if (whole === '\n' || whole === '\r\n') {
      pending = false;
      row += 1;
      col = 0;
      grow();
    } else if (whole === '\r') {
      pending = false;
      col = 0;
    } else {
      // A character written in the last column leaves the cursor there; the next one wraps.
      if (pending) {
        row += 1;
        col = 0;
        grow();
        pending = false;
      }
      while (lines[row].length < col) lines[row].push(' ');
      lines[row][col] = whole;
      col += 1;
      if (col >= columns) pending = true;
    }
  }
  return { lines: lines.map((line) => line.join('')), clipped };
}

// --- child processes -----------------------------------------------------------------------------

// The environment of a child: the home folder is the fixture's, whatever the script would look up.
export function childEnv(home, extra = {}) {
  // The language of the first question follows the system; the tests pin it. They pin as well
  // what the shell they are started from would decide: a terminal that draws Unicode, outside a
  // session of Claude Code.
  const env = { ...process.env, HOME: home, USERPROFILE: home, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TERM_PROGRAM: 'tests', ...extra };
  for (const name of ['NO_COLOR', 'FORCE_COLOR', 'CLAUDECODE', 'CLAUDE_HEALTH_TTY', 'CLAUDE_HEALTH_ASCII', 'MSYSTEM']) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

export function runLauncher(args, { home, env = {}, input = '', cwd = PACKAGE_ROOT } = {}) {
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8', input, cwd, env: childEnv(home, env) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function runUi(args, { home, env = {}, cwd = PACKAGE_ROOT } = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, 'ui.mjs'), ...args, '--home', home], { encoding: 'utf8', cwd, env: childEnv(home, env) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Every file below a folder with its size and time of change: two listings show what a run wrote.
export function listing(dir, base = dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listing(full, base, out);
    else {
      const stat = statSync(full);
      out.set(path.relative(base, full).replace(/\\/g, '/'), `${stat.size}:${stat.mtimeMs}`);
    }
  }
  return out;
}

export function changedFiles(before, after) {
  return [...after.keys()].filter((file) => before.get(file) !== after.get(file)).sort();
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// --- what a wizard would write after the reading ------------------------------------------------

// A candidate of reading.json confirmed as it stands: its own lines quoted exactly, the kind it
// carries, and a title that names the check it came from. `more` overrides any field.
export function confirmed(candidate, more = {}) {
  return {
    candidate: candidate.id,
    title: `Confirmed: ${candidate.check}`,
    severity: 'low',
    file: candidate.file,
    line: candidate.line,
    endLine: candidate.endLine,
    quote: candidate.quote,
    ...(candidate.related.length ? { related: candidate.related.map((other) => ({ file: other.file, line: other.line, quote: other.quote })) } : {}),
    message: candidate.asks,
    why: 'Read, and it is what it looked like.',
    kind: candidate.kind,
    detail: 'As the candidate says.',
    ...more,
  };
}

export const dismissed = (candidate, reason = 'not what it looked like') => ({ candidate: candidate.id, dismissed: true, reason });

// The checks of a scan as they stand after a reading that confirmed every candidate of the
// named checks, each with the severity given for it, and left the other candidates unread.
// `confirm` is { check: severity }. A confirmed candidate is titled with the name of its check.
export function checksAfterReading(scanResult, confirm, options = {}) {
  const judgement = runChecks(scanResult, options)
    .candidates.filter((candidate) => candidate.check in confirm)
    .map((candidate) => ({
      candidate: candidate.id,
      title: candidate.check,
      severity: confirm[candidate.check],
      file: candidate.file,
      line: candidate.line,
      endLine: candidate.endLine,
      quote: candidate.quote,
      ...(candidate.related ? { related: candidate.related.map((other) => ({ file: other.file, line: other.line, quote: other.quote })) } : {}),
      message: candidate.message,
      why: candidate.why,
      kind: candidate.suggestion.kind,
      detail: candidate.suggestion.detail,
    }));
  return runChecks(scanResult, { ...options, judgement });
}
