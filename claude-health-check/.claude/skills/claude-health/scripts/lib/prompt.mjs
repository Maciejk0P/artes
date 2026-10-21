// The questions of the launcher: a numbered list answered by a number and Enter, and a line of
// text. Input and output are parameters, so a test can type on a fake stream and read what was
// written; nothing here touches process.stdin or process.stdout.
//
// Nothing here reads a single key or moves the cursor. A question is printed once, its answer is
// a line typed in the terminal's own mode, with its echo and its editing keys, and what follows
// is printed under it. So no window is too small and no typed line too long: there is nothing
// on screen that has to be found again.
//
// Launcher only. Inside Claude Code the questions are pickers, defined by ui.mjs.

import { visible } from './term.mjs';

// One reader for one input stream. It hands out whole lines, so several questions can follow
// each other on one stream, typed or piped.
export function createReader(stream) {
  let buffer = '';
  let ended = false;
  let waiting = null;

  const take = () => {
    const at = buffer.indexOf('\n');
    if (at === -1) {
      if (!ended) return null;
      if (buffer === '') return { value: null };
      const rest = buffer;
      buffer = '';
      return { value: rest.replace(/\r$/, '') };
    }
    const line = buffer.slice(0, at).replace(/\r$/, '');
    buffer = buffer.slice(at + 1);
    return { value: line };
  };
  const serve = () => {
    if (!waiting) return;
    const found = take();
    if (!found) return;
    const resolve = waiting;
    waiting = null;
    resolve(found.value);
  };
  const onData = (chunk) => {
    buffer += String(chunk);
    serve();
  };
  const onEnd = () => {
    ended = true;
    serve();
  };
  // The stream is touched at the first question, so a run that asks nothing never reads from it.
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    stream.setEncoding?.('utf8');
    stream.on('data', onData);
    stream.on('end', onEnd);
  };

  return {
    // The next line, without its line break; null at the end of the input.
    line: () =>
      new Promise((resolve) => {
        if (waiting) throw new Error('the reader is already waiting for input');
        waiting = resolve;
        listen();
        stream.resume?.();
        serve();
      }),
    // Lets go of the stream, so that a program that is done can end.
    close() {
      if (!listening) return;
      stream.off?.('data', onData);
      stream.off?.('end', onEnd);
      stream.pause?.();
      listening = false;
    },
  };
}

// The line that answers a prompt; null at the end of the input. This is the one place where an
// answer is written out, and the one text the launcher writes that is not its own: a line from
// a pipe may be the output of another program. So it passes visible(), like every name from a
// scanned file, and cannot clear the screen or move the cursor.
// `echo` writes the answer after the prompt where no terminal does it (a pipe). At the end of
// the input nobody typed the line break that ends the line of the prompt, so it is written.
async function answerTo({ reader, output, echo }) {
  const line = await reader.line();
  if (echo || line === null) output.write(`${visible(line ?? '')}\n`);
  return line;
}

// A question: the lines end in a prompt, and the answer is a line. An empty line takes the
// default; so does the end of the input, and that is reported.
export async function selectNumbered({ reader, output, lines, count, def = 0, invalid, echo = false }) {
  output.write(`${lines.join('\n')} `);
  for (;;) {
    const line = await answerTo({ reader, output, echo });
    if (line === null) return { index: def, defaulted: true };
    const text = line.trim();
    if (text === '') return { index: def, defaulted: false };
    if (/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= count) return { index: Number(text) - 1, defaulted: false };
    output.write(`${invalid}\n${lines[lines.length - 1]} `);
  }
}

// One line of text; null at the end of the input.
export async function readLine({ reader, output, prompt, echo = false }) {
  output.write(prompt);
  return answerTo({ reader, output, echo });
}
