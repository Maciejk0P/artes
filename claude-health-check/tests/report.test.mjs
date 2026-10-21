import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { checksAfterReading } from './helpers/console.mjs';
import { load, materialise, runJson, runScript } from './helpers/fixtures.mjs';
import { assertSelfContained, closedDetailsDepth, parseHtml } from './helpers/html.mjs';

const { CANDIDATE_CHECKS, runChecks } = await load('checks.mjs');
const { buildView } = await load('lib/view.mjs');
const { VISIBLE, renderAfter, renderAfterView, renderState, renderStateView } = await load('report.mjs');
const { scan } = await load('scan.mjs');

let main;
let clean;
let flows;
let mainScan;
let mainChecks;

before(() => {
  main = materialise('main');
  clean = materialise('clean');
  flows = materialise('flows');
  mainScan = scan({ home: main.home, projects: [main.projects] });
  mainChecks = runChecks(mainScan);
});
after(() => {
  main.cleanup();
  clean.cleanup();
  flows.cleanup();
});

const decode = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

// The text inside an element, with the text of everything nested in it.
function textOf(page, element) {
  const start = page.elements.indexOf(element);
  let text = element.text;
  for (let index = start + 1; index < page.elements.length && page.elements[index].ancestors.includes(element); index += 1) {
    text += ` ${page.elements[index].text}`;
  }
  return decode(text).replace(/\s+/g, ' ').trim();
}
const withClass = (page, name) => page.elements.filter((element) => element.classes.includes(name));
const inside = (page, element, predicate) => page.elements.filter((other) => other.ancestors.includes(element) && predicate(other));
const visible = (element) => closedDetailsDepth(element) === 0;
const headings = (page) => page.elements.filter((element) => element.name === 'h2').map((element) => textOf(page, element));

function assertEscaped(html) {
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), 'the fixture line is not escaped');
  assert.ok(!html.includes('<script>alert'), 'a fixture line reached the page unescaped');
}

test('state report is one self-contained page with every piece of content escaped', () => {
  const html = renderState({ scan: mainScan, checks: mainChecks, lang: 'en' });
  assertSelfContained(html);
  assertEscaped(html);
  assert.match(html, /<html lang="en">/);
  assert.ok(!html.includes('FIXTURE-SECRET-VALUE'));
  // The page is drawn from the view and from nothing else.
  const now = new Date('2026-10-01T10:00:00.000Z');
  const view = buildView({ scan: mainScan, checks: mainChecks, lang: 'en', now });
  assert.equal(renderState({ scan: mainScan, checks: mainChecks, lang: 'en', now }), renderStateView(view));
  assert.equal(renderStateView(JSON.parse(JSON.stringify(view))), renderStateView(view), 'a view that went through a file draws the same page');
});

test('the self-contained check reads structure: it catches a real script, link, handler or address', () => {
  const html = renderState({ scan: mainScan, checks: mainChecks, lang: 'en' });
  const broken = (change, pattern) => assert.throws(() => assertSelfContained(change(html)), pattern);
  broken((page) => page.replace('<main>', '<main><script>alert(1)</script>'), /<script>/);
  broken((page) => page.replace('<main>', '<main><img src="x">'), /<img>/);
  broken((page) => page.replace('<main>', '<main><p onclick="go()">x</p>'), /attribute onclick/);
  broken((page) => page.replace('<main>', '<main><a href="https://example.test/">x</a>'), /a link leaves the page/);
  broken((page) => page.replace('<main>', '<main><p style="background:url(x)">x</p>'), /style attribute holds more than a size/);
  broken((page) => page.replace('<style>', '<style>@import "x.css";'), /stylesheet contains/);
  broken((page) => page.replace('<style>', '<style>body{background:url(x.png)}'), /stylesheet contains/);
  broken((page) => page.replace('</head>', '<link rel="stylesheet" href="x.css"></head>'), /<link>/);
  broken((page) => page.replace('<main>', '<main><p>a < b</p>'), /not escaped/);
  broken((page) => page.replace('<main>', '<main><iframe></iframe>'), /<iframe>/);
});

