import { splitLines } from './markdown.mjs';

// A small reader for the YAML front matter of skills, commands, agents and rule files.
// It covers what those files use: scalars, quoted strings, block scalars (> and |), lists and
// nested maps. It is not a YAML parser; anything else is reported as invalid rather than guessed.

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isIgnorable(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  // A trailing comment starts at the first "#" that follows white space. Found with a pattern
  // that has no repetition: a description can be long, and it is not capped here.
  const comment = value.search(/\s#/);
  const bare = comment === -1 ? value : value.slice(0, comment).trimEnd();
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  if (bare === 'null' || bare === '~' || bare === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(bare)) return Number(bare);
  return bare;
}

function parseInlineList(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  const items = [];
  let current = '';
  let quote = null;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ',') {
      items.push(parseScalar(current));
      current = '';
    } else {
      current += char;
    }
  }
  items.push(parseScalar(current));
  return items;
}

function parseBlockScalar(lines, folded) {
  const indents = lines.filter((line) => line.trim() !== '').map(indentOf);
  const strip = indents.length ? Math.min(...indents) : 0;
  const text = lines.map((line) => line.slice(strip));
  while (text.length && text[text.length - 1].trim() === '') text.pop();
  if (!folded) return text.join('\n');
  return text
    .join('\n')
    .replace(/([^\n])\n(?!\n)/g, '$1 ')
    .replace(/\n+/g, '\n')
    .trim();
}

function parseList(lines) {
  const items = [];
  for (const line of lines) {
    if (isIgnorable(line)) continue;
    const match = /^\s*-\s*(.*)$/.exec(line);
    if (match) items.push(parseScalar(match[1]));
    else if (items.length && typeof items[items.length - 1] === 'string') {
      items[items.length - 1] += ` ${line.trim()}`;
    } else throw new Error(`unexpected line in a list: "${line.trim()}"`);
  }
  return items;
}

function parseMap(lines) {
  const data = {};
  const first = lines.find((line) => !isIgnorable(line));
  if (first === undefined) return data;
  const base = indentOf(first);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isIgnorable(line)) {
      index += 1;
      continue;
    }
    if (indentOf(line) !== base) throw new Error(`unexpected indentation: "${line.trim()}"`);
    const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line.trim());
    if (!match) throw new Error(`expected "key: value", got "${line.trim()}"`);
    const key = match[1];
    const rest = (match[2] ?? '').trim();
    index += 1;

    const child = [];
    while (index < lines.length) {
      const next = lines[index];
      const deeper = next.trim() === '' || indentOf(next) > base;
      const listAtSameLevel = rest === '' && indentOf(next) === base && /^\s*-(\s|$)/.test(next);
      if (!deeper && !listAtSameLevel) break;
      child.push(next);
      index += 1;
    }
    while (child.length && child[child.length - 1].trim() === '') child.pop();

    if (/^[>|][+-]?$/.test(rest)) {
      data[key] = parseBlockScalar(child, rest.startsWith('>'));
    } else if (rest === '') {
      const firstChild = child.find((entry) => !isIgnorable(entry));
      if (firstChild === undefined) data[key] = null;
      else if (/^\s*-(\s|$)/.test(firstChild)) data[key] = parseList(child);
      else data[key] = parseMap(child);
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = parseInlineList(rest);
    } else {
      const value = parseScalar(rest);
      const continuation = child.filter((entry) => entry.trim() !== '').map((entry) => entry.trim());
      data[key] = typeof value === 'string' && continuation.length ? [value, ...continuation].join(' ') : value;
    }
  }
  return data;
}

// { present, valid, error, data, endLine } — endLine is the 1-based line of the closing marker.
export function parseFrontMatter(text) {
  const lines = splitLines(text);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { present: false, valid: true, error: null, data: {}, endLine: 0 };
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close === -1) {
    return { present: true, valid: false, error: 'front matter is not closed with ---', data: {}, endLine: 0 };
  }
  try {
    return { present: true, valid: true, error: null, data: parseMap(lines.slice(1, close)), endLine: close + 1 };
  } catch (error) {
    return { present: true, valid: false, error: error.message, data: {}, endLine: close + 1 };
  }
}
