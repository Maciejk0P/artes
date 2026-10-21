// Line-level helpers for memory files. Nothing here interprets meaning; it only finds structure.

export function splitLines(text) {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// true for every line that is a code fence delimiter or sits inside a fenced block.
export function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = null;
  lines.forEach((line, index) => {
    if (open) {
      mask[index] = true;
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === open[0] && close[1].length >= open.length) open = null;
      return;
    }
    const start = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (start) {
      open = start[1];
      mask[index] = true;
    }
  });
  return mask;
}

// true for every line of a block-level HTML comment. Claude Code strips those before a memory
// file is injected, so their lines are no instructions and cost no context. Only what is a
// comment beyond doubt counts: it opens at the start of a line (after at most three spaces) and
// the line it closes on holds nothing after the closing mark. A comment inside a line, one inside
// a code block and one that never closes are left as text.
export function commentMask(lines, fences = fenceMask(lines)) {
  const mask = new Array(lines.length).fill(false);
  // For every line, the first line at or after it that holds a closing mark: found once, from the
  // end, so a file of nothing but opening marks is still read in one pass.
  const closes = new Array(lines.length + 1).fill(-1);
  for (let index = lines.length - 1; index >= 0; index -= 1) closes[index] = lines[index].includes('-->') ? index : closes[index + 1];
  for (let index = 0; index < lines.length; index += 1) {
    if (fences[index] || !/^\s{0,3}<!--/.test(lines[index])) continue;
    // The opening line may close the comment itself; there the search starts after "<!--".
    const from = lines[index].indexOf('<!--') + 4;
    const end = lines[index].includes('-->', from) ? index : closes[index + 1];
    if (end === -1) continue;
    const tail = lines[end].slice(lines[end].indexOf('-->', end === index ? from : 0) + 3);
    if (tail.trim() !== '') continue;
    mask.fill(true, index, end + 1);
    index = end;
  }
  return mask;
}

// How much of a text is block-level comment: its lines, and their bytes with their line endings.
export function commentSize(text) {
  const lines = splitLines(text);
  const mask = commentMask(lines);
  let bytes = 0;
  let index = 0;
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/y;
  while (pattern.lastIndex < text.length) {
    const match = pattern.exec(text);
    if (mask[index]) bytes += Buffer.byteLength(match[0]);
    index += 1;
  }
  return { lines: mask.filter(Boolean).length, bytes };
}

// A longer line is never parsed as structure (heading, import, instruction). No real instruction
// is that long, and it bounds the work a single hostile line can cause.
export const MAX_LINE_CHARS = 2000;

// The text of a heading without its optional closing run of # characters ("## Title ##").
// Done without a regular expression on purpose: a pattern for this backtracks on runs of spaces.
function headingText(rest) {
  const text = rest.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  const closes = end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t');
  return (closes ? text.slice(0, end) : text).trim();
}

// Each heading with the number of lines it owns: up to the next heading of the same or a higher level.
export function findSections(lines, mask = fenceMask(lines)) {
  const headings = [];
  lines.forEach((line, index) => {
    if (mask[index] || line.length > MAX_LINE_CHARS) return;
    const match = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (match) headings.push({ heading: headingText(match[2]), level: match[1].length, line: index + 1 });
  });
  return headings.map((heading, position) => {
    const next = headings.slice(position + 1).find((other) => other.level <= heading.level);
    const end = next ? next.line - 1 : lines.length;
    return { ...heading, lines: end - heading.line + 1 };
  });
}

function blankInlineCode(line) {
  return line.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
}

// @path imports. A token counts as a path when it starts like one (~/ ./ ../ / or a drive) or ends
// in a file extension; any other @word is kept as `bare` and is an import only if that file exists.
// Format: https://code.claude.com/docs/en/memory.md ("@path syntax imports files into CLAUDE.md").
export function findImports(lines, mask = fenceMask(lines)) {
  const imports = [];
  lines.forEach((line, index) => {
    if (mask[index] || line.length > MAX_LINE_CHARS) return;
    const visible = blankInlineCode(line);
    for (const match of visible.matchAll(/(?:^|[\s(])@((?:\\ |[^\s\\])+)/g)) {
      // A quoted path is not imported (memory page): @"docs/x.md" is text.
      if (/^["']/.test(match[1])) continue;
      const raw = match[1].replace(/\\ /g, ' ').replace(/[.,;:!?)\]'"]+$/, '');
      if (!raw) continue;
      const pathLike = /^(~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(raw) || /\.[A-Za-z0-9]{1,8}$/.test(raw);
      imports.push({ raw, line: index + 1, bare: !pathLike });
    }
  });
  return imports;
}

export function stripListMarker(line) {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '');
}

// The same instruction written with a different list marker, case, emphasis or spacing normalises equal.
export function normaliseInstruction(line) {
  return stripListMarker(line)
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;:!]+$/, '')
    .toLowerCase();
}

// Lines that can carry an instruction: not blank, not a heading, not a table row or rule, not code.
export function instructionLines(lines, mask = fenceMask(lines)) {
  const out = [];
  lines.forEach((text, index) => {
    if (mask[index] || text.length > MAX_LINE_CHARS) return;
    const trimmed = text.trim();
    if (trimmed === '' || /^#{1,6}\s/.test(trimmed) || trimmed.startsWith('|')) return;
    if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ''))) return;
    const norm = normaliseInstruction(text);
    if (norm === '') return;
    out.push({ line: index + 1, text, norm, indent: text.length - text.trimStart().length });
  });
  return out;
}
