// The steps a skill describes, as a small graph, read from its text with no model.
// Nothing here interprets meaning. A step is an item of the main numbered list or a "Step N"
// heading; a branch is drawn only where the text starts with a branch word; a skill with no
// recognisable steps gives an empty flow. The graph becomes Mermaid text here and inline SVG in
// flow-svg.mjs.
//
// The graph: { nodes: [{ id, label, kind, line? }], edges: [{ from, to, label? }], source, capped? }
// Ids come from position ("s3" is the third step, "s3d1" the first branch among its nested items,
// "s3y" / "s3n" the box on the yes / no arrow), never from content.

import { parseFrontMatter } from './frontmatter.mjs';
import { MAX_LINE_CHARS, fenceMask, findSections, splitLines } from './markdown.mjs';

export const NODE_KINDS = ['start', 'step', 'decision', 'end', 'note'];
export const FLOW_SOURCES = ['list', 'headings', 'none'];

// No documented values; defaults of this tool.
export const FLOW_LIMITS = { maxNodes: 40, labelChars: 60, minSteps: 2 };

// The words drawn into a diagram. A caller passes its own to follow the language of a report;
// {count} in `more` is the number of nodes that were dropped.
export const FLOW_LABELS = { start: 'Start', end: 'End', yes: 'yes', no: 'no', more: '+{count} more' };

export const MERGE_REJECTIONS = [
  'missing-quote',
  'line-out-of-range',
  'quote-mismatch',
  'unknown-node',
  'not-a-step',
  'missing-text',
  'too-many-nodes',
];

// --- reading the text -----------------------------------------------------------------------------

const ITEM = /^[ \t]*(?:(\d{1,9})[.)]|[-*+])[ \t]+(.*)$/;
const HEADING = /^#{1,6}[ \t]/;
const STEP_HEADING = /^(?:step|krok)[ \t]+\d{1,3}(?!\w)[ \t]*[:.)–—-]?[ \t]*(.*)$/i;
const NUMBERED_HEADING = /^\d{1,3}[.)][ \t]+(.*)$/;

const BRANCH_WORD = /^(if|when|unless|ak|ke[dď])\s+/iu;
const OTHERWISE = /^(?:otherwise|else|inak)(?![\p{L}\p{N}_-])[,:]?\s*/iu;
const THEN = /^(?:then|tak|potom)\s+/iu;

// A sentence says to stop when the stop word stands alone ("Stop.", "stop and report") or closes
// the sentence ("... and stop."). "Stop the server" and "end each line with ..." do not.
const STOP_WORD = '(?:stop|end|finish|skon[cč]i|ukon[cč]i)';
const STOP_FIRST = new RegExp(`^${STOP_WORD}(?:\\s+(?:here|now|tu|teraz))?(?:[.!,;:]|$|\\s+(?:and|a|then|potom)\\s)`, 'iu');
const STOP_LAST = new RegExp(`(?:^|[\\s,;])(?:and|then|a|potom)\\s+${STOP_WORD}(?:\\s+(?:here|now|tu|teraz))?\\s*[.!]?$`, 'iu');

// "e.g. Monday" does not end a sentence.
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|napr|resp|tzv)$/i;

function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
}

function appendText(item, more) {
  if (item.text.length < MAX_LINE_CHARS) item.text = `${item.text} ${more}`.slice(0, MAX_LINE_CHARS);
}

// Every list item of the body with its parent item, and the numbered lists at the top level.
// A list runs across blank lines, code blocks and nested content. A heading, a paragraph or a
// bulleted list at the top level ends it, unless the numbering simply carries on afterwards.
function readLists(lines, mask, start) {
  const items = [];
  const lists = [];
  let open = [];
  let last = null;
  let lastNumbered = null;
  let interrupted = false;
  let blank = true;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (mask[index] || line.length > MAX_LINE_CHARS) {
      last = null;
      blank = false;
      continue;
    }
    if (line.trim() === '') {
      last = null;
      blank = true;
      continue;
    }
    const match = ITEM.exec(line);
    if (match) {
      const indent = indentOf(line);
      while (open.length && open[open.length - 1].indent >= indent) open.pop();
      const item = {
        line: index + 1,
        indent,
        parent: open[open.length - 1] ?? null,
        number: match[1] === undefined ? null : Number(match[1]),
        text: match[2].replace(/^\[[ xX]\][ \t]+/, '').trim(),
        children: [],
      };
      if (item.parent) item.parent.children.push(item);
      open.push(item);
      items.push(item);
      last = item;
      blank = false;
      if (item.parent || indent > 3) continue;
      if (item.number === null) {
        interrupted = true;
        continue;
      }
      if (!lastNumbered || (interrupted && item.number !== lastNumbered.number + 1)) lists.push([]);
      lists[lists.length - 1].push(item);
      lastNumbered = item;
      interrupted = false;
      continue;
    }
    if (HEADING.test(line) || (blank && indentOf(line) === 0)) {
      open = [];
      last = null;
      interrupted = true;
    } else if (last) {
      appendText(last, line.trim());
    }
    blank = false;
  }
  return { items, lists };
}

