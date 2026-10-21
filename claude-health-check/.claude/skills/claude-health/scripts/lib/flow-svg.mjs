// A graph from flow.mjs as one inline <svg>: own layout, no library, no script, no external
// reference, so a report that embeds it stays a single offline file.
//
// Layout, top to bottom. A node sits in the row of its rank (the longest path that leads to it);
// inside a row the nodes keep the order they were given in, and each row is centred. Edges between
// neighbouring rows are drawn through the gap between them; an edge that skips rows runs down a
// lane outside every box. A decision that has its row to itself keeps its branch boxes beside it,
// the first to the right and the second to the left, which puts the steps of a flow on one spine.
//
// Colours are CSS custom properties with fallbacks, and currentColor for text, so the diagram
// follows the theme of the page around it: --surface (box fill), --line (start and end fill),
// --muted (outlines and arrows), --accent (decisions), --ink-2 (edge labels and notes).
//
// Text is measured by character count: nothing here can ask a browser how wide a glyph is.

import { assertGraph } from './flow.mjs';

const FONT_SIZE = 13;
const CHAR_WIDTH = 7.4;
const LINE_HEIGHT = 17;
const BASELINE = 12.5;
const MAX_LINES = 3;
const BOX_UNITS = 24;
const DECISION_UNITS = 18;
const EDGE_LABEL_UNITS = 28;
const EDGE_FONT_SIZE = 11;
const EDGE_CHAR_WIDTH = 6.3;
const MAX_LABEL_CHARS = 400;

const PAD_X = 12;
const PAD_Y = 10;
const MIN_BOX = 120;
const MIN_DIAMOND = 120;
const PILL_HEIGHT = 30;
const PILL_PAD_X = 16;
const MIN_PILL = 72;

const COLUMN_GAP = 28;
const ROW_GAP = 46;
const SIDE_GAP = 56;
const LANE_GAP = 16;
const LANE_PITCH = 10;
const LANE_STEP = 6;
const MARGIN = 12;
const ARROW = 8;
const ARROW_HALF = 4;
const CORNER = 6;
const UPRIGHT = 96;

const PAINT = {
  outline: 'var(--muted, #888)',
  box: 'var(--surface, none)',
  pill: 'var(--line, none)',
  decision: 'var(--accent, #2a78d6)',
  quiet: 'var(--ink-2, currentColor)',
};

export const SVG_METRICS = {
  fontSize: FONT_SIZE,
  charWidth: CHAR_WIDTH,
  lineHeight: LINE_HEIGHT,
  maxLines: MAX_LINES,
  boxUnits: BOX_UNITS,
  decisionUnits: DECISION_UNITS,
  edgeFontSize: EDGE_FONT_SIZE,
  edgeCharWidth: EDGE_CHAR_WIDTH,
  edgeLabelUnits: EDGE_LABEL_UNITS,
};

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// One line of plain text: control characters cannot be written into a page, and a label is short.
function clean(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...text].slice(0, MAX_LABEL_CHARS).join('');
}

// --- text ---------------------------------------------------------------------------------------

// How much room a character takes, in units of the character width: capitals and the widest small
// letters a little more than one, anything from the wide scripts and the symbol blocks two.
function charUnits(char) {
  if (char.codePointAt(0) >= 0x1100) return 2;
  if (char !== char.toLowerCase() || 'mw@%'.includes(char)) return 1.3;
  return 1;
}

export function textUnits(text) {
  let units = 0;
  for (const char of text) units += charUnits(char);
  return units;
}

// The longest start of the text that fits into the units.
function fit(text, units) {
  let out = '';
  let used = 0;
  for (const char of text) {
    used += charUnits(char);
    if (used > units) break;
    out += char;
  }
  return out;
}

const cutTo = (text, units) => `${fit(text, units - textUnits('…')).trimEnd()}…`;

