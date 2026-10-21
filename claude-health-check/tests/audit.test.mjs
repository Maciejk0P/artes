// Contracts from the audit of 2 Oct 2026 (AUDIT.md). Two rounds of review and repair showed the
// same thing twice: a repair that fitted the reported example, and a new defect of the same class
// one module further. Each test here closes a class, not an example - or, where the class can only
// be closed by the refactor that has not happened yet, keeps it from growing and says so.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PACKAGE_ROOT, SCRIPTS } from './helpers/fixtures.mjs';

const shipped = () => [
  ['bin/claude-health.mjs', path.join(PACKAGE_ROOT, 'bin', 'claude-health.mjs')],
  ...readdirSync(SCRIPTS).filter((name) => name.endsWith('.mjs')).map((name) => [name, path.join(SCRIPTS, name)]),
  ...readdirSync(path.join(SCRIPTS, 'lib')).filter((name) => name.endsWith('.mjs')).map((name) => [`lib/${name}`, path.join(SCRIPTS, 'lib', name)]),
].map(([name, file]) => [name, readFileSync(file, 'utf8')]);

const envNames = (source) => [...new Set([...source.matchAll(/\benv\.([A-Za-z_][A-Za-z_0-9]*)/g)].map((match) => match[1]))].sort();
// What a stream says about its other end: whether it is a terminal, how large its window is,
// whether single keys can be read from it. The read is found by its name and not by its
// spelling: as a property, as a name taken out of an object, as a name in brackets.
const STREAM = '(?:input|output|stream|stdin|stdout|stderr)';
const STREAM_FACTS = [
  // Names only a stream has count wherever they stand.
  /\b(isTTY|setRawMode|getWindowSize|getColorDepth|hasColors)\b/g,
  // The width of the window, of whatever object it is asked.
  /\.(columns)\b/g,
  /\[\s*['"`](columns)['"`]\s*\]/g,
  /\{[^{}]*\b(columns)\b[^{}]*\}\s*=/g,
  // Its height shares a name with ordinary values (the rows of a table), so it counts where a
  // stream is named, and in brackets.
  new RegExp(`\\b${STREAM}\\.(rows)\\b`, 'g'),
  /\[\s*['"`](rows)['"`]\s*\]/g,
  new RegExp(`\\{[^{}]*\\b(rows)\\b[^{}]*\\}\\s*=\\s*(?:\\w+\\.)*${STREAM}\\b`, 'g'),
];
const streamFacts = (source) => [...new Set(STREAM_FACTS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1])))].sort();

// Every decision the launcher got wrong in review was a fact about its surroundings read on the
// spot: is this a terminal (repaint in a window that cannot hold a page), is this Git Bash (the
// printed command with the wrong number of slashes, three variations), is this a session ("no
// tokens" said inside one). Nine variables were read in bin/claude-health.mjs next to the twelve
// of lib/term.mjs, and three of them in two modules for two different questions. They are read in
// one module now, and this table is the whole list: a new variable, or a second file that reads
// one, has to be written down here with its reason.
const SURROUNDINGS = 'lib/surroundings.mjs';
const ENVIRONMENT_READERS = {
  [SURROUNDINGS]: [
    // inside a Claude Code session
    'CLAUDECODE',
    // the two glyph skins
    'CLAUDE_HEALTH_ASCII',
    // the shell script saw a terminal where Node is given pipes (Git Bash)
    'CLAUDE_HEALTH_TTY',
    // a Windows console that draws Unicode (with MSYSTEM, TERM, TERM_PROGRAM and WT_SESSION)
    'ConEmuTask',
    // colour
    'FORCE_COLOR',
    // the language of the first question, and the locales whose glyphs are two columns wide
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LC_MESSAGES',
    'MSYSTEM',
    'NO_COLOR',
    'TERM',
    'TERM_PROGRAM',
    'WT_SESSION',
  ],
};

test('the environment is read only where this table says, and only the variables it names', () => {
  const found = Object.fromEntries(shipped().map(([name, source]) => [name, envNames(source)]).filter(([, names]) => names.length));
  assert.ok((found[SURROUNDINGS] ?? []).length >= 10, 'the scan of the sources found almost no variable: the pattern no longer matches how the code reads the environment');
  assert.deepEqual(found, ENVIRONMENT_READERS, `a module reads the environment that the table does not name (or stopped reading it): move the read into ${SURROUNDINGS}, or add it to ENVIRONMENT_READERS with its reason`);
});

// The same fact read by two modules is two answers to one question. MSYSTEM was that: one module
// took it as "there is a terminal", the launcher as "this is Git Bash" - and a cmd window started
// from Git Bash carries it too (verification of 2 Oct 2026). A fact is a variable of the
// environment or what a stream says about its other end.
test('a fact about the surroundings has one reader', () => {
  const readers = new Map();
  for (const [name, source] of shipped()) for (const fact of [...envNames(source), ...streamFacts(source)]) readers.set(fact, [...(readers.get(fact) ?? []), name]);
  assert.ok(readers.size >= 10 && readers.has('isTTY'), 'the scan of the sources found almost no fact: the patterns no longer match how the code reads its surroundings');
  // A stream taken apart, asked in brackets or reached under another name is still a stream read.
  assert.deepEqual(streamFacts('const { columns: windowColumns = 0, isTTY: looked = false } = output;'), ['columns', 'isTTY']);
  assert.deepEqual(streamFacts("const wide = io.output['columns'] > 100 && io.output['rows'] > 30;"), ['columns', 'rows']);
  assert.deepEqual(streamFacts('const out = io.output; if (out.columns > 100 && process.stdout.rows > 30) wide();'), ['columns', 'rows']);
  assert.deepEqual(streamFacts('const { rows } = process.stdout; const [width] = stream.getWindowSize();'), ['getWindowSize', 'rows']);
  assert.deepEqual(streamFacts('const { sides, rank, rows } = arrange(graph); group.rows.push(row);'), [], 'the rows of a table are taken for the height of a window');
  const elsewhere = [...readers].filter(([, files]) => files.length > 1 || files[0] !== SURROUNDINGS).map(([fact, files]) => `${fact}: ${files.join(' + ')}`);
  assert.deepEqual(elsewhere, [], `read outside ${SURROUNDINGS}, or in two modules`);
  // The size of the window is asked nowhere at all: one layout fits every window.
  assert.deepEqual(streamFacts(shipped().map(([, source]) => source).join('\n')), ['isTTY'], 'a stream is asked for more than whether it is a terminal');
  // Outside that module the environment is passed on whole, never opened: not by a name in
  // brackets, not by taking it apart, not by listing it.
  const env = '(?<![\\w.])(?:(?:io|process|context)\\.)?env\\b';
  const opened = new RegExp(`${env}\\s*\\[|\\}\\s*=\\s*${env}|Object\\.(?:keys|entries|values|assign)\\(\\s*${env}|\\.\\.\\.${env}|\\bin\\s+${env}`);
  assert.match('const { MSYSTEM } = io.env;', opened);
  assert.match("if (process.env['MSYSTEM']) x();", opened);
  assert.doesNotMatch('surroundings({ env: io.env, platform: io.platform })', opened);
  for (const [name, source] of shipped()) if (name !== SURROUNDINGS) assert.ok(!opened.test(source), `${name} opens the environment: ${opened.exec(source)?.[0]}`);
});

// What the walk keeps between two calls of ui.mjs. The first run of the wizard by a model found
// two defects of one shape: a value computed when the reading was merged and shown many cards
// later (the count on "skip the rest of this file", the line numbers in its preview), and an
// answer accepted although the file had changed under the open card. A key kept between calls
// needs a decision about how long it is true; this table is where that decision is written.
const STATE_KEYS = {
  'frozen when the reading is merged': ['queue'],
  'frozen at the first card': ['walk'],
  'rewritten by every card or answer': ['current', 'decisions', 'fileShown', 'receipts', 'stopped'],
};

test('every key the walk keeps between calls has a stated lifetime', () => {
  const ui = shipped().find(([name]) => name === 'ui.mjs')[1];
  const used = [...new Set([...ui.matchAll(/\bstate\.([a-zA-Z]+)\b/g)].map((match) => match[1]))].sort();
  assert.ok(used.length >= 5, 'the scan found almost no key: the walk no longer keeps its state under the name "state"');
  assert.deepEqual(used, Object.values(STATE_KEYS).flat().sort(), 'the walk keeps a key that has no stated lifetime (or lost one): add it to STATE_KEYS under the moment it stops being true');
});

// The wizard prompt says: if the script fails, show its message and stop. A refusal that does not
// say what to run next is therefore the end of the person's run. The first end-to-end run met
// four of them (a target the tool does not write, a change waiting for a draft, a mistyped
// folder, an unknown run). The number below is a ceiling, not a target: it may only go down.
const REFUSALS_WITHOUT_A_NEXT_STEP = 23;

test('the refusals of the wizard script that name no next command do not grow', () => {
  const ui = shipped().find(([name]) => name === 'ui.mjs')[1];
  const refusals = ui.split('\n').filter((line) => /throw new (Usage)?Error\(/.test(line));
  assert.ok(refusals.length >= 20, 'the scan found almost no refusal: the pattern no longer matches how ui.mjs refuses');
  // `again` is the variable that holds "run this card again"; a message built with it names its next step.
  const silent = refusals.filter((line) => !/\b[Rr]un: |\$\{again\}/.test(line));
  assert.ok(silent.length <= REFUSALS_WITHOUT_A_NEXT_STEP, `${silent.length} refusals name no next command, the ceiling is ${REFUSALS_WITHOUT_A_NEXT_STEP}: end the new message with "Run: <command>"`);
  assert.equal(silent.length, REFUSALS_WITHOUT_A_NEXT_STEP, 'fewer refusals are silent now: lower REFUSALS_WITHOUT_A_NEXT_STEP so the gain is kept');
});
