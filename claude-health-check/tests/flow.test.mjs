// The flow diagram of a skill: the steps read from its text, the Mermaid source and the inline SVG.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { load, materialise } from './helpers/fixtures.mjs';

const { FLOW_LABELS, FLOW_LIMITS, FLOW_SOURCES, MERGE_REJECTIONS, NODE_KINDS, extractFlow, mergeBranches, toMermaid } = await load('lib/flow.mjs');
const { SVG_METRICS, layoutGraph, textUnits, toSvg } = await load('lib/flow-svg.mjs');
const { splitLines } = await load('lib/markdown.mjs');

let flows;

before(() => {
  flows = materialise('flows');
});
after(() => {
  flows.cleanup();
});

const userSkill = (name) => readFileSync(path.join(flows.home, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
const projectSkill = (project, name) =>
  readFileSync(path.join(flows.project(project), '.claude', 'skills', name, 'SKILL.md'), 'utf8');

const ids = (flow) => flow.nodes.map((node) => node.id);
const shapes = (flow) => flow.nodes.map((node) => [node.id, node.kind, node.label]);
const labelOf = (flow, id) => flow.nodes.find((node) => node.id === id).label;
const lineOfNode = (flow, id) => flow.nodes.find((node) => node.id === id).line;
const arrows = (flow) => flow.edges.map((edge) => `${edge.from} ${edge.label ? `-${edge.label}-> ` : '-> '}${edge.to}`);
const lineOf = (text, needle) => splitLines(text).findIndex((line) => line.includes(needle)) + 1;
const numbered = (count, write = (number) => `Do thing ${number}.`) =>
  Array.from({ length: count }, (_, index) => `${index + 1}. ${write(index + 1)}`).join('\n');

// --- extraction ---------------------------------------------------------------------------------

test('a numbered procedure becomes one chain from start to end, in the order of the text', () => {
  const text = userSkill('changelog-notes');
  const flow = extractFlow(text);
  assert.equal(flow.source, 'list');
  assert.equal('capped' in flow, false);
  assert.deepEqual(shapes(flow), [
    ['start', 'start', 'Start'],
    ['s1', 'step', 'Find the tag of the last version with git describe --tags'],
    ['s2', 'step', 'List the changes merged since that tag'],
    ['s3', 'step', 'Group the changes by type'],
    ['s4', 'step', 'Write one line per change'],
    ['s5', 'step', 'Show the entry to the user and wait for an answer'],
    ['s6', 'step', 'Save the entry at the top of CHANGELOG.md'],
    ['end', 'end', 'End'],
  ]);
  assert.deepEqual(arrows(flow), ['start -> s1', 's1 -> s2', 's2 -> s3', 's3 -> s4', 's4 -> s5', 's5 -> s6', 's6 -> end']);
  assert.equal(lineOfNode(flow, 's1'), lineOf(text, '1. Find the tag'));
  assert.equal(lineOfNode(flow, 's6'), lineOf(text, '6. Save the entry'));
  assert.equal('line' in flow.nodes[0], false, 'the start node is not a line of the skill');
});

test('front matter and fenced code are never read as steps', () => {
  const lines = [
    '---',
    'name: sample',
    'notes: |',
    '  1. front matter one',
    '  2. front matter two',
    '  3. front matter three',
    '---',
    '',
    '```',
    '1. fenced one',
    '2. fenced two',
    '3. fenced three',
    '4. fenced four',
    '```',
    '',
    '1. Open the file.',
    '2. Close the file.',
  ];
  const flow = extractFlow(lines.join('\n'));
  assert.deepEqual(shapes(flow).slice(1, 3), [
    ['s1', 'step', 'Open the file'],
    ['s2', 'step', 'Close the file'],
  ]);
  assert.deepEqual([lineOfNode(flow, 's1'), lineOfNode(flow, 's2')], [16, 17]);
  assert.equal(flow.nodes.length, 4);
  assert.equal(extractFlow(lines.slice(0, 15).join('\n')).source, 'none', 'without the real list nothing is left');
});

test('a skill organised by headings takes its steps from the headings', () => {
  const text = userSkill('data-import');
  const flow = extractFlow(text);
  assert.equal(flow.source, 'headings');
  assert.deepEqual(shapes(flow), [
    ['start', 'start', 'Start'],
    ['s1', 'step', 'Locate the file'],
    ['s2', 'step', 'Validate the columns'],
    ['s2d1', 'decision', 'A required column is missing?'],
    ['s2d1y', 'step', 'List the missing columns and stop'],
    ['s3', 'step', 'Step 3'],
    ['s4', 'step', 'Report'],
    ['end', 'end', 'End'],
  ]);
  assert.deepEqual(arrows(flow), [
    'start -> s1',
    's1 -> s2',
    's2 -> s2d1',
    's2d1 -yes-> s2d1y',
    's2d1y -> end',
    's2d1 -no-> s3',
    's3 -> s4',
    's4 -> end',
  ]);
  assert.equal(lineOfNode(flow, 's2'), lineOf(text, '## Step 2'));
  assert.equal(lineOfNode(flow, 's2d1'), lineOf(text, '- If a required column'));

  const byNumber = extractFlow(projectSkill('sample-app', 'seed-data'));
  assert.equal(byNumber.source, 'headings');
  assert.deepEqual(
    byNumber.nodes.map((node) => node.label),
    ['Start', 'Reset the database', 'Load the sample rows', 'The sample file is older than the schema?', 'Regenerate it first', 'Verify', 'End'],
  );

  const slovak = extractFlow('# Postup\n\n## Krok 1: Priprav dáta\n\nText.\n\n## Krok 2 Spusti import\n');
  assert.equal(slovak.source, 'headings');
  assert.deepEqual(
    slovak.nodes.map((node) => node.label),
    ['Start', 'Priprav dáta', 'Spusti import', 'End'],
  );

  // Numbered headings that only name the sections of a document lose to a longer procedure.
  const sections = extractFlow('## 1. Overview\n\nText.\n\n## 2. Procedure\n\n1. Read.\n2. Think.\n3. Write.\n');
  assert.equal(sections.source, 'list');
  assert.deepEqual(
    sections.nodes.map((node) => node.label),
    ['Start', 'Read', 'Think', 'Write', 'End'],
  );
});

test('a code block indented under a step belongs to that step', () => {
  const text = [
    '1. Run the script.',
    '',
    '   ```sh',
    '   2. not a step',
    '   - If it fails, retry it.',
    '   ```',
    '',
    '2. Read the output.',
    '',
    '```',
    '3. not a step either',
    '```',
    '',
    '3. Report.',
    '   - one detail',
    '   - another detail',
  ].join('\n');
  const flow = extractFlow(text);
  assert.deepEqual(shapes(flow), [
    ['start', 'start', 'Start'],
    ['s1', 'step', 'Run the script'],
    ['s2', 'step', 'Read the output'],
    ['s3', 'step', 'Report'],
    ['end', 'end', 'End'],
  ]);
  assert.deepEqual(
    ['s1', 's2', 's3'].map((id) => lineOfNode(flow, id)),
    [1, 8, 14],
  );
});

test('a nested list under a step belongs to that step, however long it is', () => {
  const flow = extractFlow(
    ['1. Prepare the folder.', '   1. Open it.', '   2. Check its name.', '   3. Close it.', '2. Run the import.', '   - one detail'].join('\n'),
  );
  assert.deepEqual(shapes(flow), [
    ['start', 'start', 'Start'],
    ['s1', 'step', 'Prepare the folder'],
    ['s2', 'step', 'Run the import'],
    ['end', 'end', 'End'],
  ]);
  // A numbered list that hangs under a bullet is not the main procedure of the skill.
  assert.equal(extractFlow('- Phase one\n  1. Open it.\n  2. Check it.\n  3. Close it.\n').source, 'none');
  // A paragraph ends a list; numbering that starts again starts another one, and the longest wins.
  const two = extractFlow('1. First of two.\n2. Second of two.\n\nA paragraph in between.\n\n1. First of three.\n2. Second of three.\n3. Third of three.\n');
  assert.deepEqual(
    two.nodes.map((node) => node.label),
    ['Start', 'First of three', 'Second of three', 'Third of three', 'End'],
  );
  // Numbering that carries on after a paragraph is still the same procedure.
  const carried = extractFlow('1. One.\n2. Two.\n\nA paragraph in between.\n\n3. Three.\n');
  assert.deepEqual(ids(carried), ['start', 's1', 's2', 's3', 'end']);
});

test('English branch phrases: If, When and Unless become a decision with the stated action on its branch', () => {
  const text = userSkill('image-resize');
  const flow = extractFlow(text);
  assert.equal(flow.source, 'list');
  assert.deepEqual(shapes(flow), [
    ['start', 'start', 'Start'],
    ['s1', 'step', 'Ask which folder holds the images'],
    ['s2', 'decision', 'The folder holds no images?'],
    ['s2y', 'step', 'Say so and stop'],
    ['s3', 'step', 'Read the widths from sizes.json'],
    ['s3d1', 'decision', 'The file is missing?'],
    ['s3d1y', 'step', 'Ask the user for the widths'],
    ['s3d1n', 'step', 'Use the widths it lists'],
    ['s4', 'decision', 'An image is narrower than the smallest width?'],
    ['s4y', 'step', 'Skip it'],
    ['s4n', 'step', 'Resize it to every width'],
    ['s5', 'decision', 'The user asked for a dry run?'],
    ['s5n', 'step', 'Write the resized files next to the originals'],
    ['s6', 'step', 'Check the result'],
    ['s6d1', 'decision', 'A file is larger than its original?'],
    ['s6d1y', 'step', 'Keep the original and report it'],
    ['s6d2', 'decision', 'Every file is smaller?'],
    ['s6d2y', 'step', 'Continue'],
    ['s7', 'step', 'Print the summary'],
    ['end', 'end', 'End'],
  ]);
  assert.deepEqual(arrows(flow), [
    'start -> s1',
    's1 -> s2',
    's2 -yes-> s2y',
    's2y -> end',
    's2 -no-> s3',
    's3 -> s3d1',
    's3d1 -yes-> s3d1y',
    's3d1y -> s4',
    's3d1 -no-> s3d1n',
    's3d1n -> s4',
    's4 -yes-> s4y',
    's4y -> s5',
    's4 -no-> s4n',
    's4n -> s5',
    // "Unless X, do Y": Y is what happens when X does not hold.
    's5 -no-> s5n',
    's5n -> s6',
    's5 -yes-> s6',
    's6 -> s6d1',
    's6d1 -yes-> s6d1y',
    's6d1y -> s6d2',
    's6d1 -no-> s6d2',
    's6d2 -yes-> s6d2y',
    's6d2y -> s7',
    's6d2 -no-> s7',
    's7 -> end',
  ]);
  assert.equal(lineOfNode(flow, 's3d1'), lineOf(text, '- If the file is missing'));
  assert.equal(lineOfNode(flow, 's3d1n'), lineOf(text, '- Otherwise use the widths'));
  assert.equal(lineOfNode(flow, 's4n'), lineOf(text, '4. When an image'));
});

test('Slovak branch phrases: Ak, Keď and Ked, with Inak and skonči', () => {
  const text = userSkill('kontrola-prekladov');
  const flow = extractFlow(text);
  assert.deepEqual(shapes(flow), [
    ['start', 'start', 'Start'],
    ['s1', 'step', 'Načítaj všetky súbory z priečinka locales/'],
    ['s2', 'decision', 'Priečinok neexistuje?'],
    ['s2y', 'step', 'Povedz to a skonči'],
    ['s3', 'step', 'Porovnaj kľúče každého jazyka s angličtinou'],
    ['s3d1', 'decision', 'V jazyku chýba kľúč?'],
    ['s3d1y', 'step', 'Zapíš ho do zoznamu'],
    ['s3d1n', 'step', 'Pokračuj ďalším jazykom'],
    ['s4', 'decision', 'Je zoznam prázdny?'],
    ['s4y', 'step', 'Napíš, že je všetko v poriadku'],
    ['s4n', 'step', 'Vypíš zoznam chýbajúcich kľúčov'],
    ['s5', 'step', 'Ulož správu'],
    ['end', 'end', 'End'],
  ]);
  assert.deepEqual(arrows(flow), [
    'start -> s1',
    's1 -> s2',
    's2 -yes-> s2y',
    's2y -> end',
    's2 -no-> s3',
    's3 -> s3d1',
    's3d1 -yes-> s3d1y',
    's3d1y -> s4',
    's3d1 -no-> s3d1n',
    's3d1n -> s4',
    's4 -yes-> s4y',
    's4y -> s5',
    's4 -no-> s4n',
    's4n -> s5',
    's5 -> end',
  ]);

  // The words drawn into the diagram are the caller's, so the diagram can follow the report's language.
  const translated = extractFlow(text, { labels: { start: 'Začiatok', end: 'Koniec', yes: 'áno', no: 'nie', more: '+{count} ďalších' } });
  assert.deepEqual([labelOf(translated, 'start'), labelOf(translated, 'end')], ['Začiatok', 'Koniec']);
  assert.deepEqual(arrows(translated).slice(2, 5), ['s2 -áno-> s2y', 's2y -> end', 's2 -nie-> s3']);
});

test('"otherwise" as a second sentence, as a nested item or as the next step is the other branch', () => {
  const both = ['start -> s1', 's1 -> s2', 's2 -yes-> s2y', 's2y -> s3', 's2 -no-> s2n', 's2n -> s3', 's3 -> end'];

  const sentence = extractFlow('1. Read the file.\n2. If it is empty, ask for another. Otherwise count its lines.\n3. Report.');
  assert.deepEqual(arrows(sentence), both);
  assert.deepEqual(
    ['s2', 's2y', 's2n'].map((id) => labelOf(sentence, id)),
    ['It is empty?', 'Ask for another', 'Count its lines'],
  );

  const nested = extractFlow('1. Read the file.\n2. If it is empty, ask for another.\n   - Else, count its lines.\n3. Report.');
  assert.deepEqual(arrows(nested), both);
  assert.equal(labelOf(nested, 's2n'), 'Count its lines');
  assert.equal(lineOfNode(nested, 's2n'), 3);

  const sibling = extractFlow('1. Read the file.\n2. If it is empty, ask for another.\n3. Otherwise count its lines.\n4. Report.');
  assert.deepEqual(ids(sibling), ['start', 's1', 's2', 's2y', 's2n', 's4', 'end']);
  assert.deepEqual(arrows(sibling), ['start -> s1', 's1 -> s2', 's2 -yes-> s2y', 's2y -> s4', 's2 -no-> s2n', 's2n -> s4', 's4 -> end']);
  assert.equal(labelOf(sibling, 's2n'), 'Count its lines');

  // Without one, "no" goes straight to the next step.
  const without = extractFlow('1. Read the file.\n2. If it is empty, ask for another.\n3. Report.');
  assert.deepEqual(arrows(without), ['start -> s1', 's1 -> s2', 's2 -yes-> s2y', 's2y -> s3', 's2 -no-> s3', 's3 -> end']);

  // An "otherwise" with no branch before it is a step like any other.
  const alone = extractFlow('1. Read the file.\n2. Otherwise count its lines.');
  assert.deepEqual(shapes(alone).slice(1, 3), [
    ['s1', 'step', 'Read the file'],
    ['s2', 'step', 'Otherwise count its lines'],
  ]);

  // A branch is drawn only where the text starts with the branch word.
  const prose = extractFlow('1. Read the file and, if it is empty, ask for another.\n2. Elsewhere, report.\n3. If asked nicely.');
  assert.deepEqual(
    prose.nodes.map((node) => node.kind),
    ['start', 'step', 'step', 'step', 'end'],
  );
});

test('a step that says to stop leads to the end node; a word that only looks like it does not', () => {
  const flow = extractFlow(
    [
      '1. If the folder is empty, stop.',
      '2. When the user declines, report it, then stop here.',
      '3. Stop the preview server.',
      '4. Run the end-to-end tests and end each line with a period.',
      '5. If nothing changed, stop and say so. Otherwise save the file.',
      '6. Print the result and stop.',
      '7. Clean up.',
    ].join('\n'),
  );
  assert.deepEqual(arrows(flow), [
    'start -> s1',
    's1 -yes-> s1y',
    's1y -> end',
    's1 -no-> s2',
    's2 -yes-> s2y',
    's2y -> end',
    's2 -no-> s3',
    's3 -> s4',
    's4 -> s5',
    's5 -yes-> s5y',
    's5y -> end',
    's5 -no-> s5n',
    's5n -> s6',
    's6 -> s7',
    's6 -> end',
    's7 -> end',
  ]);

  const words = extractFlow(
    ['1. If it is done, end.', '2. Ak je hotovo, skonci.', '3. Keď nie je čo robiť, vypíš to a ukonči.', '4. If the end is near, mark the end of the file.', '5. Report.'].join('\n'),
  );
  assert.deepEqual(
    arrows(words).filter((arrow) => arrow.endsWith('-> end')),
    ['s1y -> end', 's2y -> end', 's3y -> end', 's5 -> end'],
  );
});

test('a skill with no recognisable steps returns an empty flow: nothing is invented', () => {
  const none = { nodes: [], edges: [], source: 'none' };
  assert.deepEqual(extractFlow(userSkill('style-notes')), none);
  assert.deepEqual(extractFlow(''), none);
  assert.deepEqual(extractFlow('---\nname: x\ndescription: y\n---\n'), none);
  assert.deepEqual(extractFlow('# Title\n\n- one\n- two\n- three\n\n1. the only numbered item\n'), none);
  assert.equal(toMermaid(none), '');
  assert.equal(toSvg(none, { title: 'Nothing to draw' }), '');
});

test('more than 40 nodes: the first 39 are kept and a note says how many were dropped', () => {
  assert.equal(FLOW_LIMITS.maxNodes, 40);
  const flow = extractFlow(numbered(45));
  assert.equal(flow.nodes.length, 40);
  assert.equal(flow.capped, 8);
  assert.deepEqual(flow.nodes.at(-1), { id: 'more', label: '+8 more', kind: 'note' });
  assert.equal(flow.nodes.at(-2).id, 's38');
  assert.deepEqual(arrows(flow).slice(-2), ['s37 -> s38', 's38 -> more']);
  const kept = new Set(ids(flow));
  for (const edge of flow.edges) assert.ok(kept.has(edge.from) && kept.has(edge.to), `${edge.from} -> ${edge.to}`);

  const exact = extractFlow(numbered(38));
  assert.equal(exact.nodes.length, 40);
  assert.equal('capped' in exact, false);
  assert.equal(exact.nodes.at(-1).id, 'end');

  // An edge into a dropped node goes to the note, once and without its label.
  const branching = extractFlow(numbered(30, (number) => `If case ${number} holds, handle it.`));
  assert.equal(branching.nodes.length, 40);
  assert.equal(branching.capped, 23);
  assert.deepEqual(arrows(branching).slice(-3), ['s19 -yes-> s19y', 's19y -> more', 's19 -> more']);
  assert.equal(extractFlow(numbered(45), { labels: { start: 'A', end: 'B', yes: 'c', no: 'd', more: 'a ešte {count}' } }).nodes.at(-1).label, 'a ešte 8');
});

test('a label is the first sentence without markup, shortened at a word boundary', () => {
  const flow = extractFlow(
    [
      '1. **Check** the _status_ of [the build](docs/build.md) with `make status`. Then wait.',
      '2. [ ] Compare the generated report with the one from the preceding run and list every line that differs.',
      '3. Pick a day, e.g. Monday, and check `src/**/*.ts`.',
      '4. Keep the snake_case names',
      '   and the file_names as they are. A second sentence.',
      `5. ${'x'.repeat(100)}`,
    ].join('\n'),
  );
  assert.deepEqual(
    flow.nodes.slice(1, 6).map((node) => node.label),
    [
      'Check the status of the build with make status',
      'Compare the generated report with the one from the…',
      'Pick a day, e.g. Monday, and check src/**/*.ts',
      'Keep the snake_case names and the file_names as they are',
      `${'x'.repeat(59)}…`,
    ],
  );
  for (const node of flow.nodes) assert.ok([...node.label].length <= FLOW_LIMITS.labelChars, node.label);
});

test('extraction is deterministic, and ids come from position, never from content', () => {
  const text = userSkill('image-resize');
  assert.equal(JSON.stringify(extractFlow(text)), JSON.stringify(extractFlow(text)));
  const reworded = text
    .replace('Ask which folder holds the images', 'Find out where the pictures are')
    .replace('the folder holds no images', 'there is nothing to do')
    .replace('Print the summary', 'Show the totals');
  assert.notEqual(reworded, text);
  assert.deepEqual(ids(extractFlow(reworded)), ids(extractFlow(text)));
  assert.deepEqual(extractFlow(text.replace(/\r?\n/g, '\r\n')), extractFlow(text.replace(/\r\n/g, '\n')), 'line endings do not matter');
});

test('a hostile skill text is read in linear time', () => {
  const started = performance.now();
  const hostile = [
    `1. ${'If '.repeat(650)}`,
    `2. ${'*'.repeat(1990)}`,
    `3. ${'a. B '.repeat(390)}`,
    `4. ${' '.repeat(5000)}x`,
    `5. ${'*a '.repeat(660)}`,
    numbered(20000),
  ].join('\n');
  const flow = extractFlow(hostile);
  assert.ok(performance.now() - started < 3000, 'reading the steps took over three seconds');
  assert.equal(flow.nodes.length, 40);
});

// --- branches the wizard read in prose ----------------------------------------------------------

test('mergeBranches accepts a branch only with the exact text of the line it quotes', () => {
  const text = userSkill('changelog-notes');
  const flow = extractFlow(text);
  const untouched = JSON.stringify(flow);
  const line = lineOf(text, '5. Show the entry');
  const quote = splitLines(text)[line - 1];

  const merged = mergeBranches(flow, [{ at: 's5', question: 'The user asks for changes', yes: 'Rewrite the entry and show it again', quote, line }], text);
  assert.deepEqual(merged.rejected, []);
  assert.deepEqual(merged.accepted, [{ index: 0, at: 's5', decision: 's5q1', line }]);
  assert.deepEqual(
    merged.flow.nodes.slice(5, 9).map((node) => [node.id, node.kind, node.label, node.line]),
    [
      ['s5', 'step', 'Show the entry to the user and wait for an answer', line],
      ['s5q1', 'decision', 'The user asks for changes?', line],
      ['s5q1y', 'step', 'Rewrite the entry and show it again', line],
      ['s6', 'step', 'Save the entry at the top of CHANGELOG.md', line + 1],
    ],
  );
  assert.deepEqual(arrows(merged.flow).slice(4), ['s4 -> s5', 's5 -> s5q1', 's5q1 -yes-> s5q1y', 's5q1y -> s6', 's5q1 -no-> s6', 's6 -> end']);
  assert.equal(merged.flow.source, 'list');
  assert.equal(JSON.stringify(flow), untouched, 'the flow that was passed in is not changed');

  // Both branches, one of which says to stop.
  const both = mergeBranches(flow, [{ at: 's5', question: 'Does the user accept the entry?', yes: 'Continue', no: 'Stop.', quote, line }], text);
  assert.deepEqual(arrows(both.flow).slice(4), [
    's4 -> s5',
    's5 -> s5q1',
    's5q1 -yes-> s5q1y',
    's5q1y -> s6',
    's5q1 -no-> s5q1n',
    's5q1n -> end',
    's6 -> end',
  ]);
  assert.deepEqual(
    ['s5q1', 's5q1y', 's5q1n'].map((id) => labelOf(both.flow, id)),
    ['Does the user accept the entry?', 'Continue', 'Stop'],
  );

  // A quote may span lines; then it is the exact text of all of them.
  const twoLines = splitLines(text)
    .slice(line - 1, line + 1)
    .join('\n');
  const spanning = mergeBranches(flow, [{ at: 's5', question: 'Q', yes: 'Y', quote: twoLines, line, endLine: line + 1 }], text);
  assert.deepEqual(spanning.rejected, []);

  // Two branches at the same step get two ids.
  const twice = mergeBranches(
    flow,
    [
      { at: 's5', question: 'First', yes: 'One', quote, line },
      { at: 's5', question: 'Second', yes: 'Two', quote, line },
    ],
    text,
  );
  assert.deepEqual(
    twice.accepted.map((entry) => entry.decision),
    ['s5q1', 's5q2'],
  );
  assert.equal(new Set(ids(twice.flow)).size, twice.flow.nodes.length);
  toMermaid(twice.flow);
  layoutGraph(twice.flow);
});

test('mergeBranches returns what it refused, each with the reason: no quote, no claim', () => {
  const text = userSkill('changelog-notes');
  const flow = extractFlow(text);
  const line = lineOf(text, '5. Show the entry');
  const quote = splitLines(text)[line - 1];
  const overlay = [
    { at: 's5', question: 'Q', yes: 'Y', quote: 'Show the entry to the user and wait for an answer.', line },
    { at: 's5', question: 'Q', yes: 'Y', quote, line: line + 1 },
    { at: 's5', question: 'Q', yes: 'Y', quote, line: 9999 },
    { at: 's5', question: 'Q', yes: 'Y', line },
    { at: 's9', question: 'Q', yes: 'Y', quote, line },
    { at: 'start', question: 'Q', yes: 'Y', quote, line },
    { at: 's5', question: ' ', yes: 'Y', quote, line },
    { at: 's5', question: 'Q', yes: 'Y', quote: `${quote} `, line },
    { at: 's5', question: 'Q', yes: 'Y', quote, line: 0 },
    { at: 's4', question: 'Is it short', yes: 'Keep it', quote, line },
  ];
  const merged = mergeBranches(flow, overlay, text);
  assert.deepEqual(
    merged.rejected.map((entry) => [entry.index, entry.reason]),
    [
      [0, 'quote-mismatch'],
      [1, 'quote-mismatch'],
      [2, 'line-out-of-range'],
      [3, 'missing-quote'],
      [4, 'unknown-node'],
      [5, 'not-a-step'],
      [6, 'missing-text'],
      [7, 'quote-mismatch'],
      [8, 'line-out-of-range'],
    ],
  );
  for (const entry of merged.rejected) {
    assert.equal(entry.item, overlay[entry.index]);
    assert.ok(entry.message.length > 20, entry.reason);
  }
  assert.deepEqual(
    merged.accepted.map((entry) => [entry.index, entry.decision]),
    [[9, 's4q1']],
  );

  const refused = mergeBranches(flow, overlay.slice(0, 9), text);
  assert.deepEqual(refused.flow, flow, 'nothing accepted, nothing drawn');
  assert.notEqual(refused.flow, flow);

  // A flow at the cap takes no more nodes.
  const longText = numbered(45);
  const full = mergeBranches(extractFlow(longText), [{ at: 's2', question: 'Q', yes: 'Y', quote: '2. Do thing 2.', line: 2 }], longText);
  assert.deepEqual(
    full.rejected.map((entry) => entry.reason),
    ['too-many-nodes'],
  );
  assert.equal(full.flow.nodes.length, 40);

  // Every reason of the closed set was seen above, so a caller can hold a string for each.
  const seen = new Set([...merged.rejected, ...full.rejected].map((entry) => entry.reason));
  assert.deepEqual([...seen].sort(), [...MERGE_REJECTIONS].sort());
});

test('the closed sets a caller builds on: kinds, sources and the words drawn into a diagram', () => {
  assert.deepEqual(NODE_KINDS, ['start', 'step', 'decision', 'end', 'note']);
  assert.deepEqual(FLOW_SOURCES, ['list', 'headings', 'none']);
  assert.deepEqual(FLOW_LABELS, { start: 'Start', end: 'End', yes: 'yes', no: 'no', more: '+{count} more' });
  const flowsRead = [
    ...['changelog-notes', 'image-resize', 'data-import', 'kontrola-prekladov', 'style-notes'].map((name) => extractFlow(userSkill(name))),
    extractFlow(projectSkill('sample-app', 'seed-data')),
    extractFlow(numbered(45)),
  ];
  assert.deepEqual([...new Set(flowsRead.map((flow) => flow.source))].sort(), [...FLOW_SOURCES].sort());
  for (const flow of flowsRead) {
    for (const node of flow.nodes) assert.ok(NODE_KINDS.includes(node.kind), node.kind);
    assert.equal(new Set(ids(flow)).size, flow.nodes.length, 'ids are unique');
    for (const node of flow.nodes) assert.match(node.id, /^(start|end|more|s\d+(d\d+)?[yn]?)$/);
  }
  assert.deepEqual([...new Set(flowsRead.flatMap((flow) => flow.nodes.map((node) => node.kind)))].sort(), [...NODE_KINDS].sort());
});

// --- Mermaid ------------------------------------------------------------------------------------

const small = {
  nodes: [
    { id: 'start', label: 'Start', kind: 'start' },
    { id: 's1', label: 'Read the file', kind: 'step' },
    { id: 's2', label: 'The file is empty?', kind: 'decision' },
    { id: 's2y', label: 'Stop', kind: 'step' },
    { id: 'more', label: '+3 more', kind: 'note' },
    { id: 'end', label: 'End', kind: 'end' },
  ],
  edges: [
    { from: 'start', to: 's1' },
    { from: 's1', to: 's2' },
    { from: 's2', to: 's2y', label: 'yes' },
    { from: 's2y', to: 'end' },
    { from: 's2', to: 'more', label: 'no' },
  ],
  source: 'list',
};

test('toMermaid writes a top-down flowchart with one shape per kind and labelled arrows', () => {
  assert.equal(
    toMermaid(small),
    [
      'flowchart TD',
      '  n1(["Start"])',
      '  n2["Read the file"]',
      '  n3{"The file is empty?"}',
      '  n4["Stop"]',
      '  n5("+3 more")',
      '  n6(["End"])',
      '  n1 --> n2',
      '  n2 --> n3',
      '  n3 -->|"yes"| n4',
      '  n4 --> n6',
      '  n3 -->|"no"| n5',
    ].join('\n'),
  );
});

test('toMermaid escapes every character Mermaid would interpret, so a label cannot leave its node', () => {
  const decode = (text) => text.replace(/#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
  const one = (label, kind = 'step') => toMermaid({ nodes: [{ id: 'a', label, kind }], edges: [] }).split('\n')[1];

  assert.equal(one('a "b" [c]'), '  n1["a #34;b#34; #91;c#93;"]');
  assert.equal(one('x | y'), '  n1["x #124; y"]');
  assert.equal(one('<b>bold</b>'), '  n1["#60;b#62;bold#60;/b#62;"]');
  assert.equal(one('run `make`'), '  n1["run #96;make#96;"]');
  assert.equal(one('one\ntwo\r\nthree\tfour'), '  n1["one two three four"]');
  assert.equal(one('{x} (y)', 'decision'), '  n1{"#123;x#125; #40;y#41;"}');
  assert.equal(one('a #35; & b; %%{init}%%'), '  n1["a #35;35#59; #38; b#59; #37;#37;#123;init#125;#37;#37;"]');
  assert.equal(one('Načítaj súbory, prosím: áno?'), '  n1["Načítaj súbory, prosím: áno?"]', 'letters of any language stay readable');

  const hostile = ['"]\n  click a call alert()', 'a"] --> b["c', '|x| --> y', '`**md**`', '</div><script>alert(1)</script>', 'end', '%%{init: {"securityLevel": "loose"}}%%'];
  const graph = {
    nodes: hostile.map((label, index) => ({ id: `id ${index}"]`, label, kind: index % 2 ? 'decision' : 'step' })),
    edges: hostile.slice(1).map((label, index) => ({ from: `id ${index}"]`, to: `id ${index + 1}"]`, label })),
  };
  const lines = toMermaid(graph).split('\n');
  assert.equal(lines.length, 1 + hostile.length + hostile.length - 1, 'one statement per node and per edge, no more');
  const text = '(?:[^"\\[\\]{}()|<>`;%#&\\\\]|#\\d+;)*';
  const nodeLine = new RegExp(`^  n\\d+(\\["${text}"\\]|\\{"${text}"\\})$`);
  const edgeLine = new RegExp(`^  n\\d+ -->\\|"${text}"\\| n\\d+$`);
  lines.slice(1, 1 + hostile.length).forEach((line, index) => {
    assert.match(line, nodeLine);
    assert.equal(decode(/"(.*)"/.exec(line)[1]), hostile[index].replace(/\s+/g, ' '), 'the text comes back when the entities are decoded');
  });
  for (const line of lines.slice(1 + hostile.length)) assert.match(line, edgeLine);
});

test('toMermaid is deterministic, and its ids depend on position only', () => {
  assert.equal(toMermaid(small), toMermaid(structuredClone(small)));
  const renamed = structuredClone(small);
  renamed.nodes.forEach((node) => {
    node.label = `${node.label} changed`;
  });
  const idsIn = (text) => text.match(/\bn\d+\b/g);
  assert.deepEqual(idsIn(toMermaid(renamed)), idsIn(toMermaid(small)));
  const flow = extractFlow(userSkill('image-resize'));
  assert.equal(toMermaid(flow), toMermaid(extractFlow(userSkill('image-resize'))));
  assert.match(toMermaid(flow), /^flowchart TD\n {2}n1\(\["Start"\]\)\n {2}n2\["Ask which folder holds the images"\]\n {2}n3\{"The folder holds no images\?"\}\n/);
  assert.throws(() => toMermaid({ nodes: [{ id: 'a', label: 'A', kind: 'step' }], edges: [{ from: 'a', to: 'b' }] }), /does not have/);
});

// --- SVG ----------------------------------------------------------------------------------------

const TAGS = ['g', 'path', 'rect', 'svg', 'text', 'title', 'tspan'];
const ATTRIBUTES = new Set([
  'role',
  'aria-label',
  'viewBox',
  'width',
  'style',
  'font-family',
  'font-size',
  'text-anchor',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'd',
  'x',
  'y',
  'height',
  'rx',
  'data-node',
  'data-kind',
  'data-from',
  'data-to',
]);

const plainText = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

// A small tag-balance checker: every tag is opened and closed in order, attributes are quoted,
// and nothing outside a tag holds a bare angle bracket or ampersand.
function parseSvg(svg) {
  const tags = [];
  const open = [];
  const loose = [];
  let last = 0;
  for (const match of svg.matchAll(/<(\/?)([A-Za-z][\w-]*)((?:\s+[A-Za-z][\w:-]*="[^"<>]*")*)\s*(\/?)>/g)) {
    loose.push(svg.slice(last, match.index));
    last = match.index + match[0].length;
    const [, closing, name, attributes, selfClosing] = match;
    if (closing) {
      assert.equal(attributes, '', `</${name}> carries attributes`);
      assert.equal(open.pop()?.name, name, `</${name}> does not close the tag that is open`);
      continue;
    }
    const tag = {
      name,
      attrs: Object.fromEntries([...attributes.matchAll(/([A-Za-z][\w:-]*)="([^"]*)"/g)].map((entry) => [entry[1], entry[2]])),
      parent: open.at(-1) ?? null,
    };
    tags.push(tag);
    if (!selfClosing) open.push(tag);
  }
  loose.push(svg.slice(last));
  assert.deepEqual(
    open.map((tag) => tag.name),
    [],
    'a tag is left open',
  );
  const bare = /[<>]|&(?!(?:amp|lt|gt|quot|#39);)/;
  for (const chunk of loose) assert.ok(!bare.test(chunk), `text outside the tags is not escaped: ${chunk}`);
  for (const tag of tags) {
    for (const value of Object.values(tag.attrs)) assert.ok(!bare.test(value), `an attribute of <${tag.name}> is not escaped: ${value}`);
  }
  assert.equal(tags[0]?.name, 'svg');
  assert.equal(tags.filter((tag) => tag.name === 'svg').length, 1);
  return { tags, text: loose.join('\n') };
}

const setup = {
  nodes: [
    { id: 'user', label: 'User memory', kind: 'step' },
    { id: 'project', label: 'Project memory', kind: 'step' },
    { id: 'local', label: 'Local memory', kind: 'step' },
    { id: 'session', label: 'Loaded at session start', kind: 'step' },
    { id: 'rules', label: 'Rule files', kind: 'step' },
    { id: 'imports', label: 'Imported files', kind: 'step' },
    { id: 'skills', label: 'Skill descriptions', kind: 'step' },
  ],
  edges: [
    { from: 'user', to: 'session' },
    { from: 'project', to: 'session' },
    { from: 'local', to: 'session' },
    { from: 'session', to: 'rules' },
    { from: 'session', to: 'imports', label: 'on demand' },
    { from: 'session', to: 'skills' },
    { from: 'user', to: 'skills', label: 'user skills' },
  ],
};

// Branches that stop on either side of a decision, and a plain step that stops half way.
const stopping = [
  '1. Read the file.',
  '2. If it is empty, stop. Otherwise count its lines.',
  '3. If it is huge, split it. Otherwise stop.',
  '4. Unless it changed, stop. Otherwise save it.',
  '5. Print the result and stop.',
  '6. Clean up.',
].join('\n');

// A decision whose two branch boxes both lead far down, past the steps in between.
const twoSided = {
  nodes: [
    { id: 'top', label: 'Top', kind: 'start' },
    { id: 'ask', label: 'Which way?', kind: 'decision' },
    { id: 'right', label: 'The first branch', kind: 'step' },
    { id: 'left', label: 'The second branch', kind: 'step' },
    { id: 'join', label: 'Neither', kind: 'step' },
    { id: 'other', label: 'One more step', kind: 'step' },
    { id: 'bottom', label: 'Bottom', kind: 'end' },
  ],
  edges: [
    { from: 'top', to: 'ask' },
    { from: 'ask', to: 'right', label: 'yes' },
    { from: 'right', to: 'bottom' },
    { from: 'ask', to: 'left', label: 'no' },
    { from: 'left', to: 'bottom' },
    { from: 'ask', to: 'join' },
    { from: 'join', to: 'other' },
    { from: 'other', to: 'bottom' },
  ],
};

// A chain with three edges that skip rows, into two different nodes.
const skipping = {
  nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: `Node ${id}`, kind: 'step' })),
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
    { from: 'a', to: 'c', label: 'to c' },
    { from: 'a', to: 'd', label: 'to d' },
    { from: 'b', to: 'd' },
  ],
};

// Two decisions side by side: neither has its row to itself, so no branch box can stand beside one.
const crowded = {
  nodes: [
    { id: 'root', label: 'Root', kind: 'start' },
    { id: 'first', label: 'First question?', kind: 'decision' },
    { id: 'second', label: 'Second question?', kind: 'decision' },
    { id: 'a', label: 'Answer to the first', kind: 'step' },
    { id: 'b', label: 'Answer to the second', kind: 'step' },
    { id: 'done', label: 'Done', kind: 'end' },
  ],
  edges: [
    { from: 'root', to: 'first' },
    { from: 'root', to: 'second' },
    { from: 'first', to: 'a', label: 'yes' },
    { from: 'a', to: 'done' },
    { from: 'first', to: 'done', label: 'no' },
    { from: 'second', to: 'b', label: 'yes' },
    { from: 'b', to: 'done' },
    { from: 'second', to: 'done', label: 'no' },
  ],
};

const samples = () => [
  ['skipping', skipping],
  ['crowded', crowded],
  ['linear', extractFlow(userSkill('changelog-notes'))],
  ['branching', extractFlow(userSkill('image-resize'))],
  ['headings', extractFlow(userSkill('data-import'))],
  ['stopping', extractFlow(stopping)],
  ['two-sided', twoSided],
  ['capped', extractFlow(numbered(30, (number) => `If case ${number} holds, handle it. Otherwise note it.`))],
  ['general', setup],
];

const boxOf = (layout, id) => layout.nodes.find((node) => node.id === id);
const centreX = (box) => box.x + box.width / 2;
const centreY = (box) => box.y + box.height / 2;
const same = (a, b) => Math.abs(a - b) < 0.01;

function onBorder(point, box) {
  const [x, y] = point;
  const inside = x >= box.x - 0.01 && x <= box.x + box.width + 0.01 && y >= box.y - 0.01 && y <= box.y + box.height + 0.01;
  const onEdge = same(x, box.x) || same(x, box.x + box.width) || same(y, box.y) || same(y, box.y + box.height);
  return inside && onEdge;
}

test('toSvg returns one well-formed svg with a title, a role and a view box', () => {
  for (const [name, graph] of samples()) {
    const svg = toSvg(graph, { title: `Flow of ${name}` });
    const { tags } = parseSvg(svg);
    assert.match(svg, /^<svg /, name);
    assert.match(svg, /<\/svg>$/, name);
    const root = tags[0];
    assert.equal(root.attrs.role, 'img');
    assert.equal(root.attrs['aria-label'], `Flow of ${name}`);
    assert.equal(tags[1].name, 'title', 'the title is the first child');
    assert.ok(svg.includes(`<title>Flow of ${name}</title>`));
    const layout = layoutGraph(graph);
    assert.equal(root.attrs.viewBox, `0 0 ${layout.width} ${layout.height}`);
    assert.ok(Number.isInteger(layout.width) && Number.isInteger(layout.height) && layout.width > 0 && layout.height > 0);
    assert.equal(root.attrs.width, '100%');
    assert.equal(toSvg(graph, { title: `Flow of ${name}` }), svg, 'the same graph draws the same svg');
  }
});

test('the svg is 100% wide up to maxWidth and never larger than its natural size', () => {
  const graph = extractFlow(userSkill('image-resize'));
  const { width } = layoutGraph(graph);
  const styleOf = (options) => parseSvg(toSvg(graph, { title: 'T', ...options })).tags[0].attrs.style;
  assert.ok(width > 300);
  assert.equal(styleOf({}), `max-width:${width}px;height:auto`);
  assert.equal(styleOf({ maxWidth: 300 }), 'max-width:300px;height:auto');
  assert.equal(styleOf({ maxWidth: width + 500 }), `max-width:${width}px;height:auto`);
  assert.throws(() => toSvg(graph, { title: 'T', maxWidth: '300px' }), /maxWidth/);
  assert.throws(() => toSvg(graph, { title: 'T', maxWidth: -1 }), /maxWidth/);
});

test('the svg holds no script, no foreign object, no link and no address', () => {
  for (const [name, graph] of samples()) {
    const svg = toSvg(graph, { title: `Flow of ${name}`, maxWidth: 720 });
    for (const pattern of [/<\/?script/i, /foreignObject/i, /href/i, /http/i, /url\(/i, /<style/i, /<image/i, /<use/i, /@import/i, /javascript:/i, /\son[a-z]+\s*=/i]) {
      assert.ok(!pattern.test(svg), `${name}: the svg contains ${pattern}`);
    }
    const { tags } = parseSvg(svg);
    assert.deepEqual([...new Set(tags.map((tag) => tag.name))].sort(), TAGS, name);
    for (const tag of tags) {
      for (const attribute of Object.keys(tag.attrs)) assert.ok(ATTRIBUTES.has(attribute), `<${tag.name}> has the attribute ${attribute}`);
      if ('style' in tag.attrs) {
        assert.equal(tag.name, 'svg', 'only the root carries a style attribute');
        assert.match(tag.attrs.style, /^max-width:\d+px;height:auto$/, 'the style attribute holds a number and nothing that could be an address');
      }
    }
  }
});

test('labels, ids and titles that look like markup come out as inert text', () => {
  const hostile = [
    '</text><script>alert(1)</script>',
    '" onload="alert(1)',
    "' onmouseover='alert(1)",
    '<foreignObject><img src=x onerror=alert(1)>',
    '&lt;b&gt; &amp; ]]> <!-- x -->',
    'javascript:alert(1)',
  ];
  const short = ['</text>', '"x" onload=', '<b>&amp;', "'><svg>", 'a&b'];
  const graph = {
    nodes: hostile.map((label, index) => ({ id: `"><script>${index}</script>`, label, kind: index % 2 ? 'decision' : 'step' })),
    edges: short.map((label, index) => ({ from: `"><script>${index}</script>`, to: `"><script>${index + 1}</script>`, label })),
  };
  const title = hostile.join(' ');
  const svg = toSvg(graph, { title });
  const { tags, text } = parseSvg(svg);
  assert.deepEqual([...new Set(tags.map((tag) => tag.name))].sort(), TAGS);
  for (const tag of tags) {
    for (const attribute of Object.keys(tag.attrs)) assert.ok(ATTRIBUTES.has(attribute), `<${tag.name}> has the attribute ${attribute}`);
  }
  assert.ok(!/<script|<foreignObject|<img|<svg[^ ]/i.test(svg));
  assert.equal(plainText(tags[0].attrs['aria-label']), title);
  assert.ok(svg.includes('&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(svg.includes('&quot; onload=&quot;alert(1)'));
  const seen = plainText(text).replace(/\s+/g, '');
  for (const label of [...hostile, ...short]) assert.ok(seen.includes(label.replace(/\s+/g, '')), `the reader does not see: ${label}`);
  assert.deepEqual(
    tags.filter((tag) => 'data-node' in tag.attrs).map((tag) => plainText(tag.attrs['data-node'])),
    graph.nodes.map((node) => node.id),
  );

  // Control characters cannot be written into a page; a line break inside a label is a space.
  const control = toSvg(
    { nodes: [{ id: 'a', label: 'bell\u0007 nul\u0000 escape\u001b\nnext line', kind: 'step' }], edges: [] },
    { title: 'tab\there\u0000' },
  );
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(control), 'a control character reached the svg');
  assert.ok(control.includes('<title>tab here</title>'));
  assert.ok(parseSvg(control).text.replace(/\s+/g, ' ').includes('bell nul escape next line'));
});

test('colours come from custom properties with fallbacks and from currentColor', () => {
  const paint = /^(none|currentColor|var\(--[a-z][a-z0-9-]*, (none|currentColor|#[0-9a-f]{3,6})\))$/;
  for (const [name, graph] of samples()) {
    const svg = toSvg(graph, { title: name });
    const { tags } = parseSvg(svg);
    let painted = 0;
    for (const tag of tags) {
      for (const attribute of ['fill', 'stroke']) {
        if (!(attribute in tag.attrs)) continue;
        painted += 1;
        assert.match(tag.attrs[attribute], paint, `${name}: <${tag.name} ${attribute}>`);
      }
    }
    assert.ok(painted > 5);
    assert.ok(svg.includes('currentColor') && svg.includes('var(--'), name);
    assert.ok(!/\bcolor\s*=|rgb\(|hsl\(/i.test(svg), name);
  }
});

test('no two boxes overlap, and the drawing stays inside its view box', () => {
  for (const [name, graph] of samples()) {
    const layout = layoutGraph(graph);
    assert.equal(layout.nodes.length, graph.nodes.length, name);
    layout.nodes.forEach((a, index) => {
      assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.width <= layout.width && a.y + a.height <= layout.height, `${name}: ${a.id} leaves the view box`);
      for (const b of layout.nodes.slice(index + 1)) {
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        assert.ok(apart, `${name}: ${a.id} and ${b.id} overlap`);
      }
    });
    // The rectangles in the svg are the rectangles that were computed.
    const { tags } = parseSvg(toSvg(graph, { title: name }));
    for (const node of layout.nodes.filter((entry) => entry.kind !== 'decision')) {
      const group = tags.find((tag) => tag.attrs['data-node'] === node.id);
      const rect = tags.find((tag) => tag.name === 'rect' && tag.parent === group);
      assert.ok(rect, `${name}: ${node.id} has no rectangle`);
      for (const side of ['x', 'y', 'width', 'height']) assert.ok(same(Number(rect.attrs[side]), node[side]), `${name}: ${node.id} ${side}`);
    }
  }
});

test('every edge starts on its source node and ends on its target node', () => {
  for (const [name, graph] of samples()) {
    const layout = layoutGraph(graph);
    assert.equal(layout.edges.length, graph.edges.length, name);
    const { tags } = parseSvg(toSvg(graph, { title: name }));
    const drawn = tags.filter((tag) => tag.name === 'path' && 'data-from' in tag.attrs);
    assert.equal(drawn.length, graph.edges.length, `${name}: every edge is drawn once`);
    layout.edges.forEach((edge, index) => {
      assert.deepEqual([edge.from, edge.to], [graph.edges[index].from, graph.edges[index].to]);
      const what = `${name}: ${edge.from} -> ${edge.to}`;
      assert.ok(onBorder(edge.points[0], boxOf(layout, edge.from)), `${what} does not start on its source`);
      assert.ok(onBorder(edge.points.at(-1), boxOf(layout, edge.to)), `${what} does not end on its target`);
      assert.deepEqual([drawn[index].attrs['data-from'], drawn[index].attrs['data-to']], [edge.from, edge.to]);
      const [x, y] = /^M(-?[\d.]+) (-?[\d.]+)/.exec(drawn[index].attrs.d).slice(1).map(Number);
      assert.ok(same(x, edge.points[0][0]) && same(y, edge.points[0][1]), `${what}: the drawn line starts elsewhere`);
      for (const [px, py] of edge.points) assert.ok(px >= 0 && px <= layout.width && py >= 0 && py <= layout.height, `${what} leaves the view box`);

      // No edge runs through a box. A direct edge stays in the gap between its two rows; a lane
      // is made of level and upright runs, and each of them passes every box.
      const [source, target] = [boxOf(layout, edge.from), boxOf(layout, edge.to)];
      if (edge.route === 'direct') {
        for (const [, py] of edge.points) assert.ok(py >= source.y + source.height - 0.01 && py <= target.y + 0.01, `${what} leaves the gap between its rows`);
      }
      if (edge.route !== 'lane') return;
      for (let step = 1; step < edge.points.length; step += 1) {
        const [x1, y1] = edge.points[step - 1];
        const [x2, y2] = edge.points[step];
        assert.ok(same(x1, x2) || same(y1, y2), `${what}: a run of the lane is neither level nor upright`);
        for (const node of layout.nodes) {
          const clear =
            Math.max(x1, x2) <= node.x + 0.01 || Math.min(x1, x2) >= node.x + node.width - 0.01 || Math.max(y1, y2) <= node.y + 0.01 || Math.min(y1, y2) >= node.y + node.height - 0.01;
          assert.ok(clear, `${what} runs through ${node.id}`);
        }
      }
    });
    // Two lanes never share a level run, unless they lead into the same node.
    const runs = layout.edges
      .filter((edge) => edge.route === 'lane')
      .flatMap((edge) => [1, 3].map((step) => ({ to: edge.to, y: edge.points[step][1], from: Math.min(edge.points[step][0], edge.points[step + 1][0]), until: Math.max(edge.points[step][0], edge.points[step + 1][0]) })));
    runs.forEach((a, index) => {
      for (const b of runs.slice(index + 1)) {
        assert.ok(a.to === b.to || !same(a.y, b.y) || a.until <= b.from || b.until <= a.from, `${name}: two lanes into ${a.to} and ${b.to} share a run`);
      }
    });
  }
});

test('an edge label stands clear of every box, of every lane and of the other labels', () => {
  const labelBox = (edge) => {
    const width = textUnits(edge.label) * SVG_METRICS.edgeCharWidth;
    const x = edge.labelAt.x - { start: 0, middle: width / 2, end: width }[edge.labelAt.anchor];
    return { x, y: edge.labelAt.y - 9, width, height: 12 };
  };
  const apart = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  let labels = 0;
  for (const [name, graph] of samples()) {
    const layout = layoutGraph(graph);
    const labelled = layout.edges.filter((edge) => edge.label !== null);
    assert.equal(labelled.length, graph.edges.filter((edge) => edge.label).length, name);
    labels += labelled.length;
    labelled.forEach((edge, index) => {
      const box = labelBox(edge);
      const what = `${name}: the label of ${edge.from} -> ${edge.to}`;
      assert.ok(textUnits(edge.label) <= SVG_METRICS.edgeLabelUnits, `${what} is too long`);
      assert.ok(box.x >= 0 && box.x + box.width <= layout.width && box.y >= 0 && box.y + box.height <= layout.height, `${what} leaves the view box`);
      for (const node of layout.nodes) assert.ok(apart(box, node), `${what} stands on ${node.id}`);
      for (const other of labelled.slice(index + 1)) assert.ok(apart(box, labelBox(other)), `${what} stands on the label of ${other.from} -> ${other.to}`);
      for (const lane of layout.edges.filter((entry) => entry.route === 'lane')) {
        const [top, bottom] = [lane.points[2], lane.points[3]];
        assert.ok(apart(box, { x: top[0], y: top[1], width: 0.01, height: bottom[1] - top[1] }), `${what} stands on the lane of ${lane.from} -> ${lane.to}`);
      }
      // A label is never on its own line: beside an upright one, above the middle of a curve.
      if (edge.route !== 'direct') return;
      const [start, , , end] = edge.points;
      const middle = (edge.points[1][1] + edge.points[2][1]) / 2;
      assert.ok(box.x > Math.max(start[0], end[0]) || box.y + box.height <= middle, `${what} stands on its own edge`);
    });
  }
  assert.ok(labels > 30);
});

test('branches that stop are led to the end outside the boxes, on the side they are on', () => {
  const flow = extractFlow(stopping);
  assert.deepEqual(arrows(flow), [
    'start -> s1',
    's1 -> s2',
    's2 -yes-> s2y',
    's2y -> end',
    's2 -no-> s2n',
    's2n -> s3',
    's3 -yes-> s3y',
    's3y -> s4',
    's3 -no-> s3n',
    's3n -> end',
    's4 -no-> s4n',
    's4n -> end',
    's4 -yes-> s4y',
    's4y -> s5',
    's5 -> s6',
    's5 -> end',
    's6 -> end',
  ]);
  const layout = layoutGraph(flow);
  const edge = (from, to, where = layout) => where.edges.find((entry) => entry.from === from && entry.to === to);
  const edges = (where) => [Math.min(...where.nodes.map((node) => node.x)), Math.max(...where.nodes.map((node) => node.x + node.width))];
  const reach = (from, to, where) => edge(from, to, where).points.map((point) => point[0]);
  const stops = ['s2y', 's3n', 's4n', 's5'];
  for (const from of stops) {
    assert.equal(edge(from, 'end').route, 'lane');
    assert.ok(Math.max(...reach(from, 'end')) > edges(layout)[1], `${from} goes down the right side`);
  }
  assert.equal(new Set(stops.map((from) => Math.max(...reach(from, 'end')))).size, 1, 'edges into one node share a lane');
  assert.equal(edge('s5', 's6').route, 'direct');
  // A branch that is the only way onward is a step of the flow: it stays on the spine.
  for (const id of ['s2n', 's3y', 's4y', 's6', 'end']) assert.ok(same(centreX(boxOf(layout, id)), centreX(boxOf(layout, 'start'))), `${id} is off the spine`);
  for (const id of ['s2y', 's3n', 's4n']) assert.ok(boxOf(layout, id).x > centreX(boxOf(layout, 'start')), `${id} is not beside its decision`);

  // The second branch box of a decision is on the left, and so is its way down.
  const both = layoutGraph(twoSided);
  assert.ok(Math.max(...reach('right', 'bottom', both)) > edges(both)[1]);
  assert.ok(Math.min(...reach('left', 'bottom', both)) < edges(both)[0]);
  assert.ok(boxOf(both, 'left').x + boxOf(both, 'left').width < boxOf(both, 'ask').x);
  for (const entry of both.edges) for (const [x, y] of entry.points) assert.ok(x >= 0 && x <= both.width && y >= 0 && y <= both.height);
});

test('long labels wrap to at most three lines and never leave their box', () => {
  const graph = {
    nodes: [
      { id: 'a', label: 'A label that is long enough to need more than one line inside its box, and then a few more words so that it overflows three', kind: 'step' },
      { id: 'b', label: 'a_very_long_identifier_without_any_space_in_it/that/keeps/going/and/going/and/going/and/going.md', kind: 'step' },
      { id: 'c', label: 'Is this condition, which is long enough to wrap inside a diamond, true for the file that was read?', kind: 'decision' },
      { id: 'd', label: 'WWWWWWWW MMMMMMMM WWWWWWWW MMMMMMMM', kind: 'step' },
      { id: 'e', label: '漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字', kind: 'step' },
      { id: 'f', label: 'short', kind: 'end' },
      { id: 'g', label: 'Fits on two lines, not on one line', kind: 'note' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd', label: 'a label on an edge that is far too long to be shown in full' },
      { from: 'c', to: 'e', label: 'no' },
      { from: 'd', to: 'f' },
      { from: 'e', to: 'f' },
      { from: 'f', to: 'g' },
    ],
  };
  const layout = layoutGraph(graph);
  assert.equal(SVG_METRICS.maxLines, 3);
  for (const node of layout.nodes) {
    assert.ok(node.lines.length >= 1 && node.lines.length <= 3, `${node.id} has ${node.lines.length} lines`);
    const longest = node.kind === 'decision' ? SVG_METRICS.decisionUnits : SVG_METRICS.boxUnits;
    for (const line of node.lines) {
      assert.ok(textUnits(line) <= longest, `${node.id}: "${line}" is longer than a line may be`);
      assert.ok(textUnits(line) * SVG_METRICS.charWidth <= node.textWidth + 1e-6, `${node.id}: "${line}" is wider than its box`);
    }
    assert.ok(node.lines.length * SVG_METRICS.lineHeight <= node.textHeight + 1e-6, `${node.id}: the lines are taller than the box`);
    if (node.kind === 'decision') {
      assert.ok(node.textWidth / node.width + node.textHeight / node.height <= 1 + 1e-6, 'the text of a diamond stays inside its inscribed rectangle');
    } else {
      assert.ok(node.textWidth <= node.width && node.textHeight <= node.height);
    }
  }
  const linesOf = (id) => boxOf(layout, id).lines;
  assert.equal(linesOf('a').length, 3);
  assert.match(linesOf('a')[2], /…$/, 'what does not fit ends in an ellipsis');
  assert.ok(graph.nodes[0].label.startsWith(linesOf('a').join(' ').replace(/…$/, '').trimEnd()));
  assert.equal(linesOf('b').length, 3);
  assert.ok(graph.nodes[1].label.startsWith(linesOf('b').join('').replace(/…$/, '')), 'a word longer than a line is cut, not dropped');
  assert.deepEqual(linesOf('f'), ['short']);
  assert.equal(linesOf('g').length, 2);
  assert.equal(linesOf('c').length, 3);
  assert.ok(textUnits('WWWW') > textUnits('iiii') && textUnits('漢字') >= 4, 'wide characters take more room');

  // What is drawn is the wrapped text, one tspan per line, and the edge label is cut as well.
  const { tags, text } = parseSvg(toSvg(graph, { title: 'Wrapping' }));
  const group = tags.find((tag) => tag.attrs['data-node'] === 'a');
  const label = tags.find((tag) => tag.name === 'text' && tag.parent === group);
  assert.equal(tags.filter((tag) => tag.name === 'tspan' && tag.parent === label).length, 3);
  for (const line of linesOf('a')) assert.ok(text.includes(line));
  assert.ok(!text.includes('far too long to be shown in full'));
  assert.ok(text.includes('a label on an edge'));
});

test('a flow is drawn on one spine: diamonds for decisions, branch boxes in a column to the side', () => {
  const flow = extractFlow(userSkill('image-resize'));
  const layout = layoutGraph(flow);
  const spine = flow.nodes.filter((node) => /^(start|end|s\d+(d\d+)?)$/.test(node.id));
  assert.equal(spine.length, 12);
  spine.forEach((node, index) => {
    assert.ok(same(centreX(boxOf(layout, node.id)), centreX(boxOf(layout, 'start'))), `${node.id} is off the spine`);
    if (index > 0) {
      const above = boxOf(layout, spine[index - 1].id);
      assert.ok(boxOf(layout, node.id).y > above.y + above.height, `${node.id} is not below ${above.id}`);
    }
  });

  // The stated action sits right of its decision and the other branch left of it, on the same row.
  for (const [decision, right, left] of [
    ['s2', 's2y', null],
    ['s3d1', 's3d1y', 's3d1n'],
    ['s4', 's4y', 's4n'],
    ['s5', 's5n', null],
    ['s6d1', 's6d1y', null],
    ['s6d2', 's6d2y', null],
  ]) {
    const diamond = boxOf(layout, decision);
    assert.ok(boxOf(layout, right).x > diamond.x + diamond.width, `${right} is not right of ${decision}`);
    assert.ok(same(centreY(boxOf(layout, right)), centreY(diamond)), `${right} is not on the row of ${decision}`);
    if (!left) continue;
    assert.ok(boxOf(layout, left).x + boxOf(layout, left).width < diamond.x, `${left} is not left of ${decision}`);
    assert.ok(same(centreY(boxOf(layout, left)), centreY(diamond)));
  }
  assert.equal(new Set(['s2y', 's3d1y', 's4y', 's5n', 's6d1y', 's6d2y'].map((id) => boxOf(layout, id).x)).size, 1, 'one column to the right');
  assert.equal(new Set(['s3d1n', 's4n'].map((id) => boxOf(layout, id).x + boxOf(layout, id).width)).size, 1, 'one column to the left');

  // Arrows out are labelled and level; arrows back reach the join; a stop runs outside every box.
  const edge = (from, to) => layout.edges.find((entry) => entry.from === from && entry.to === to);
  assert.deepEqual([edge('s4', 's4y').route, edge('s4', 's4y').label, edge('s4', 's4n').label], ['side', 'yes', 'no']);
  assert.ok(same(edge('s4', 's4y').points[0][1], edge('s4', 's4y').points.at(-1)[1]));
  assert.equal(edge('s4y', 's5').route, 'direct');
  assert.equal(edge('s2', 's3').label, 'no');
  const stop = edge('s2y', 'end');
  assert.equal(stop.route, 'lane');
  const rightmost = Math.max(...layout.nodes.map((node) => node.x + node.width));
  assert.ok(Math.max(...stop.points.map((point) => point[0])) > rightmost, 'the way to the end runs outside the boxes');

  // In the svg a decision is a path with four corners, every other node a rectangle.
  const { tags } = parseSvg(toSvg(flow, { title: 'Image resize' }));
  for (const node of flow.nodes) {
    const group = tags.find((tag) => tag.attrs['data-node'] === node.id);
    assert.equal(group.attrs['data-kind'], node.kind);
    const shape = tags.find((tag) => tag.parent === group && tag.name !== 'text');
    assert.equal(shape.name, node.kind === 'decision' ? 'path' : 'rect', node.id);
    if (node.kind === 'decision') assert.match(shape.attrs.d, /^M[-\d. ]+(L[-\d. ]+){3}Z$/);
  }
});

test('a general graph: ranks by longest path, order inside a rank by insertion, every node drawn once', () => {
  const layout = layoutGraph(setup);
  const row = (id) => centreY(boxOf(layout, id));
  for (const id of ['project', 'local']) assert.ok(same(row(id), row('user')), `${id} is a root`);
  for (const id of ['imports', 'skills']) assert.ok(same(row(id), row('rules')), `${id} shares a rank with rules`);
  assert.ok(row('user') < row('session') && row('session') < row('rules'));
  for (const rank of [['user', 'project', 'local'], ['rules', 'imports', 'skills']]) {
    const xs = rank.map((id) => boxOf(layout, id).x);
    assert.deepEqual([...xs].sort((a, b) => a - b), xs, `${rank.join(', ')} keep the order they were given in`);
  }
  assert.ok(same(centreX(boxOf(layout, 'session')), centreX(boxOf(layout, 'project'))), 'a rank is centred');

  // A node reached over a long and a short path sits below the long one.
  const diamond = layoutGraph({
    nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, kind: 'step' })),
    edges: [
      { from: 'a', to: 'd' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
    ],
  });
  assert.ok(centreY(boxOf(diamond, 'd')) > centreY(boxOf(diamond, 'c')));

  // The edge that skips a rank runs around the boxes: out to the right of all of them.
  const skip = layout.edges.find((edge) => edge.from === 'user' && edge.to === 'skills');
  assert.equal(skip.route, 'lane');
  assert.equal(skip.label, 'user skills');
  assert.ok(Math.max(...skip.points.map((point) => point[0])) > Math.max(...layout.nodes.map((node) => node.x + node.width)));
  assert.deepEqual(
    layout.edges.filter((edge) => edge !== skip).map((edge) => edge.route),
    ['direct', 'direct', 'direct', 'direct', 'direct', 'direct'],
  );

  // Decisions that share a row get no branch boxes beside them: their answers go a row below.
  const plain = layoutGraph(crowded);
  assert.ok(same(centreY(boxOf(plain, 'first')), centreY(boxOf(plain, 'second'))));
  for (const id of ['a', 'b']) assert.ok(boxOf(plain, id).y > boxOf(plain, 'first').y + boxOf(plain, 'first').height, `${id} is a row of its own`);
  assert.ok(boxOf(plain, 'done').y > boxOf(plain, 'a').y + boxOf(plain, 'a').height);
  assert.deepEqual([...new Set(plain.edges.map((edge) => edge.route))].sort(), ['direct', 'lane']);

  const svg = toSvg(setup, { title: 'How the setup loads' });
  const { tags, text } = parseSvg(svg);
  assert.deepEqual(
    tags.filter((tag) => 'data-node' in tag.attrs).map((tag) => tag.attrs['data-node']),
    setup.nodes.map((node) => node.id),
  );
  for (const node of setup.nodes) assert.equal(text.split(node.label).length - 1, 1, `"${node.label}" is drawn once`);
  for (const label of ['on demand', 'user skills']) assert.ok(text.includes(label));
});

test('a graph that cannot be drawn is refused with the reason', () => {
  const node = (id, kind = 'step') => ({ id, label: id, kind });
  const options = { title: 'T' };
  assert.throws(() => toSvg({ nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }, options), /cycle/);
  assert.throws(() => toSvg({ nodes: [node('a')], edges: [{ from: 'a', to: 'a' }] }, options), /cycle/);
  assert.throws(() => toSvg({ nodes: [node('a')], edges: [{ from: 'a', to: 'gone' }] }, options), /"gone", which the graph does not have/);
  assert.throws(() => toSvg({ nodes: [node('a'), node('a')], edges: [] }, options), /two nodes with the id "a"/);
  assert.throws(() => toSvg({ nodes: [node('a', 'bubble')], edges: [] }, options), /unknown kind "bubble"/);
  assert.throws(() => toSvg({ nodes: [node('a')], edges: [] }), /title/);
  assert.throws(() => toSvg({ nodes: [node('a')], edges: [] }, { title: '  ' }), /title/);
  assert.throws(() => toMermaid({ nodes: [node('a', 'bubble')], edges: [] }), /unknown kind "bubble"/);
});