// Lines of at most unitsPerLine. A line breaks at a space; a word longer than a line is cut where
// the line is full; what does not fit into maxLines is dropped and the last line ends in "…".
function wrapLabel(label, unitsPerLine, maxLines = MAX_LINES) {
  const lines = [''];
  let cutWord = false;
  for (const word of clean(label).split(' ')) {
    const last = lines[lines.length - 1];
    const joined = last === '' ? word : `${last} ${word}`;
    if (textUnits(joined) <= unitsPerLine) {
      lines[lines.length - 1] = joined;
      continue;
    }
    if (last !== '') lines.push('');
    let rest = word;
    while (textUnits(rest) > unitsPerLine) {
      const head = fit(rest, unitsPerLine);
      lines[lines.length - 1] = head;
      lines.push('');
      rest = rest.slice(head.length);
      cutWord = true;
    }
    lines[lines.length - 1] = rest;
  }
  if (lines.length > maxLines) return [...lines.slice(0, maxLines - 1), cutTo(lines[maxLines - 1], unitsPerLine)];
  // One word alone on the last line reads as a leftover ("238" / "lines"): the word before it
  // comes down to join it. Not when a word was cut, where the pieces have to stay where they are.
  const end = lines.length - 1;
  if (cutWord || end < 1 || lines[end].includes(' ')) return lines;
  const space = lines[end - 1].lastIndexOf(' ');
  if (space === -1) return lines;
  const together = `${lines[end - 1].slice(space + 1)} ${lines[end]}`;
  if (textUnits(together) > unitsPerLine) return lines;
  return [...lines.slice(0, end - 1), lines[end - 1].slice(0, space), together];
}

const edgeLabel = (edge) => {
  const text = edge.label ? clean(edge.label) : '';
  return textUnits(text) <= EDGE_LABEL_UNITS ? text : cutTo(text, EDGE_LABEL_UNITS);
};
const edgeLabelWidth = (text) => Math.ceil(textUnits(text) * EDGE_CHAR_WIDTH);

// --- sizes ----------------------------------------------------------------------------------------

const widthOf = (lines) => Math.ceil(Math.max(...lines.map(textUnits)) * CHAR_WIDTH);
const isBox = (node) => node.kind === 'step' || node.kind === 'note';

// The size of a node and the room its text has. The text of a diamond stays inside the rectangle
// inscribed in it: textWidth / width + textHeight / height is 1.
function measure(node) {
  const shape = { id: node.id, kind: node.kind, x: 0, y: 0 };
  if (node.kind === 'decision') {
    const lines = wrapLabel(node.label, DECISION_UNITS);
    const textHeight = lines.length * LINE_HEIGHT;
    const height = 2 * textHeight + 22;
    const room = 1 - textHeight / height;
    const width = Math.max(MIN_DIAMOND, Math.ceil((widthOf(lines) + 8) / room));
    return { ...shape, lines, width, height, textWidth: width * room, textHeight };
  }
  if (!isBox(node)) {
    const lines = wrapLabel(node.label, BOX_UNITS, 1);
    const width = Math.max(MIN_PILL, widthOf(lines) + 2 * PILL_PAD_X);
    return { ...shape, lines, width, height: PILL_HEIGHT, textWidth: width - 2 * PILL_PAD_X, textHeight: PILL_HEIGHT - 12 };
  }
  const lines = wrapLabel(node.label, BOX_UNITS);
  const textHeight = lines.length * LINE_HEIGHT;
  return { ...shape, lines, width: widthOf(lines) + 2 * PAD_X, height: textHeight + 2 * PAD_Y, textWidth: widthOf(lines), textHeight };
}

// --- rows ---------------------------------------------------------------------------------------

// The branch boxes of the decisions: a step reached by one labelled arrow from a decision that
// leads nowhere else than back to a node other arrows reach as well (the join). A step whose
// arrow is the only way onward is the next step of the flow, not a branch box.
// The first branch box of a decision goes right, the second left.
function sideNodes(graph) {
  const kindOf = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const incoming = new Map();
  const targets = new Map();
  for (const edge of graph.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    targets.set(edge.from, [...(targets.get(edge.from) ?? []), edge.to]);
  }
  const sides = new Map();
  const free = new Map();
  for (const edge of graph.edges) {
    if (kindOf.get(edge.from) !== 'decision' || !edge.label) continue;
    if (kindOf.get(edge.to) !== 'step' || incoming.get(edge.to) !== 1) continue;
    const onward = targets.get(edge.to) ?? [];
    if (onward.length > 1 || (onward.length === 1 && incoming.get(onward[0]) < 2)) continue;
    const flanks = free.get(edge.from) ?? ['right', 'left'];
    if (flanks.length === 0) continue;
    sides.set(edge.to, { decision: edge.from, flank: flanks[0] });
    free.set(edge.from, flanks.slice(1));
  }
  return sides;
}

