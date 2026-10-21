// The skin of the console: one width, one page height, two glyph tables, sixteen colours.
// Nothing here knows what a screen says; lib/render.mjs builds the screens from these parts.
// Nothing here reads where the program runs either: whether colour and Unicode are used is
// decided in lib/surroundings.mjs.

// Every rendered line is at most this wide, the two-space margin included: 80 columns minus the
// indent Claude Code puts before a message, minus two to spare. The launcher uses the same
// width, so a screenshot, a test snapshot and a fenced block in a session are the same text.
export const WIDTH = 76;
// A screen is at most this many lines.
export const PAGE = 24;

// Unicode glyphs come from WGL4, the set every Windows console font carries: no emoji, no
// rounded corners, no braille. The ASCII table replaces them one for one.
export const GLYPHS = {
  unicode: {
    high: '▲', medium: '■', low: '●', review: '○', done: '√', now: '►', todo: '·',
    full: '█', empty: '░', over: '▓', mark: '│', h: '─', v: '│', hand: '║', arrow: '→', flow: '─►',
    ell: '…', sep: '·', approx: '≈', neq: '≠', times: '×',
    ask: '?', input: '›', plus: '+', minus: '−', wrap: '└', dash: '–',
    pulse: ['          ┌┐', '  ──────┐ │└┐ ┌──────', '        └─┘ └─┘'],
  },
  ascii: {
    high: '!', medium: '*', low: 'o', review: '?', done: '+', now: '>', todo: '.',
    full: '#', empty: '.', over: '!', mark: '|', h: '-', v: '|', hand: '|', arrow: '->', flow: '->',
    ell: '...', sep: '-', approx: '~', neq: '!=', times: 'x',
    ask: '?', input: '>', plus: '+', minus: '-', wrap: '\\', dash: '-',
    pulse: ['', '  ------\\  /\\  /------', '         \\/  \\/'],
  },
};

// --- text that comes from a scanned file ----------------------------------------------------------

// A name, a key, a path or a line of a scanned file is data of unknown shape. This is the one
// function that makes it printable; everything that fits a text into a line (cut, shortPath,
// wrap, the screens of lib/render.mjs) takes a text of any shape and of any length.
//
// What a terminal acts on instead of showing is replaced by a mark: the C0 and C1 control
// characters and DEL (an escape sequence can set the window title, wipe the screen or hide what
// follows), the line and paragraph separators, and the characters that reorder text (a name can
// be made to read as another one). A tab becomes one space, because every width here counts one
// column for one character.
//
// The result is one line: a line break becomes a space, so that a name cannot put a line of its
// own on a screen. A text that is a block of lines by the tool's own making (a quote of several
// lines, a diagram) says so with `breaks`, and keeps the breaks between its lines.
export const CONTROL_MARK = '\ufffd';
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

export function visible(text, { breaks = false } = {}) {
  const lines = breaks ? String(text) : String(text).replace(/\r?\n/g, ' ');
  return lines.replace(/\t/g, ' ').replace(CONTROLS, CONTROL_MARK);
}

// Decoration glyphs that sentences from the string table carry. In the ASCII skin they are
// replaced; letters with diacritics stay, because they are content.
const ASCII_REPLACEMENTS = new Map([
  ['·', '-'], ['≈', '~'], ['…', '...'], ['→', '->'], ['≠', '!='], ['×', 'x'], ['−', '-'], ['–', '-'], ['—', '-'],
  ['„', '"'], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"], ['►', '>'], ['√', '+'], ['│', '|'], ['─', '-'],
  [CONTROL_MARK, '?'],
]);

export function asciiSafe(text) {
  return [...text].map((char) => ASCII_REPLACEMENTS.get(char) ?? char).join('');
}

// --- colour ---------------------------------------------------------------------------------------

const sgr = (on, codes) => (text) => (on && text !== '' ? `\u001b[${codes}m${text}\u001b[0m` : text);

// Sixteen ANSI colours only, so the person's theme decides the shades.
export function paint(colour) {
  return {
    bold: sgr(colour, '1'),
    dim: sgr(colour, '2'),
    red: sgr(colour, '31'),
    green: sgr(colour, '32'),
    yellow: sgr(colour, '33'),
    cyan: sgr(colour, '36'),
    boldCyan: sgr(colour, '1;36'),
    inverse: sgr(colour, '7'),
  };
}

// --- widths ---------------------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
export const strip = (text) => text.replace(ANSI, '');
export const widthOf = (text) => [...strip(text)].length;
export const padEnd = (text, width) => text + ' '.repeat(Math.max(0, width - widthOf(text)));
export const padStart = (text, width) => ' '.repeat(Math.max(0, width - widthOf(text))) + text;
export const between = (left, right, width = WIDTH) => left + ' '.repeat(Math.max(1, width - widthOf(left) - widthOf(right))) + right;

export function cut(text, max, glyphs = GLYPHS.unicode) {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - widthOf(glyphs.ell))).join('') + glyphs.ell;
}

// A path that does not fit keeps its first folder and its last names, the parts a person
// recognises; a trailing ":line" stays whole. Only when that is still too long is the head cut.
export function shortPath(label, max, glyphs = GLYPHS.unicode) {
  if (widthOf(label) <= max) return label;
  // The tail is looked for at the end of the label and nowhere else, so a label of any shape
  // (a line break in a name, no slash at all) has a body and, at most, a tail.
  const tail = /:[\d, +-]+$/.exec(label)?.[0] ?? '';
  const body = label.slice(0, label.length - tail.length);
  const parts = body.split('/');
  for (let keep = Math.min(3, parts.length - 2); keep >= 1; keep -= 1) {
    const candidate = `${parts[0]}/${glyphs.ell}/${parts.slice(-keep).join('/')}${tail}`;
    if (widthOf(candidate) <= max) return candidate;
  }
  const chars = [...label];
  const room = Math.max(0, max - widthOf(glyphs.ell));
  return glyphs.ell.slice(0, max) + chars.slice(chars.length - room).join('');
}

// Breaks between words; a single word longer than the width is cut into pieces of that width.
// A word has no bounded length (a name from a scanned file), so it is gone through once.
export function wrap(text, width) {
  const lines = [];
  let line = '';
  const push = (word) => {
    if (widthOf(word) <= width) return word;
    const chars = [...word];
    let at = 0;
    for (; chars.length - at > width; at += width) lines.push(chars.slice(at, at + width).join(''));
    return chars.slice(at).join('');
  };
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && widthOf(line) + 1 + widthOf(word) > width) {
      lines.push(line);
      line = push(word);
    } else if (!line) {
      line = push(word);
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function formatNumber(number, lang) {
  return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'sk' ? ' ' : ',');
}