// The headings that number the steps of a skill, at the level that has the most of them.
function readHeadings(sections) {
  const byLevel = new Map();
  for (const section of sections) {
    const keyword = STEP_HEADING.exec(section.heading);
    const number = keyword ? null : NUMBERED_HEADING.exec(section.heading);
    if (!keyword && !number) continue;
    const title = (keyword ?? number)[1].trim();
    if (!byLevel.has(section.level)) byLevel.set(section.level, []);
    byLevel.get(section.level).push({ section, text: title === '' ? section.heading : title, keyword: Boolean(keyword) });
  }
  let best = [];
  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    if (byLevel.get(level).length > best.length) best = byLevel.get(level);
  }
  return best;
}

// --- reading one step ---------------------------------------------------------------------------

const maskCode = (text) => text.replace(/`[^`]*`/g, (span) => 'x'.repeat(span.length));

// Emphasis and links are dropped outside inline code; the code keeps its backticks for now, so a
// comma or a full stop inside it is not taken for the end of a condition or a sentence.
function stripEmphasis(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
            .replace(/(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, '$2'),
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentences(text) {
  const masked = maskCode(text);
  const out = [];
  let from = 0;
  for (const match of masked.matchAll(/[.!?]["')\]]*\s+(?=["'(\[]*\p{Lu})/gu)) {
    if (masked[match.index] === '.' && ABBREVIATION.test(masked.slice(from, match.index))) continue;
    const end = match.index + match[0].length;
    out.push(text.slice(from, end).trim());
    from = end;
  }
  out.push(text.slice(from).trim());
  return out.filter((sentence) => sentence !== '');
}

// Cut at the last space that fits, with an ellipsis; a single long word is cut where the room ends.
function shorten(text, max) {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, max).join('');
  const cut = head.lastIndexOf(' ');
  const kept = cut >= max / 2 ? head.slice(0, cut) : chars.slice(0, max - 1).join('');
  return `${kept.replace(/[\s,;:.–—-]+$/, '')}…`;
}

// A piece of a sentence as a label: no backticks, no closing punctuation, a capital letter when
// the piece was cut out of the middle of a sentence, and a question mark on a condition.
function toLabel(fragment, { capital = false, question = false } = {}) {
  let text = fragment
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(question ? /[.:;!?,]+$/ : /[.:;!]+$/, '');
  if (capital && !fragment.trimStart().startsWith('`')) text = text.charAt(0).toUpperCase() + text.slice(1);
  if (text === '') return '';
  return question ? `${shorten(text, FLOW_LIMITS.labelChars - 1)}?` : shorten(text, FLOW_LIMITS.labelChars);
}

// { condition, action, inverted } when the sentence begins with a branch word and states, after
// the first comma, what to do; null otherwise. "Unless X, do Y" does Y when X does not hold.
function branchOf(sentence) {
  const word = BRANCH_WORD.exec(sentence);
  if (!word) return null;
  const rest = sentence.slice(word[0].length);
  const comma = maskCode(rest).search(/,\s/);
  if (comma < 1) return null;
  const action = rest
    .slice(comma + 1)
    .trim()
    .replace(THEN, '');
  if (toLabel(action) === '') return null;
  return { condition: rest.slice(0, comma), action, inverted: word[1].toLowerCase() === 'unless' };
}

function otherwiseOf(sentence) {
  const word = OTHERWISE.exec(sentence);
  if (!word) return null;
  const action = sentence.slice(word[0].length);
  return toLabel(action) === '' ? null : action;
}