// The rank of every node that is not a branch box: the longest path that leads to it. A branch
// box counts as part of its decision, so what follows it is ranked after the decision.
function rankNodes(graph, sides) {
  const core = graph.nodes.filter((node) => !sides.has(node.id));
  const rank = new Map(core.map((node) => [node.id, 0]));
  const waiting = new Map(core.map((node) => [node.id, 0]));
  const next = new Map(core.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    if (sides.has(edge.to)) continue;
    waiting.set(edge.to, waiting.get(edge.to) + 1);
    next.get(sides.get(edge.from)?.decision ?? edge.from).push(edge.to);
  }
  const queue = core.filter((node) => waiting.get(node.id) === 0).map((node) => node.id);
  for (let index = 0; index < queue.length; index += 1) {
    for (const to of next.get(queue[index])) {
      rank.set(to, Math.max(rank.get(to), rank.get(queue[index]) + 1));
      waiting.set(to, waiting.get(to) - 1);
      if (waiting.get(to) === 0) queue.push(to);
    }
  }
  if (queue.length < core.length) throw new Error('The graph has a cycle; a layered diagram needs edges that only lead forward');
  return rank;
}

function rowsOf(graph, rank) {
  const rows = [];
  for (const node of graph.nodes) {
    if (!rank.has(node.id)) continue;
    const index = rank.get(node.id);
    if (!rows[index]) rows[index] = { ids: [], y: 0, height: 0 };
    rows[index].ids.push(node.id);
  }
  return rows;
}

// Branch boxes stay beside their decision only when every such decision has its row to itself;
// a graph where that does not hold is drawn in plain layers.
function arrange(graph) {
  const sides = sideNodes(graph);
  const rank = rankNodes(graph, sides);
  const rows = rowsOf(graph, rank);
  if (![...sides.values()].some((side) => rows[rank.get(side.decision)].ids.length > 1)) return { sides, rank, rows };
  const plain = rankNodes(graph, new Map());
  return { sides: new Map(), rank: plain, rows: rowsOf(graph, plain) };
}

// --- lines --------------------------------------------------------------------------------------

const fixed = (number) => String(Math.round(number * 10) / 10);
const at = ([x, y]) => `${fixed(x)} ${fixed(y)}`;