test('text that looks like markup, an event handler or an address stays text, wherever it comes from', (t) => {
  const local = materialise('clean');
  t.after(() => local.cleanup());
  const write = (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const hostile = [
    'Add <img src=x onerror=alert(1)> to the page.',
    'If the tag has onload="go()" set, remove url(javascript:alert(1)) from its style. Otherwise write </svg></details><script>alert(2)</script> into the log.',
    'Open <a href="https://example.test/x">the link</a> and @import "evil.css".',
    'Set style="background:url(//example.test/x.png)" on the <body onpageshow=x()>.',
  ];
  write(
    path.join(local.home, '.claude', 'skills', 'markup-skill', 'SKILL.md'),
    `---\nname: markup-skill\ndescription: Edits <script src="//example.test/a.js"></script> tags. Use when onclick="x()" appears.\n---\n\n${hostile.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n`,
  );
  write(
    path.join(local.home, '.claude', 'CLAUDE.md'),
    [
      '# Rules <b onmouseover="x()">',
      '',
      '- Never write <link rel="stylesheet" href="//example.test/x.css"> into a page, unless url(data:x) or @import "x.css" is allowed.',
      '- Always run `curl "https://example.test/?a=1&b=<2>"` before committing.',
      '- When I say "<svg onload=alert(1)>", answer with javascript:alert(1).',
      '',
    ].join('\n'),
  );
  write(path.join(local.project('tidy-app'), '.mcp.json'), JSON.stringify({ mcpServers: { '<img src=x onerror=1>': { command: 'x' } } }));
  write(path.join(local.home, '.claude', 'settings.local.json'), '{ "hooks": { "<On onclick=x>": [ ] } }');

  const result = scan({ home: local.home, projects: [local.projects] });
  const checks = runChecks(result);
  const judged = runChecks(result, {
    judgement: [
      {
        title: '<script>title</script>',
        severity: 'low',
        file: `${local.home}/.claude/CLAUDE.md`,
        line: 1,
        quote: '# Rules <b onmouseover="x()">',
        message: 'message with onerror="x" and <iframe src=//example.test>',
        why: 'why url(x)',
        kind: 'shorten',
        detail: 'detail <a href="//example.test">',
      },
    ],
  });
  for (const lang of ['en', 'sk']) {
    const html = renderState({ scan: result, checks: lang === 'en' ? judged : runChecks(result, { lang }), lang });
    const page = assertSelfContained(html);
    // The old way of checking, a search over the whole page, would have failed on this page for
    // text that is harmless: that is why the check reads structure.
    for (const pattern of [/\bsrc\s*=/i, /\son[a-z]+\s*=/i, /url\(/i, /@import/i]) {
      assert.ok(pattern.test(html), `the page does not even contain ${pattern} as text, so this test proves nothing`);
    }
    assert.ok(!/<script|<img|<iframe|<link|<a href="h|<body on|<b on/i.test(html), 'markup from a scanned file became markup of the page');
    assert.deepEqual([...new Set(page.elements.map((element) => element.name))].filter((name) => ['script', 'img', 'iframe', 'link', 'b', 'object'].includes(name)), []);
    // What the reader sees is the text as it was written.
    const seen = decode(page.text).replace(/\s+/g, ' ');
    assert.ok(seen.includes('<link rel="stylesheet" href="//example.test/x.css">'), 'a quoted line is not shown as written');
    assert.ok(seen.includes('<img src=x onerror=1>'), 'the server name is not shown as written');
    if (lang === 'en') assert.ok(seen.includes('<script>title</script>: message with onerror="x" and <iframe src=//example.test>'));
    const skill = withClass(page, 'skill').find((element) => element.attrs['data-skill'] === 'markup-skill');
    const diagram = inside(page, skill, (element) => element.name === 'svg');
    assert.equal(diagram.length, 1, 'the steps of the skill are drawn');
    const drawn = decode(inside(page, skill, (element) => element.name === 'tspan').map((element) => element.text).join(' '));
    assert.ok(drawn.includes('<img') && drawn.includes('onerror=alert(1)>'), 'the label of a step is not shown as written');
    const source = textOf(page, inside(page, skill, (element) => element.name === 'pre' && element.classes.includes('source'))[0]);
    assert.match(source, /^flowchart TD/);
    assert.ok(source.includes('#60;img src=x onerror=alert#40;1#41;#62;'), 'the Mermaid source keeps the text as entities, never as syntax');
  }
  assert.equal(checks.review[0].servers[0], '<img src=x onerror=1>');
});

test('state report: tiles, the load diagram on top, the tables, findings, candidates, review items and skills', () => {
  const html = renderState({ scan: mainScan, checks: mainChecks, lang: 'en' });
  const page = parseHtml(html);
  assert.deepEqual(headings(page), [
    'How this setup loads',
    'Loaded at the start of every session',
    'Context tax',
    'Memory files',
    'Findings',
    'Candidates',
    'To review',
    'Skills',
    'Also in this setup',
    'Suggested changes, file by file',
    'Scan notes',
    'Numbers and where they come from',
  ]);

  // The first thing after the tiles is the diagram of how the costliest place loads.
  const firstDiagram = page.elements.find((element) => element.name === 'svg');
  assert.equal(decode(firstDiagram.attrs['aria-label']), 'How the setup loads in alpha-service');
  assert.ok(visible(firstDiagram));
  const firstTable = page.elements.find((element) => element.name === 'table');
  assert.ok(page.elements.indexOf(firstDiagram) < page.elements.indexOf(firstTable), 'the load diagram is not on top');
  const loadDiagrams = page.elements.filter((element) => element.name === 'svg' && /^How the setup loads/.test(decode(element.attrs['aria-label'])));
  assert.equal(loadDiagrams.length, 3, 'one diagram per place');
  assert.equal(loadDiagrams.filter(visible).length, 1, 'only the costliest place is drawn open');
  assert.match(html, /User memory · 238/);

  assert.match(html, /Files scanned/);
  assert.match(html, /459 of 400 lines · over/);
  assert.match(html, /238 of 200 lines/);
  assert.match(html, /Recommended: under 200 lines per file/);
  assert.ok(html.includes('https://code.claude.com/docs/en/memory.md'), 'the source of the number is shown as text');
  assert.match(html, /≈ 7,104 tokens/);
  assert.match(html, /Tokens are estimated as bytes \/ 4: a default of this tool, not a documented number\./);
  assert.match(html, /Descriptions of agents are not counted\./);
  assert.match(html, /~\/\.claude\/CLAUDE\.md:22/);
  assert.match(html, /git push --force/);
  assert.match(html, /Delete the duplicate/);

  for (const finding of mainChecks.findings) assert.ok(html.includes(`id="${finding.id}"`), `finding ${finding.id} is missing`);
  const rows = withClass(page, 'finding');
  assert.equal(rows.length, mainChecks.findings.length);
  assert.equal(withClass(page, 'finding-body').length, mainChecks.findings.length);
  const high = mainChecks.metrics.findings.high;
  assert.match(html, new RegExp(`<span class="value">${high}</span>`));

  // Candidates: one closed section, each with its quote, none of them among the findings.
  const [section] = withClass(page, 'candidates');
  assert.equal(section.name, 'details');
  assert.equal('open' in section.attrs, false);
  assert.match(textOf(page, inside(page, section, (element) => element.name === 'summary')[0]), /^Candidates found by words only: 15\. Claude reads them next\.$/);
  const candidates = withClass(page, 'candidate');
  assert.deepEqual(candidates.map((element) => element.attrs.id).sort(), mainChecks.candidates.map((candidate) => candidate.id).sort());
  assert.ok(candidates.every((element) => element.ancestors.includes(section) && !visible(element)));
  assert.ok(rows.every((element) => !element.ancestors.includes(section)));
  assert.match(textOf(page, section), /Pairs found by shared words: 1\. None compared yet\./);
  assert.match(textOf(page, section), /A candidate is not a finding/);
  assert.ok(!rows.some((element) => CANDIDATE_CHECKS.includes(element.attrs['data-check'])), 'something found by wording stands among the findings');
  // What word matching suggests is asked, in the closed section: the page states none of it as a fact.
  assert.match(textOf(page, section), /This line may be a rule that carries an exception/);
  assert.ok(!/This rule carries an exception|This line forbids running|is about one project|maps something you say|each one an action|does not say when to use/.test(decode(page.text)), 'a candidate is worded as a finding');

  assert.match(html, /MCP servers without a permission rule/);
  assert.match(html, /No permission rule names these servers of alpha-service: tracker, search\./);
  assert.match(html, /Nothing here needs to change\./);
  assert.match(html, /Loaded on demand, not at session start: 1 nested memory file\(s\), 1 rule file\(s\) with a paths pattern\./);
  assert.ok(!/allow rule|bypassPermissions|\.gitignore/.test(html), 'the report speaks about something the owner asked to leave out');

  // The suggested changes, file by file: one group per file, in the order the wizard walks them.
  const [changes] = page.elements.filter((element) => element.name === 'section' && element.classes.includes('changes'));
  const files = withClass(page, 'change-file');
  assert.equal(files.length, 13);
  assert.ok(files.every((element) => element.name === 'details' && element.ancestors.includes(changes)));
  assert.deepEqual(files.filter((element) => 'open' in element.attrs).length, VISIBLE.openGroups, 'only the first files start open');
  const first = textOf(page, inside(page, files[0], (element) => element.name === 'summary')[0]);
  assert.equal(first, 'File 1 of 13 ~/.claude/CLAUDE.md memory · 238 lines Suggested changes: 4 (Move into a rule file · Delete the duplicate · Shorten ×2)');
  const changeRows = inside(page, files[0], (element) => element.name === 'li').map((element) => textOf(page, element));
  assert.equal(changeRows.length, 4);
  assert.match(changeRows[0], /^1 ~\/\.claude\/CLAUDE\.md Medium Move into a rule file · /);
  assert.match(changeRows[1], /^2 ~\/\.claude\/CLAUDE\.md:10 Low Delete the duplicate · The same instruction is already on line 8 of this file\.$/);
  assert.match(textOf(page, files.at(-1)), /^File 13 of 13 alpha-service\/\.claude\/skills\/shared-skill\/SKILL\.md skill · 6 lines Suggested changes: 1 \(Delete the duplicate\) 18 /);
  const settings = files.find((element) => element.attrs['data-file'].endsWith('/.claude/settings.local.json'));
  assert.match(textOf(page, settings), /^File 11 of 13 ~\/\.claude\/settings\.local\.json local settings Suggested changes: 1 /, 'a file without a line count says none');
  assert.match(textOf(page, changes), /^The wizard goes through them in this order: your user memory file first, then your other user files, then each project; inside a file from the top down\./);
  // Every row links to its finding above.
  const links = inside(page, changes, (element) => element.name === 'a').map((element) => element.attrs.href);
  assert.deepEqual([...links].sort(), mainChecks.findings.map((finding) => `#${finding.id}`).sort());
});

test('findings are grouped by severity and kind, and collapsed beyond the first few', () => {
  const html = renderState({ scan: mainScan, checks: mainChecks, lang: 'en' });
  const page = parseHtml(html);
  const groups = withClass(page, 'group').filter((element) => 'data-check' in element.attrs);
  assert.equal(groups.length, 18, 'one group per severity and kind');
  assert.deepEqual(groups.slice(0, 4).map((element) => [element.attrs['data-check'], 'open' in element.attrs]), [
    ['settings-invalid-json', true],
    ['always-loaded-total', true],
    ['import-unresolved', true],
    ['memory-too-long', false],
  ]);
  assert.equal(groups.filter((element) => 'open' in element.attrs).length, VISIBLE.openGroups);
  const rows = withClass(page, 'finding');
  assert.equal(rows.filter(visible).length, 3, 'three open groups with one finding each');
  // Only a high-severity finding starts with its quote and reason open.
  assert.deepEqual(rows.filter((element) => 'open' in element.attrs).map((element) => element.attrs['data-severity']), ['high']);
  assert.equal(withClass(page, 'finding-body').filter(visible).length, 1);

  // A group shows its first rows; the rest sit behind one "more" line. Four lines that a reader
  // confirmed under one title are such a group.
  const judgedPage = parseHtml(renderState({ scan: mainScan, checks: checksAfterReading(mainScan, { exception: 'low' }), lang: 'en' }));
  const exceptions = withClass(judgedPage, 'group').find((element) => /^exception \(4\)/.test(textOf(judgedPage, element)));
  assert.equal(exceptions.attrs['data-check'], 'judgement');
  const inGroup = inside(judgedPage, exceptions, (element) => element.classes.includes('finding'));
  assert.equal(inGroup.length, 4);
  const behindMore = inGroup.filter((element) => element.ancestors.some((ancestor) => ancestor.classes.includes('more')));
  assert.equal(behindMore.length, 4 - VISIBLE.rowsPerGroup);
  const more = inside(judgedPage, exceptions, (element) => element.classes.includes('more'))[0];
  assert.equal(textOf(judgedPage, inside(judgedPage, more, (element) => element.name === 'summary')[0]), '1 more');

  // A finding without a line is a row like any other.
  const total = rows.find((element) => element.attrs['data-check'] === 'always-loaded-total');
  assert.equal(textOf(page, inside(page, total, (element) => element.classes.includes('where'))[0]), '~/.claude/CLAUDE.md');
  assert.equal(inside(page, total, (element) => element.name === 'pre').length, 0, 'there is no line to quote');
});

test('skills are grouped in the report, each a closed row that holds its diagram and the Mermaid source', () => {
  const result = scan({ home: flows.home, projects: [flows.projects] });
  const html = renderState({ scan: result, checks: runChecks(result), lang: 'en' });
  const page = assertSelfContained(html);
  const groups = withClass(page, 'skill-group');
  assert.deepEqual(groups.map((element) => element.attrs['data-group']), ['user', flows.project('sample-app')]);
  assert.equal(textOf(page, inside(page, groups[0], (element) => element.name === 'h3')[0]), 'User skills · ~/.claude/skills (5)');
  assert.equal(textOf(page, inside(page, groups[1], (element) => element.name === 'h3')[0]), `${flows.project('sample-app')} (1)`, 'a project group is headed by the full path');

  const rows = withClass(page, 'skill');
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.equal(row.name, 'details');
    assert.equal('open' in row.attrs, false, 'a skill row starts closed');
    assert.equal(inside(page, row, (element) => element.classes.includes('skill-body')).length, 1);
  }
  const row = (name) => rows.find((element) => element.attrs['data-skill'] === name);
  const linear = row('changelog-notes');
  const [svg] = inside(page, linear, (element) => element.name === 'svg');
  assert.equal(decode(svg.attrs['aria-label']), 'Steps of the skill changelog-notes');
  assert.ok(!visible(svg));
  assert.equal(inside(page, linear, (element) => 'data-node' in element.attrs).length, 8, 'start, six steps, end');
  // The Mermaid source sits in a nested, closed <details>, in a <pre>, for copying.
  const [source] = inside(page, linear, (element) => element.name === 'pre' && element.classes.includes('source'));
  const holder = source.ancestors.at(-1);
  assert.deepEqual([holder.name, holder.classes.includes('mermaid'), 'open' in holder.attrs, holder.ancestors.includes(linear)], ['details', true, false, true]);
  assert.match(textOf(page, source), /^flowchart TD n1\(\["Start"\]\) n2\["Find the tag of the last version with git describe --tags"\]/);
  assert.equal(textOf(page, inside(page, holder, (element) => element.name === 'summary')[0]), 'Mermaid source of this diagram');

  // A row says before it is opened whether there is a diagram inside.
  assert.match(textOf(page, inside(page, linear, (element) => element.name === 'summary')[0]), /^changelog-notes \d+ of 500 lines steps: 6/);
  assert.match(page.css, /details\.skill > summary::before/, 'a row that opens has no mark that says so');
  const none = row('style-notes');
  assert.match(textOf(page, inside(page, none, (element) => element.name === 'summary')[0]), /^style-notes \d+ of 500 lines no steps to draw/);
  assert.equal(inside(page, none, (element) => element.name === 'svg').length, 0);
  assert.match(textOf(page, none), /No recognisable steps: this skill has no numbered list and no "Step N" headings, so no diagram is drawn\./);
  assert.equal(inside(page, row('image-resize'), (element) => element.attrs['data-kind'] === 'decision').length, 6);

  // A project with no skills says so; a third-party skill carries its mark; copies say whether they agree.
  const mainPage = parseHtml(renderState({ scan: mainScan, checks: mainChecks, lang: 'en' }));
  const mainGroups = withClass(mainPage, 'skill-group');
  assert.deepEqual(mainGroups.map((element) => element.attrs['data-group']), ['user', main.project('alpha-service'), main.project('beta-tool')]);
  assert.match(textOf(mainPage, mainGroups[2]), /\(0\) No skills in this project\.$/);
  assert.match(textOf(mainPage, mainGroups[0]), /shared-skill 6 of 500 lines no steps to draw differs from the copy in alpha-service/);
  assert.match(textOf(mainPage, mainGroups[0]), /long-skill 512 of 500 lines · over no steps to draw over the recommended length/);
  // The recommendation for a SKILL.md was not read again on the date the report names, and says so.
  assert.match(decode(mainPage.text).replace(/\s+/g, ' '), /Recommended: under 500 lines per SKILL\.md\. Source: \S+ This number was carried over from the first version of the tool; it was not read again on 2026-10-01\./);
});

test('the report of the field fixture: nested repositories as groups, third-party marks, excluded files, AGENTS.md', (t) => {
  const field = materialise('field');
  t.after(() => field.cleanup());
  const result = scan({ home: field.home, projects: [field.projects], nested: true });
  const page = assertSelfContained(renderState({ scan: result, checks: runChecks(result), lang: 'en' }));
  const all = decode(page.text).replace(/\s+/g, ' ');
  const groups = withClass(page, 'skill-group');
  assert.deepEqual(groups.map((element) => element.attrs['data-group'].replace(`${field.root}/`, '')), [
    'user',
    'projects/agents-only',
    'projects/outer-app',
    'projects/outer-app/clones/inner-kit',
    'projects/outer-app/clones/worktree-kit',
  ]);
  assert.match(textOf(page, groups[3]), /A repository nested in .*outer-app; it is a project of its own\./);
  assert.match(textOf(page, groups[0]), /vendor-skill 8 of 500 lines (no steps to draw|steps: \d+) third-party · do not edit · description may not say when to use it/);
  assert.match(all, /Third-party because its folder holds a licence file\./);
  assert.match(all, /excluded by setting, 12 lines not counted \(pattern \*\*\/\.claude\/shared\/everywhere\.md in outer-app\/\.claude\/settings\.json\)/);
  assert.match(all, /outer-app\/AGENTS\.md \(3 lines\) is not read/);
  assert.match(all, /agents-only\/AGENTS\.md \(4 lines\) is read/);
  assert.match(all, /Nested repository with no Claude Code files, not read: .*plain-repo/);
  assert.match(all, /same as the copy in outer-app/);

  const left = scan({ home: field.home, projects: [field.projects] });
  const without = decode(parseHtml(renderState({ scan: left, checks: runChecks(left), lang: 'en' })).text).replace(/\s+/g, ' ');
  assert.match(without, /Nested repository, left out of this run: .*inner-kit/);
  assert.match(without, /Include them with --nested\./);
  assert.ok(!without.includes('kit-skill'), 'a skill of a nested repository that was left out is listed');
});

test('state report renders in Slovak too', () => {
  const checks = runChecks(mainScan, { lang: 'sk' });
  const html = renderState({ scan: mainScan, checks, lang: 'sk' });
  assertSelfContained(html);
  assertEscaped(html);
  assert.match(html, /<html lang="sk">/);
  assert.match(html, /Nálezy/);
  assert.match(html, /Pamäťové súbory/);
  assert.match(html, /238 z 200 riadkov/);
  assert.match(html, /Kandidáti nájdení len podľa slov: 15\./);
  assert.match(html, /Daň z kontextu/);
  assert.match(html, /Používateľské skilly/);
  assert.match(html, /Začiatok session/);
  assert.ok(!html.includes('Files scanned') && !html.includes('Session start') && !html.includes('User skills'));
  assert.throws(() => renderState({ scan: mainScan, checks, lang: 'de' }), /Unknown language/);
});

test('state report of a clean setup says that nothing needs to change', () => {
  const cleanScan = scan({ home: clean.home, projects: [clean.projects] });
  const html = renderState({ scan: cleanScan, checks: runChecks(cleanScan), lang: 'en' });
  assertSelfContained(html);
  assert.match(html, /Nothing to change\. That is a good result\./);
  assert.match(html, /No candidates: word matching found nothing to read\./);
  assert.match(html, /Nothing to review\./);
  assert.equal(withClass(parseHtml(html), 'finding').length, 0);
});

test('scan notes say when the scan was capped or skipped something', () => {
  const capped = scan({ home: main.home, machine: true, maxDirs: 2 });
  const html = renderState({ scan: capped, checks: runChecks(capped), lang: 'en' });
  assert.match(html, /The scan stopped at a limit: max-dirs = 2/);
  assert.match(html, /home folder searched for projects/);
  assert.ok(!/whole machine/i.test(html), 'only the home folder is searched, so the report does not say "machine"');
  const full = renderState({ scan: mainScan, checks: mainChecks, lang: 'en' });
  assert.match(full, /The scan ran to the end: no limit stopped it/);
  assert.match(full, /Hidden, dependency, cache and system folders are never entered\./);
  assert.ok(!full.includes('home folder searched for projects'));

  const unread = structuredClone(mainScan);
  unread.skipped.push({ path: `${main.home}/.secrets/creds.env`, reason: 'import-outside-scope' }, { path: `${main.home}/x.ts`, reason: 'import-not-text' });
  for (const lang of ['en', 'sk']) {
    const noted = renderState({ scan: unread, checks: runChecks(unread, { lang }), lang });
    assert.ok(noted.includes('.secrets/creds.env') && noted.includes('x.ts'), 'an unread import is listed under the scan notes');
  }
});

function changedSetup(t) {
  const local = materialise('main');
  t.after(() => local.cleanup());
  const scanBefore = scan({ home: local.home, projects: [local.projects] });
  // The reading confirmed the numbered block, the prohibition and the four rules with an exception.
  const checksBefore = checksAfterReading(scanBefore, { exception: 'low', 'procedure-in-memory': 'medium', 'permission-in-prose': 'medium' });
  const find = (check) => checksBefore.findings.find((finding) => (finding.origin ?? finding.check) === check);

  const memory = path.join(local.home, '.claude', 'CLAUDE.md');
  const lines = readFileSync(memory, 'utf8').split('\n');
  lines.splice(28, 5); // the release procedure, lines 29-33
  lines.splice(9, 1); // the duplicated line 10
  writeFileSync(memory, lines.join('\n'));
  const skill = `${local.home}/.claude/skills/release/SKILL.md`;
  mkdirSync(path.dirname(skill), { recursive: true });
  writeFileSync(skill, '---\nname: release\ndescription: Cuts a release. Use when the user asks to release.\n---\n\n1. Run the tests.\n2. If a test fails, stop.\n3. Tag the commit.\n');

  const backup = `${local.home}/.claude/health-check/backup-20260101-120000`;
  const applied = [
    {
      id: find('procedure-in-memory').id,
      kind: 'make-skill',
      status: 'applied',
      files: [`${local.home}/.claude/CLAUDE.md`, skill],
      created: [{ type: 'skill', path: skill }],
      backup,
      at: '2026-01-01T12:00:00.000Z',
    },
    {
      id: find('duplicate-within').id,
      kind: 'delete-duplicate',
      status: 'applied',
      files: [`${local.home}/.claude/CLAUDE.md`],
      created: [],
      backup,
      at: '2026-01-01T12:01:00.000Z',
    },
    { id: find('permission-in-prose').id, kind: 'make-setting', status: 'skipped', files: [], created: [], backup: null, at: '2026-01-01T12:02:00.000Z' },
  ];
  const scanAfter = scan({ home: local.home, projects: [local.projects] });
  return { local, checksBefore, scanAfter, checksAfter: checksAfterReading(scanAfter, { exception: 'low', 'permission-in-prose': 'medium' }), applied, skill, backup };
}

test('after report: lines before and after, what was created, skipped and is still open', (t) => {
  const { checksBefore, scanAfter, checksAfter, applied } = changedSetup(t);
  const html = renderAfter({ before: checksBefore, scan: scanAfter, checks: checksAfter, applied, lang: 'en' });
  const page = assertSelfContained(html);
  assertEscaped(html);
  assert.deepEqual(headings(page), [
    'Where each entry went',
    'Lines before and after',
    'Loaded at the start of every session',
    'Created',
    'File by file: applied, skipped, still open',
    'Next improvements',
    'Skills',
    'How to undo',
    'Scan notes',
  ]);

  assert.match(html, /<td class="num">238<\/td>\s*<td class="num">232<\/td>\s*<td class="num">-6<\/td>/);
  assert.match(html, /<td class="num">462<\/td>\s*<td class="num">456<\/td>\s*<td class="num">-6<\/td>/, 'the total row');

  const section = (title) => {
    const start = html.indexOf(`>${title}</h2>`);
    assert.ok(start !== -1, `section ${title} is missing`);
    const end = html.indexOf('<h2', start + 1);
    return html.slice(start, end === -1 ? undefined : end);
  };
  assert.match(section('Created'), /Skill/);
  assert.match(section('Created'), /~\/\.claude\/skills\/release\/SKILL\.md/);
  // File by file, in the order of the walk: what was applied there, what was skipped, what is open.
  const byFile = section('File by file: applied, skipped, still open');
  const files = withClass(page, 'change-file');
  assert.ok(files.length >= 10 && files.every((element) => element.name === 'details'));
  const memory = files[0];
  assert.equal(memory.attrs['data-file'], `${scanAfter.home}/.claude/CLAUDE.md`);
  assert.equal(textOf(page, inside(page, memory, (element) => element.name === 'summary')[0]), `File 1 of ${files.length} ~/.claude/CLAUDE.md memory · 238 → 232 lines applied 2 · by hand 0 · skipped 1 · still open 8`);
  const part = (element, title) => {
    const html = byFile.slice(byFile.indexOf(`data-file="${element.attrs['data-file']}"`));
    const body = html.slice(0, html.indexOf('data-file="', 20) === -1 ? undefined : html.indexOf('data-file="', 20));
    const start = body.indexOf(`>${title}`);
    assert.ok(start !== -1, `${title} is missing`);
    const end = body.indexOf('<h4', start + 1);
    return body.slice(start, end === -1 ? undefined : end);
  };
  assert.match(part(memory, 'Applied changes'), /~\/\.claude\/CLAUDE\.md:10<\/span> · <strong>Delete the duplicate<\/strong>[\s\S]*~\/\.claude\/CLAUDE\.md:29<\/span> · <strong>Turn into a skill<\/strong>/, 'from the top of the file down');
  assert.match(part(memory, 'Skipped by you'), /git push --force/);
  assert.ok(!part(memory, 'Skipped by you').includes('Publish the package'));
  const open = part(memory, 'Still open');
  assert.ok(!open.includes('Publish the package'), 'the removed procedure is no longer open');
  assert.match(open, /git push --force/);
  assert.match(open, /was there before/);
  assert.equal((byFile.match(/class="finding"/g) ?? []).length, checksAfter.findings.length, 'every open finding stands in the report once');
  const ids = page.elements.map((element) => element.attrs.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'two elements share an id');
  assert.match(part(memory, 'Skipped by you'), /<a href="#judgement-[0-9a-f]+"><span class="where">~\/\.claude\/CLAUDE\.md:22<\/span><\/a> · <strong>Change settings<\/strong>/, 'a skipped change links to its finding, which is still open');
  assert.ok(!byFile.includes('>Applied changes (0)') && !byFile.includes('>Skipped by you (0)'), 'a file says only what happened to it');
  assert.deepEqual(files.filter((element) => 'open' in element.attrs).length, VISIBLE.openGroups);

  const next = section('Next improvements');
  assert.match(next, /still has 232 lines/);
  assert.match(next, /high-severity/);
  assert.match(next, /1 suggested change\(s\) were skipped/);
  assert.ok(!/permissions\.deny/.test(next), 'no opinion about a rule that is not there');
  assert.match(section('How to undo'), /backup-20260101-120000/);
});

test('after report: the diagram of where each entry went, and the steps of every skill that was created', (t) => {
  const { checksBefore, scanAfter, checksAfter, applied } = changedSetup(t);
  const view = buildView({ before: checksBefore, scan: scanAfter, checks: checksAfter, applied, lang: 'en' });
  const page = assertSelfContained(renderAfterView(view));

  const moved = page.elements.find((element) => element.name === 'svg' && decode(element.attrs['aria-label']) === 'Where each entry went');
  assert.ok(visible(moved), 'the moved-entries diagram is drawn open');
  // A label that does not fit one line of its box is wrapped, so the lines are joined before comparing.
  const labels = decode(inside(page, moved, (element) => element.name === 'tspan' || element.name === 'text').map((element) => element.text).join('')).replace(/\s+/g, '');
  for (const text of ['line29of~/.claude/CLAUDE.md', 'line10of~/.claude/CLAUDE.md', 'Duplicatedeleted', 'Skill']) assert.ok(labels.includes(text), `the diagram does not show ${text}`);
  // A wide diagram keeps its size and scrolls sideways inside its frame.
  const canvas = moved.ancestors.at(-1);
  assert.deepEqual([canvas.name, canvas.classes], ['div', ['canvas']]);
  assert.match(canvas.attrs.style, /^min-width:\d+px$/);
  assert.ok(canvas.ancestors.at(-1).classes.includes('diagram'));
  assert.match(page.css, /\.diagram \{ overflow-x: auto;/);
  const source = page.elements.find((element) => element.name === 'pre' && element.classes.includes('source'));
  assert.match(textOf(page, source), /^flowchart TD n1\["line 29 of #126;\/\.claude\/CLAUDE\.md"\]/, 'the Mermaid text writes every character that is not plain as an entity');

  // The flow of the created skill sits in the "Created" section, inside its closed row.
  const createdHeading = page.elements.find((element) => element.name === 'h3' && textOf(page, element) === 'The steps of what was created');
  assert.ok(createdHeading, 'the steps of what was created have no heading');
  const created = withClass(page, 'skill').filter((element) => element.attrs['data-skill'] === 'release');
  assert.equal(created.length, 2, 'once under "Created" and once in the list of skills');
  for (const row of created) {
    const [svg] = inside(page, row, (element) => element.name === 'svg');
    assert.equal(decode(svg.attrs['aria-label']), 'Steps of the skill release');
    assert.equal(inside(page, row, (element) => element.attrs['data-kind'] === 'decision').length, 1);
  }
  assert.equal(withClass(page, 'skill-group').length, 3, 'the second report lists the skills by group as well');

  assert.throws(() => renderAfterView(buildView({ scan: scanAfter, checks: checksAfter, lang: 'en' })), /needs a view built with/);
});

test('after report renders in Slovak and copes with nothing applied', (t) => {
  const { checksBefore, scanAfter, checksAfter, applied } = changedSetup(t);
  const sk = renderAfter({ before: checksBefore, scan: scanAfter, checks: runChecks(scanAfter, { lang: 'sk' }), applied, lang: 'sk' });
  assertSelfContained(sk);
  assert.match(sk, /<html lang="sk">/);
  assert.match(sk, /Riadky pred a po/);
  assert.match(sk, /Ďalšie zlepšenia/);
  assert.match(sk, /Kam sa ktorá položka presunula/);

  const untouched = renderAfter({ before: checksAfter, scan: scanAfter, checks: checksAfter, applied: [], lang: 'en' });
  assertSelfContained(untouched);
  assert.match(untouched, /No change was applied\./);
  assert.match(untouched, /Nothing was created\./);
  assert.match(untouched, /Nothing was skipped\./);
  assert.match(untouched, /No change was applied, so there is nothing to undo\./);
  assert.match(untouched, /No change was applied, so no entry moved\./);
});

test('after report: a change recorded without a backup is not described as "no file was changed"', (t) => {
  const { checksBefore, scanAfter, checksAfter, applied, backup } = changedSetup(t);
  const settings = `${scanAfter.home}/.claude/settings.json`;
  const byHand = (withBackup) => ({
    id: checksBefore.findings.find((finding) => finding.check === 'hook-unknown-event').id,
    kind: 'make-setting',
    status: 'by-hand',
    files: [settings],
    created: [],
    backup: withBackup ? backup : null,
    note: null,
    at: '2026-01-01T12:03:00.000Z',
  });
  const undoOf = (entries, lang = 'en') => {
    const checks = lang === 'en' ? checksAfter : runChecks(scanAfter, { lang });
    const html = renderAfter({ before: checksBefore, scan: scanAfter, checks, applied: entries, lang });
    return html.slice(html.indexOf(lang === 'en' ? '>How to undo</h2>' : '>Ako to vrátiť</h2>'));
  };

  const alone = undoOf([byHand(false)]);
  assert.match(alone, /1 change\(s\) were recorded without a backup folder/);
  assert.ok(!/no file was changed|nothing to undo/i.test(alone));
  assert.ok(!alone.includes('backup-20260101-120000'));

  const mixed = undoOf([...applied, byHand(false)]);
  assert.match(mixed, /backup-20260101-120000/);
  assert.match(mixed, /1 change\(s\) were recorded without a backup folder/);

  const backed = undoOf([...applied, byHand(true)]);
  assert.match(backed, /backup-20260101-120000/);
  assert.ok(!backed.includes('without a backup folder'));
  assert.match(undoOf([byHand(false)], 'sk'), /bez záložného priečinka: 1/);

  // What the person changed by hand is told as that, everywhere in the report: the tool applied
  // nothing, moved nothing, and does not say that settings were changed by it.
  const whole = renderAfter({ before: checksBefore, scan: scanAfter, checks: checksAfter, applied: [byHand(true)], lang: 'en' });
  const page = assertSelfContained(whole);
  const seen = decode(page.text).replace(/\s+/g, ' ');
  assert.match(seen, /Changes applied 0 Changed by you, by hand 1 Changes skipped 0/);
  assert.match(seen, /No change was applied, so no entry moved\./);
  assert.match(seen, /No change was applied\./);
  assert.ok(!/Settings changed|Duplicate deleted/.test(seen), 'the report names a tool action for a change the person made');
  const file = withClass(page, 'change-file').find((element) => element.attrs['data-file'] === settings);
  assert.match(textOf(page, inside(page, file, (element) => element.name === 'summary')[0]), /applied 0 · by hand 1 · skipped 0 · still open \d+$/);
  assert.match(textOf(page, file), /Changed by you, by hand \(1\) .*Change settings/);
  assert.ok(!/Applied changes \(/.test(textOf(page, file)));
});

test('CLI writes the report, prints its path and a file:// URL, and defaults to the health-check folder', (t) => {
  const { local, checksBefore, scanAfter, checksAfter, applied } = changedSetup(t);
  const write = (name, value) => {
    const file = path.join(local.root, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const scanFile = write('scan.json', scanAfter);
  const checksFile = write('checks.json', checksAfter);

  const state = runJson('report.mjs', ['state', '--scan', scanFile, '--checks', checksFile, '--lang', 'en']);
  assert.ok(state.path.startsWith(`${local.home}/.claude/health-check/state-`), state.path);
  assert.match(state.path, /state-\d{8}-\d{6}\.html$/);
  assert.match(state.url, /^file:\/\/\//);
  assert.ok(existsSync(state.path));
  assertSelfContained(readFileSync(state.path, 'utf8'));

  const out = path.join(local.root, 'reports', 'after.html');
  const afterReport = runJson('report.mjs', [
    'after',
    '--before', write('before.json', checksBefore),
    '--scan', scanFile,
    '--checks', checksFile,
    '--applied', write('applied.json', applied),
    '--lang', 'sk',
    '--out', out,
  ]);
  assert.equal(afterReport.path, out.replace(/\\/g, '/'));
  assert.match(readFileSync(out, 'utf8'), /Riadky pred a po/);

  const unknown = runScript('report.mjs', ['later', '--scan', scanFile]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /state.*after/);
  const incomplete = runScript('report.mjs', ['after', '--scan', scanFile, '--checks', checksFile]);
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /--before/);
});