function saysStop(fragment) {
  const text = fragment.replace(/`([^`]*)`/g, '$1').trim();
  return STOP_FIRST.test(text) || STOP_LAST.test(text);
}

function describe(raw) {
  const [first = '', second = ''] = sentences(stripEmphasis(raw));
  const branch = branchOf(first);
  return {
    first,
    branch,
    // What this text says as the other branch of the item before it, and of its own first sentence.
    answers: otherwiseOf(first),
    otherwise: branch ? otherwiseOf(second) : null,
  };
}

// --- building the graph -------------------------------------------------------------------------

function decision(id, line, branch, other, labels) {
  const [actionKey, otherKey] = branch.inverted ? ['n', 'y'] : ['y', 'n'];
  const [actionLabel, otherLabel] = branch.inverted ? [labels.no, labels.yes] : [labels.yes, labels.no];
  const box = (key, text, at) => ({
    node: { id: `${id}${key}`, label: toLabel(text, { capital: true }), kind: 'step', line: at },
    stops: saysStop(text),
  });
  return {
    node: { id, label: toLabel(branch.condition, { capital: true, question: true }), kind: 'decision', line },
    branches: [
      { label: actionLabel, ...box(actionKey, branch.action, line) },
      { label: otherLabel, ...(other ? box(otherKey, other.text, other.line) : { node: null }) },
    ],
  };
}

// steps: [{ line, text, children: [{ line, text }] }] in the order of the text.
function buildFlow(steps, source, labels) {
  const read = steps.map((step) => ({ ...step, ...describe(step.text) }));
  const stations = [];
  for (let index = 0; index < read.length; index += 1) {
    const step = read[index];
    const id = `s${index + 1}`;
    const children = step.children.map((child) => ({ line: child.line, ...describe(child.text) }));
    let from = 0;
    if (step.branch) {
      let other = step.otherwise ? { text: step.otherwise, line: step.line } : null;
      if (!other && children[0]?.answers) {
        other = { text: children[0].answers, line: children[0].line };
        from = 1;
      }
      const next = read[index + 1];
      if (!other && next?.answers) {
        other = { text: next.answers, line: next.line };
        index += 1;
      }
      stations.push(decision(id, step.line, step.branch, other, labels));
    } else {
      const label = toLabel(step.first);
      stations.push({ node: { id, label: label === '' ? String(index + 1) : label, kind: 'step', line: step.line }, stops: saysStop(step.first) });
    }
    let count = 0;
    for (let position = from; position < children.length; position += 1) {
      const child = children[position];
      if (!child.branch) continue;
      count += 1;
      let other = child.otherwise ? { text: child.otherwise, line: child.line } : null;
      const next = children[position + 1];
      if (!other && next?.answers) {
        other = { text: next.answers, line: next.line };
        position += 1;
      }
      stations.push(decision(`${id}d${count}`, child.line, child.branch, other, labels));
    }
  }

  const nodes = [{ id: 'start', label: labels.start, kind: 'start' }];
  const edges = [{ from: 'start', to: stations[0].node.id }];
  stations.forEach((station, index) => {
    const next = stations[index + 1]?.node.id ?? 'end';
    nodes.push(station.node);
    if (!station.branches) {
      edges.push({ from: station.node.id, to: next });
      if (station.stops && next !== 'end') edges.push({ from: station.node.id, to: 'end' });
      return;
    }
    for (const branch of station.branches) {
      if (!branch.node) {
        edges.push({ from: station.node.id, to: next, label: branch.label });
        continue;
      }
      nodes.push(branch.node);
      edges.push({ from: station.node.id, to: branch.node.id, label: branch.label });
      edges.push({ from: branch.node.id, to: branch.stops ? 'end' : next });
    }
  });
  nodes.push({ id: 'end', label: labels.end, kind: 'end' });
  return capFlow({ nodes, edges, source }, labels);
}

// Over the cap, the first nodes are kept and one note stands for the rest. An edge that led into
// a dropped node leads to the note instead, once per source and without its label.
function capFlow(flow, labels) {
  const max = FLOW_LIMITS.maxNodes;
  if (flow.nodes.length <= max) return flow;
  const nodes = flow.nodes.slice(0, max - 1);
  const dropped = flow.nodes.length - nodes.length;
  const kept = new Set(nodes.map((node) => node.id));
  const toNote = new Set();
  const edges = [];
  for (const edge of flow.edges) {
    if (!kept.has(edge.from)) continue;
    if (kept.has(edge.to)) edges.push(edge);
    else if (!toNote.has(edge.from)) {
      toNote.add(edge.from);
      edges.push({ from: edge.from, to: 'more' });
    }
  }
  nodes.push({ id: 'more', label: labels.more.replace('{count}', String(dropped)), kind: 'note' });
  return { nodes, edges, source: flow.source, capped: dropped };
}

// The flow of a skill. Steps come from the main procedure: the longest numbered list at the top
// level, or the "Step N" / "Krok N" / "N." headings when the skill is organised by headings.
export function extractFlow(skillText, options = {}) {
  const labels = { ...FLOW_LABELS, ...options.labels };
  const lines = splitLines(skillText);
  const mask = fenceMask(lines);
  const front = parseFrontMatter(skillText);
  const start = front.present ? front.endLine : 0;

  const { items, lists } = readLists(lines, mask, start);
  const list = lists.reduce((best, candidate) => (candidate.length > best.length ? candidate : best), []);
  const headings = readHeadings(findSections(lines, mask).filter((section) => section.line > start));

  // Headings that say "Step" are the procedure. Bare numbers may only number the sections of a
  // document, so they count only when no list is longer.
  const byHeadings = headings.length >= FLOW_LIMITS.minSteps && (headings.some((entry) => entry.keyword) || headings.length >= list.length);
  if (byHeadings) {
    // The list items of a section stand where the nested items of a numbered step would.
    const top = items.filter((item) => !item.parent);
    let cursor = 0;
    const steps = headings.map(({ section, text }) => {
      while (cursor < top.length && top[cursor].line <= section.line) cursor += 1;
      const children = [];
      for (; cursor < top.length && top[cursor].line < section.line + section.lines; cursor += 1) children.push(top[cursor]);
      return { line: section.line, text, children };
    });
    return buildFlow(steps, 'headings', labels);
  }
  if (list.length >= FLOW_LIMITS.minSteps) return buildFlow(list, 'list', labels);
  return { nodes: [], edges: [], source: 'none' };
}

// --- branches read in prose ---------------------------------------------------------------------

const REJECTION_MESSAGES = {
  'missing-quote': 'The branch carries no quote. No quote, no claim.',
  'line-out-of-range': 'The line of the quote is not a line of the skill.',
  'quote-mismatch': 'The quote is not the exact text of the skill at that line. Read the line again; no quote, no claim.',
  'unknown-node': 'The flow has no node with the id given in "at".',
  'not-a-step': 'A branch can be added after a step only, not after a decision, a note, the start or the end.',
  'missing-text': 'The branch needs a question and what happens on "yes".',
  'too-many-nodes': 'The flow is at its cap on nodes and takes no more.',
};

function rejection(item, flow, lines) {
  if (typeof item?.quote !== 'string' || item.quote === '') return 'missing-quote';
  const [line, endLine] = [item.line, item.endLine ?? item.line];
  if (!Number.isInteger(line) || !Number.isInteger(endLine) || line < 1 || endLine < line || endLine > lines.length) return 'line-out-of-range';
  if (item.quote !== lines.slice(line - 1, endLine).join('\n')) return 'quote-mismatch';
  const node = flow.nodes.find((entry) => entry.id === item.at);
  if (!node) return 'unknown-node';
  if (node.kind !== 'step') return 'not-a-step';
  if ([item.question, item.yes].some((text) => typeof text !== 'string' || toLabel(stripEmphasis(text)) === '')) return 'missing-text';
  const added = typeof item.no === 'string' && item.no.trim() !== '' ? 3 : 2;
  if (flow.nodes.length + added > FLOW_LIMITS.maxNodes) return 'too-many-nodes';
  return null;
}

// Adds the branches a reader found in prose. Each overlay item is
// { at, question, yes, no?, quote, line, endLine? }: after the step `at` comes the question, "yes"
// leads to one box, "no" to another or straight on, and both rejoin where the step led before.
// An item is accepted only when `quote` is the exact text of the skill at `line` (to `endLine`).
// Returns { flow, accepted: [{ index, at, decision, line }], rejected: [{ index, item, reason, message }] };
// the flow passed in is not changed.
export function mergeBranches(flow, overlay, skillText, options = {}) {
  const labels = { ...FLOW_LABELS, ...options.labels };
  const lines = splitLines(skillText);
  const result = { ...flow, nodes: flow.nodes.map((node) => ({ ...node })), edges: flow.edges.map((edge) => ({ ...edge })) };
  const accepted = [];
  const rejected = [];
  const hasEnd = result.nodes.some((node) => node.id === 'end');

  overlay.forEach((item, index) => {
    const reason = rejection(item, result, lines);
    if (reason) {
      rejected.push({ index, item, reason, message: REJECTION_MESSAGES[reason] });
      return;
    }
    const taken = new Set(result.nodes.map((node) => node.id));
    let number = 1;
    while (taken.has(`${item.at}q${number}`)) number += 1;
    const id = `${item.at}q${number}`;
    const box = (key, text) => ({
      node: { id: `${id}${key}`, label: toLabel(stripEmphasis(text)), kind: 'step', line: item.line },
      stops: hasEnd && saysStop(stripEmphasis(text)),
    });
    const question = { id, label: toLabel(stripEmphasis(item.question), { question: true }), kind: 'decision', line: item.line };
    const yes = box('y', item.yes);
    const no = typeof item.no === 'string' && item.no.trim() !== '' ? box('n', item.no) : null;

    const first = result.edges.findIndex((edge) => edge.from === item.at);
    const targets = result.edges.filter((edge) => edge.from === item.at).map((edge) => edge.to);
    const onward = (branch) => (branch.stops ? ['end'] : targets).map((to) => ({ from: branch.node.id, to }));
    const added = [
      { from: item.at, to: id },
      { from: id, to: yes.node.id, label: labels.yes },
      ...onward(yes),
      ...(no ? [{ from: id, to: no.node.id, label: labels.no }, ...onward(no)] : targets.map((to) => ({ from: id, to, label: labels.no }))),
    ];
    result.edges = result.edges.filter((edge) => edge.from !== item.at);
    result.edges.splice(first === -1 ? result.edges.length : first, 0, ...added);
    const position = result.nodes.findIndex((node) => node.id === item.at);
    result.nodes.splice(position + 1, 0, question, yes.node, ...(no ? [no.node] : []));
    accepted.push({ index, at: item.at, decision: id, line: item.line });
  });
  return { flow: result, accepted, rejected };
}

// --- Mermaid ------------------------------------------------------------------------------------

// Refuses a graph that cannot be drawn: an id used twice, an unknown kind, an edge into nothing.
export function assertGraph(graph) {
  const ids = new Set();
  for (const node of graph.nodes) {
    if (typeof node.id !== 'string' || node.id === '') throw new Error('A node of the graph has no id');
    if (ids.has(node.id)) throw new Error(`The graph has two nodes with the id "${node.id}"`);
    if (!NODE_KINDS.includes(node.kind)) {
      throw new Error(`Node "${node.id}" has the unknown kind "${node.kind}"; use one of: ${NODE_KINDS.join(', ')}`);
    }
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    for (const end of [edge.from, edge.to]) {
      if (!ids.has(end)) throw new Error(`An edge names the node "${end}", which the graph does not have`);
    }
  }
}

const MERMAID_SHAPES = {
  start: ['([', '])'],
  end: ['([', '])'],
  step: ['[', ']'],
  decision: ['{', '}'],
  note: ['(', ')'],
};

// Letters, digits, spaces and a few plain marks stay as they are. Every other character is
// written as a numeric entity (#34; for a quote), which Mermaid shows as the character and never
// reads as syntax, so a label can neither close its node nor start a statement or a directive.
function mermaidText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^\p{L}\p{M}\p{N} .,:!?'_+=/…-]/gu, (char) => `#${char.codePointAt(0)};`);
}

// "flowchart TD" text for a graph. Node names are n1, n2, ... by position, so no id of the graph
// can collide with a Mermaid keyword, and the same graph always gives the same text.
export function toMermaid(graph) {
  assertGraph(graph);
  if (graph.nodes.length === 0) return '';
  const names = new Map(graph.nodes.map((node, index) => [node.id, `n${index + 1}`]));
  const lines = ['flowchart TD'];
  for (const node of graph.nodes) {
    const [open, close] = MERMAID_SHAPES[node.kind];
    lines.push(`  ${names.get(node.id)}${open}"${mermaidText(node.label)}"${close}`);
  }
  for (const edge of graph.edges) {
    const label = edge.label ? `|"${mermaidText(edge.label)}"|` : '';
    lines.push(`  ${names.get(edge.from)} -->${label} ${names.get(edge.to)}`);
  }
  return lines.join('\n');
}