// A line through the points with its corners rounded.
function roundedPath(points) {
  let d = `M${at(points[0])}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const corner = points[index];
    const toward = (other) => {
      const length = Math.hypot(other[0] - corner[0], other[1] - corner[1]);
      const reach = Math.min(CORNER, length / 2) / (length || 1);
      return [corner[0] + (other[0] - corner[0]) * reach, corner[1] + (other[1] - corner[1]) * reach];
    };
    d += `L${at(toward(points[index - 1]))}Q${at(corner)} ${at(toward(points[index + 1]))}`;
  }
  return `${d}L${at(points[points.length - 1])}`;
}

// The drawn line of an edge. It stops where its arrow head begins.
function pathOf(route, points) {
  const [start, end] = [points[0], points[points.length - 1]];
  if (route === 'side') return `M${at(start)}L${at([end[0] + (end[0] > start[0] ? -ARROW : ARROW), end[1]])}`;
  const tip = [end[0], end[1] - ARROW];
  if (route === 'lane') return roundedPath([...points.slice(0, -1), tip]);
  if (Math.abs(start[0] - end[0]) < 0.5) return `M${at(start)}L${at(tip)}`;
  // A curve across the gap between the two rows, upright at both ends.
  const [gapTop, gapBottom] = [points[1][1], points[2][1]];
  const middle = (gapTop + gapBottom) / 2;
  const curveEnd = Math.min(gapBottom, tip[1]);
  return (
    `M${at(start)}${start[1] < gapTop ? `L${at(points[1])}` : ''}` +
    `C${at([start[0], middle])} ${at([end[0], middle])} ${at([end[0], curveEnd])}${tip[1] > curveEnd ? `L${at(tip)}` : ''}`
  );
}

function arrowHead([x, y], direction) {
  const [dx, dy] = { down: [0, 1], right: [1, 0], left: [-1, 0] }[direction];
  const base = [x - dx * ARROW, y - dy * ARROW];
  return `M${at([x, y])}L${at([base[0] - dy * ARROW_HALF, base[1] - dx * ARROW_HALF])}L${at([base[0] + dy * ARROW_HALF, base[1] + dx * ARROW_HALF])}Z`;
}

// --- layout -------------------------------------------------------------------------------------

// Where everything goes: { width, height, nodes: [{ id, kind, x, y, width, height, lines,
// textWidth, textHeight }], edges: [{ from, to, label, route, points, direction, labelAt, d }] }.
// `points` runs from the border of the source node to the border of the target node. `route` is
// "side" (a decision to its branch box), "direct" (to the next row) or "lane" (around the boxes).
export function layoutGraph(graph) {
  assertGraph(graph);
  if (graph.nodes.length === 0) return { width: 0, height: 0, nodes: [], edges: [] };

  const boxes = new Map(graph.nodes.map((node) => [node.id, measure(node)]));
  const boxWidth = Math.max(MIN_BOX, ...[...boxes.values()].filter(isBox).map((box) => box.width));
  for (const box of boxes.values()) {
    if (!isBox(box)) continue;
    box.width = boxWidth;
    box.textWidth = boxWidth - 2 * PAD_X;
  }
  const { sides, rank, rows } = arrange(graph);
  const rankOf = (id) => rank.get(sides.get(id)?.decision ?? id);
  const rowOf = (id) => rows[rankOf(id)];
  const isSideEdge = (edge) => sides.get(edge.to)?.decision === edge.from;

  // Across: each row centred on x = 0, then the branch boxes in one column on either side.
  let half = 0;
  for (const row of rows) {
    const total = row.ids.reduce((sum, id) => sum + boxes.get(id).width, 0) + COLUMN_GAP * (row.ids.length - 1);
    let x = -total / 2;
    for (const id of row.ids) {
      boxes.get(id).x = x;
      x += boxes.get(id).width + COLUMN_GAP;
    }
    half = Math.max(half, total / 2);
  }
  const sideGap = Math.max(SIDE_GAP, ...graph.edges.filter(isSideEdge).map((edge) => edgeLabelWidth(edgeLabel(edge)) + ARROW + 16));
  for (const [id, side] of sides) {
    const box = boxes.get(id);
    box.x = side.flank === 'right' ? half + sideGap : -half - sideGap - box.width;
  }

  // Which way every edge goes. Edges into one node from one side share a lane, and a lane is
  // followed by the room its labels need, so a label never stands on the next lane.
  const lanes = { right: new Map(), left: new Map() };
  const laneRoom = { right: [], left: [] };
  const routes = graph.edges.map((edge) => {
    if (isSideEdge(edge)) return { route: 'side', flank: sides.get(edge.to).flank };
    if (rankOf(edge.to) - rankOf(edge.from) === 1) return { route: 'direct' };
    const flank = sides.get(edge.from)?.flank === 'left' ? 'left' : 'right';
    if (!lanes[flank].has(edge.to)) lanes[flank].set(edge.to, lanes[flank].size);
    const lane = lanes[flank].get(edge.to);
    laneRoom[flank][lane] = Math.max(laneRoom[flank][lane] ?? 0, edgeLabelWidth(edgeLabel(edge)));
    return { route: 'lane', flank, lane };
  });
  const laneOffsets = (rooms) => {
    let offset = LANE_GAP;
    return rooms.map((room) => {
      const here = offset;
      offset += LANE_PITCH + (room > 0 ? room + 6 : 0);
      return here;
    });
  };
  const laneAt = { right: laneOffsets(laneRoom.right), left: laneOffsets(laneRoom.left) };

  // Down: a row is as tall as its tallest node, and the gap has room for the runs of every lane.
  const gap = Math.max(ROW_GAP, 34 + 2 * LANE_STEP * Math.max(lanes.right.size, lanes.left.size));
  for (const [id, box] of boxes) rowOf(id).height = Math.max(rowOf(id).height, box.height);
  rows.forEach((row, index) => {
    row.y = index === 0 ? 0 : rows[index - 1].y + rows[index - 1].height + gap;
  });
  for (const [id, box] of boxes) box.y = rowOf(id).y + (rowOf(id).height - box.height) / 2;

  const left = Math.min(...[...boxes.values()].map((box) => box.x));
  const right = Math.max(...[...boxes.values()].map((box) => box.x + box.width));
  const centre = (box) => box.x + box.width / 2;

  const edges = graph.edges.map((edge, index) => {
    const { route, flank, lane } = routes[index];
    const [from, to] = [boxes.get(edge.from), boxes.get(edge.to)];
    const label = edgeLabel(edge);
    const out = { from: edge.from, to: edge.to, label: label === '' ? null : label, route, points: [], direction: 'down', labelAt: null };

    if (route === 'side') {
      const y = from.y + from.height / 2;
      const [x1, x2] = flank === 'right' ? [from.x + from.width, to.x] : [from.x, to.x + to.width];
      out.points = [
        [x1, y],
        [x2, y],
      ];
      out.direction = flank;
      if (label) out.labelAt = { x: (x1 + x2) / 2, y: y - 6, anchor: 'middle' };
      return out;
    }

    const [sx, sy, tx, ty] = [centre(from), from.y + from.height, centre(to), to.y];
    const gapTop = rowOf(edge.from).y + rowOf(edge.from).height;
    const gapBottom = rowOf(edge.to).y;
    if (route === 'direct') {
      out.points = [
        [sx, sy],
        [sx, gapTop],
        [tx, gapBottom],
        [tx, ty],
      ];
      // The label stands half way down the gap, between the runs of the lanes: to the right of a
      // line that is upright or nearly so, above the middle of a curve that goes far sideways.
      const middle = (gapTop + gapBottom) / 2;
      const upright = Math.abs(sx - tx) < UPRIGHT;
      if (label) out.labelAt = upright ? { x: Math.max(sx, tx) + 7, y: middle + 1, anchor: 'start' } : { x: (sx + tx) / 2, y: middle - 5, anchor: 'middle' };
      return out;
    }

    // Out of the source, level through the gap below it, down the lane, level through the gap
    // above the target and into it. Each lane has its own height in a gap, so two never share a run.
    const laneX = flank === 'right' ? right + laneAt.right[lane] : left - laneAt.left[lane];
    const level = LANE_STEP * lane + (flank === 'left' ? LANE_STEP / 2 : 0);
    const outY = gapTop + 12 + level;
    const inY = gapBottom - ARROW - 8 - level;
    out.points = [
      [sx, sy],
      [sx, outY],
      [laneX, outY],
      [laneX, inY],
      [tx, inY],
      [tx, ty],
    ];
    if (label) out.labelAt = { x: laneX + (flank === 'right' ? 6 : -6), y: (outY + inY) / 2 + 4, anchor: flank === 'right' ? 'start' : 'end' };
    return out;
  });

  // Edges that run together (out of one row, into one node) would put their labels on one spot;
  // the later label moves a line down.
  const taken = new Set();
  for (const edge of edges) {
    if (!edge.labelAt) continue;
    while (taken.has(`${edge.labelAt.x} ${edge.labelAt.y}`)) edge.labelAt.y += EDGE_FONT_SIZE + 2;
    taken.add(`${edge.labelAt.x} ${edge.labelAt.y}`);
  }

  // The view box: everything that is drawn plus a margin, moved so that it starts at 0 0.
  let [minX, maxX] = [left, right];
  for (const edge of edges) {
    for (const [x] of edge.points) [minX, maxX] = [Math.min(minX, x), Math.max(maxX, x)];
    if (!edge.labelAt) continue;
    const width = edgeLabelWidth(edge.label);
    const start = edge.labelAt.x - { start: 0, middle: width / 2, end: width }[edge.labelAt.anchor];
    [minX, maxX] = [Math.min(minX, start), Math.max(maxX, start + width)];
  }
  const shift = MARGIN - minX;
  for (const box of boxes.values()) {
    box.x += shift;
    box.y += MARGIN;
  }
  for (const edge of edges) {
    edge.points = edge.points.map(([x, y]) => [x + shift, y + MARGIN]);
    if (edge.labelAt) edge.labelAt = { ...edge.labelAt, x: edge.labelAt.x + shift, y: edge.labelAt.y + MARGIN };
    edge.d = pathOf(edge.route, edge.points);
  }
  const last = rows[rows.length - 1];
  return {
    width: Math.ceil(maxX + shift + MARGIN),
    height: Math.ceil(last.y + last.height + 2 * MARGIN),
    nodes: graph.nodes.map((node) => boxes.get(node.id)),
    edges,
  };
}

// --- drawing ------------------------------------------------------------------------------------

function shapeOf(box) {
  const [x, y, width, height] = [box.x, box.y, box.width, box.height];
  if (box.kind === 'decision') {
    const d = `M${at([x + width / 2, y])}L${at([x + width, y + height / 2])}L${at([x + width / 2, y + height])}L${at([x, y + height / 2])}Z`;
    return `<path d="${d}" fill="${PAINT.box}" stroke="${PAINT.decision}" stroke-width="1.5" stroke-linejoin="round"/>`;
  }
  const rect = `x="${fixed(x)}" y="${fixed(y)}" width="${fixed(width)}" height="${fixed(height)}"`;
  if (box.kind === 'step') return `<rect ${rect} rx="8" fill="${PAINT.box}" stroke="${PAINT.outline}"/>`;
  if (box.kind === 'note') return `<rect ${rect} rx="8" fill="none" stroke="${PAINT.outline}" stroke-dasharray="4 3"/>`;
  return `<rect ${rect} rx="${fixed(height / 2)}" fill="${PAINT.pill}" stroke="${PAINT.outline}"/>`;
}

function drawNode(box) {
  const x = fixed(box.x + box.width / 2);
  const first = box.y + box.height / 2 - (box.lines.length * LINE_HEIGHT) / 2 + BASELINE;
  const spans = box.lines.map((line, index) => `<tspan x="${x}" y="${fixed(first + index * LINE_HEIGHT)}">${esc(line)}</tspan>`);
  const text = `<text${box.kind === 'note' ? ` fill="${PAINT.quiet}"` : ''}>${spans.join('')}</text>`;
  return `<g data-node="${esc(box.id)}" data-kind="${box.kind}">${shapeOf(box)}${text}</g>`;
}

// One inline <svg> for the graph, or '' for a graph with no nodes. `title` is required: it is the
// accessible name of the diagram. The svg is as wide as its container, up to `maxWidth` pixels and
// never wider than its natural size. Every text is escaped; no label can become markup.
export function toSvg(graph, options = {}) {
  const { title, maxWidth } = options;
  if (typeof title !== 'string' || clean(title) === '') throw new Error('toSvg needs a title: it is the accessible name of the diagram');
  if (maxWidth !== undefined && !(typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0)) {
    throw new Error('maxWidth must be a positive number of pixels');
  }
  const layout = layoutGraph(graph);
  if (layout.nodes.length === 0) return '';

  const name = esc(clean(title));
  const shown = Math.max(1, Math.round(Math.min(maxWidth ?? layout.width, layout.width)));
  const labelled = layout.edges.filter((edge) => edge.labelAt);
  return [
    `<svg role="img" aria-label="${name}" viewBox="0 0 ${layout.width} ${layout.height}" width="100%" style="max-width:${shown}px;height:auto" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="${FONT_SIZE}">`,
    `<title>${name}</title>`,
    `<g fill="none" stroke="${PAINT.outline}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">`,
    ...layout.edges.map((edge) => `<path data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" d="${edge.d}"/>`),
    '</g>',
    `<g fill="${PAINT.outline}">`,
    ...layout.edges.map((edge) => `<path d="${arrowHead(edge.points[edge.points.length - 1], edge.direction)}"/>`),
    '</g>',
    '<g text-anchor="middle" fill="currentColor" stroke-width="1.25">',
    ...layout.nodes.map(drawNode),
    '</g>',
    ...(labelled.length === 0
      ? []
      : [
          `<g font-size="${EDGE_FONT_SIZE}" fill="${PAINT.quiet}">`,
          ...labelled.map((edge) => `<text x="${fixed(edge.labelAt.x)}" y="${fixed(edge.labelAt.y)}" text-anchor="${edge.labelAt.anchor}">${esc(edge.label)}</text>`),
          '</g>',
        ]),
    '</svg>',
  ].join('\n');
}
