// The launcher's questions, driven by fake streams: lines go in, what was written comes out.
// A question is a numbered list answered by a number and Enter; nothing reads a single key and
// nothing moves the cursor.

import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './helpers/fixtures.mjs';
import { KEY_TIMEOUT, controlsIn, fakeInput, fakeOutput } from './helpers/console.mjs';

const prompt = await load('lib/prompt.mjs');
const { createReader, readLine, selectNumbered } = prompt;
const render = await load('lib/render.mjs');

const o = { lang: 'en', colour: false, unicode: true };
const question = { question: 'Which one?', options: [{ label: 'First' }, { label: 'Second' }, { label: 'Third' }] };
const lines = render.numbered({ ...question, def: 0 }, o);
const invalid = '  Type a number from 1 to 3.';

function setup(options) {
  const input = fakeInput(options);
  const output = fakeOutput(options);
  return { input, output, reader: createReader(input) };
}

test('a question is a numbered list answered with a number and Enter', { timeout: KEY_TIMEOUT }, async () => {
  const typed = setup({ tty: false });
  const answer = selectNumbered({ reader: typed.reader, output: typed.output, lines, count: 3, def: 0, invalid, echo: true });
  typed.input.write('3\n');
  assert.deepEqual(await answer, { index: 2, defaulted: false });
  assert.equal(typed.output.text(), `${lines.join('\n')} 3\n`, 'the prompt stays on its line and the answer is echoed after it');

  const empty = setup({ tty: false });
  const byDefault = selectNumbered({ reader: empty.reader, output: empty.output, lines, count: 3, def: 1, invalid, echo: false });
  empty.input.write('\r\n');
  assert.deepEqual(await byDefault, { index: 1, defaulted: false }, 'a bare Enter takes the default');

  const wrong = setup({ tty: false });
  const retried = selectNumbered({ reader: wrong.reader, output: wrong.output, lines, count: 3, def: 0, invalid, echo: false });
  wrong.input.write('7\nabc\nq\n0\n 2 \n');
  assert.deepEqual(await retried, { index: 1, defaulted: false });
  assert.equal(wrong.output.text().split(invalid).length - 1, 4, 'each wrong answer is told once, and no letter is a key');

  const ended = setup({ tty: false });
  const atEnd = selectNumbered({ reader: ended.reader, output: ended.output, lines, count: 3, def: 2, invalid, echo: false });
  ended.input.end();
  assert.deepEqual(await atEnd, { index: 2, defaulted: true }, 'when the input ends, the default is taken and reported');
});

test('a terminal is left in its own mode: raw mode is never asked for, and no escape byte is written', { timeout: KEY_TIMEOUT }, async () => {
  const { input, output, reader } = setup({ tty: true });
  const answer = selectNumbered({ reader, output, lines, count: 3, def: 0, invalid, echo: false });
  // Arrow keys and a digit without Enter are not answers: they are part of a line that is still being typed.
  input.write('\u001b[B');
  input.write('2');
  let settled = false;
  answer.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'a key without Enter answered the question');
  input.write('\r\n');
  // The line holds the bytes of the arrow key, so it is no number; the next line is.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  input.write('2\r\n');
  assert.deepEqual(await answer, { index: 1, defaulted: false });
  const folder = readLine({ reader, output, prompt: '  > ' });
  input.write('C:\\work\\my project\r\n');
  assert.equal(await folder, 'C:\\work\\my project');
  assert.deepEqual(input.rawModes, [], 'raw mode was asked for');
  assert.deepEqual(controlsIn(output.text()), []);
  assert.ok(output.text().endsWith('  > '), 'the line is typed after the prompt, with the echo of the terminal');
});

test('an answer from a pipe is written back as text: what a terminal would act on is shown as a mark', { timeout: KEY_TIMEOUT }, async () => {
  // An answer is not this program's own text: it may be the output of another program. Echoed
  // byte for byte, a line of it would clear the screen, move the cursor or reorder what follows.
  const hostile = 'no\u001b[2J\u001b[H\u0007\u0008\rwh\u009b2Jere\u202e';
  const { input, output, reader } = setup({ tty: false });
  input.end(`9${hostile}\n2\n${hostile}\n`);
  assert.deepEqual(await selectNumbered({ reader, output, lines, count: 3, def: 0, invalid, echo: true }), { index: 1, defaulted: false });
  // The line itself is handed on as it was typed: it names a folder, and the folder is looked for under that name.
  assert.equal(await readLine({ reader, output, prompt: '  > ', echo: true }), hostile);
  assert.equal(await readLine({ reader, output, prompt: '  > ', echo: true }), null);
  assert.deepEqual(controlsIn(output.text()), []);
  assert.ok(output.text().includes('  > no\ufffd[2J\ufffd[H\ufffd\ufffd\ufffdwh\ufffd2Jere\ufffd\n'), 'the answer is not shown after its prompt, a mark for each character a terminal acts on');
  assert.ok(output.text().endsWith('  > \n'), 'the end of the input ends the line of the prompt');
});

test('several questions read from one piped input, one line each', { timeout: KEY_TIMEOUT }, async () => {
  const { input, output, reader } = setup({ tty: false });
  input.end('2\n\n/some/folder\n1\n');
  const ask = () => selectNumbered({ reader, output, lines, count: 3, def: 0, invalid: 'x', echo: false });
  assert.deepEqual(await ask(), { index: 1, defaulted: false });
  assert.deepEqual(await ask(), { index: 0, defaulted: false });
  assert.equal(await readLine({ reader, output, prompt: '  > ' }), '/some/folder');
  assert.deepEqual(await ask(), { index: 0, defaulted: false });
  assert.deepEqual(await ask(), { index: 0, defaulted: true });
  assert.equal(await readLine({ reader, output, prompt: '  > ' }), null, 'no line is left');
});

test('a line of any length is one answer, and a line without its end is read when the input ends', { timeout: KEY_TIMEOUT }, async () => {
  const { input, output, reader } = setup({ tty: false });
  const long = 'x'.repeat(100_000);
  const first = readLine({ reader, output, prompt: '' });
  // A long line arrives in pieces.
  for (let at = 0; at < long.length; at += 7919) input.write(long.slice(at, at + 7919));
  input.write('\n');
  assert.equal(await first, long);
  input.end('last, without a line break');
  assert.equal(await readLine({ reader, output, prompt: '' }), 'last, without a line break');
  assert.equal(await readLine({ reader, output, prompt: '' }), null);
});

test('the module has no arrow-key question, no pause and no viewer', () => {
  assert.deepEqual(Object.keys(prompt).sort(), ['createReader', 'readLine', 'selectNumbered']);
  assert.deepEqual(Object.keys(createReader(fakeInput())).sort(), ['close', 'line']);
});
