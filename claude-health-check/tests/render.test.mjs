// The screens of the console: the budget every screen keeps (width, page, no escape byte in
// plain mode, ASCII purity), what the panels say, and golden copies of the main fixture.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { before } from 'node:test';
import { PACKAGE_ROOT, load } from './helpers/fixtures.mjs';
import { INFO, RUN, SKINS, TOOL, demo, launcherScreens } from './helpers/console.mjs';

const { CANDIDATE_CHECKS, CHECKS, REVIEW_CHECKS } = await load('checks.mjs');
const { runInfo } = await load('lib/pipeline.mjs');
const render = await load('lib/render.mjs');
const { LANGS, STRINGS } = await load('lib/strings.mjs');
const { PAGE, WIDTH, strip, widthOf } = await load('lib/term.mjs');
const { SKILL_NOTE_CHECKS } = await load('lib/view.mjs');

const FIXTURES = [
  ['main', {}],
  ['clean', {}],
  ['field', { nested: true }],
];
const demos = {};
before(() => {
  for (const [name, options] of FIXTURES) {
    for (const lang of LANGS) demos[`${name}.${lang}`] = demo(name, lang, options);
  }
});
const viewOf = (name, lang = 'en') => demos[`${name}.${lang}`].view;

// A line that is one link is never cut: it has to stay clickable.
const isLink = (line) => /^\s*file:\/\/\S+$/.test(strip(line));
// Letters with diacritics are content and stay in the ASCII skin; decoration does not.
const NOT_ASCII = /[^\x00-\x7f -ſ]/;

function assertBudget(name, lines, o) {
  assert.ok(Array.isArray(lines) && lines.length > 0, `${name}: no lines`);
  assert.ok(lines.length <= PAGE, `${name}: ${lines.length} lines, more than one page of ${PAGE}\n${lines.join('\n')}`);
  lines.forEach((line, index) => {
    assert.equal(typeof line, 'string', `${name}: line ${index + 1} is not text`);
    assert.ok(!/\n/.test(line), `${name}: line ${index + 1} holds a line break`);
    if (!isLink(line)) assert.ok(widthOf(line) <= WIDTH, `${name}: line ${index + 1} is ${widthOf(line)} wide: ${strip(line)}`);
    assert.ok(!/\s$/.test(strip(line)), `${name}: line ${index + 1} ends in a space: "${strip(line)}"`);
    if (!o.colour) assert.ok(!line.includes('\u001b'), `${name}: line ${index + 1} holds an escape byte in plain mode`);
    if (!o.unicode) assert.ok(!NOT_ASCII.test(strip(line)), `${name}: line ${index + 1} holds a glyph outside ASCII: ${strip(line)}`);
  });
}

test('the screen budget: every screen, every fixture, both languages, every skin', () => {
  let screens = 0;
  for (const [name] of FIXTURES) {
    for (const lang of LANGS) {
      for (const skin of SKINS) {
        const o = { lang, colour: skin.colour, unicode: skin.unicode, width: WIDTH };
        for (const [title, lines] of launcherScreens(viewOf(name, lang), o)) {
          assertBudget(`${name} ${lang} ${skin.name}: ${title}`, lines, o);
          screens += 1;
        }
      }
    }
  }
  assert.ok(screens >= 3 * 2 * 3 * 16, `only ${screens} screens were checked`);
});

test('colour changes nothing but the escape codes', () => {
  for (const lang of LANGS) {
    const plain = launcherScreens(viewOf('main', lang), { lang, colour: false, unicode: true });
    const coloured = launcherScreens(viewOf('main', lang), { lang, colour: true, unicode: true });
    assert.deepEqual(
      coloured.map(([title, lines]) => [title, lines.map(strip)]),
      plain,
    );
    assert.ok(coloured.some(([, lines]) => lines.some((line) => line.includes('\u001b[31m'))), 'nothing is red');
  }
});

test('the step rail names six steps and marks where this program ends', () => {
  const o = { lang: 'en', colour: false, unicode: true };
  assert.equal(render.rail(0, o), '  ► LANGUAGE ─ · Scope ─ · Scan ─ · Report ║ · Changes ─ · Summary       1/6');
  assert.equal(render.rail(3, o), '  √ Language ─ √ Scope ─ √ Scan ─ ► REPORT ║ · Changes ─ · Summary       4/6');
  assert.equal(render.rail(5, { ...o, unicode: false }), '  + Language - + Scope - + Scan - + Report | + Changes - > SUMMARY       6/6');
  assert.match(render.rail(1, { ...o, lang: 'sk' }), /^ {2}√ Jazyk ─ ► ROZSAH ─ · Sken ─ · Správa ║ · Zmeny ─ · Súhrn\s+2\/6$/);
  assert.deepEqual(render.STEPS.length, 6);
});

test('the overview: files against the documented size, longest first, and what loads per place', () => {
  const lines = render.overview(viewOf('main'), { lang: 'en', colour: false, unicode: true });
  const text = lines.join('\n');
  assert.match(lines[0], /^ {2}30 files · 2 projects\s+▲ 1 high {3}■ 9 medium {3}● 8 low {3}○ 1 to review$/);
  assert.match(text, /MEMORY FILES\s+lines\s+under 200 lines │ over/);
  const user = lines.find((line) => line.includes('~/.claude/CLAUDE.md'));
  assert.match(user, /238 {3}████████████████████│▓▓▓▓\s+119%$/);
  const memory = lines.slice(lines.findIndex((line) => line.includes('MEMORY FILES')) + 1, lines.indexOf('', 2));
  const counts = memory.map((line) => Number(/\s(\d+) {3}/.exec(line)[1]));
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'the longest file is first');
  // The mark of the heading stands exactly above the mark of every bar.
  const column = [...lines.find((line) => line.includes('MEMORY FILES'))].indexOf('│');
  for (const line of memory) assert.equal([...line].indexOf('│'), column, line);
  assert.match(text, /LOADED AT EVERY SESSION START\s+lines\s+under 400 lines │ over/);
  assert.match(text, /in alpha-service\s+459 {3}█{20}│▓▓▓\s+115%/);
  assert.match(text, /user files only\s+437/);
  assert.match(text, /200 lines per file is documented\. 400 for the total is a default of this\s+tool\./);
  // No score anywhere: counts, bars and limits only.
  assert.ok(!/score|grade|\/ ?100\b/i.test(launcherScreens(viewOf('main'), { lang: 'en', colour: false, unicode: true }).flatMap(([, screen]) => screen).join('\n')));
});

test('the findings panel: one line per kind, candidates as one sentence, review items apart', () => {
  const lines = render.findings(viewOf('main'), { lang: 'en', colour: false, unicode: true });
  const text = lines.join('\n');
  assert.equal(lines[0], '  ▲ HIGH 1');
  assert.match(lines[1], /^ {4}settings file is not valid JSON\s+~\/\.claude\/settings\.local\.json$/);
  assert.match(text, /■ MEDIUM 9/);
  assert.match(text, /● LOW 8/);
  assert.match(text, /too much loaded at session start\s+~\/\.claude\/CLAUDE\.md\n/);
  assert.match(text, /import that does not resolve\s+~\/\.claude\/CLAUDE\.md:43\n/);
  assert.match(text, /… \d+ more in the report/);
  assert.match(text, /○ TO REVIEW 1\s+nothing to change, yours to decide\n {4}MCP server, no permission rule\s+alpha-service: tracker, search/);
  assert.equal(lines.at(-1), '  Candidates found by words only: 15. Claude reads them next.');
  // A candidate is never listed with the findings, and has no severity: nothing that word
  // matching found stands in this panel, whatever it would become once a reader confirmed it.
  assert.ok(!/possible conflict|line that could be a hook|rule with an exception|line about one project|prohibition only in prose|procedure in a memory file|line that could be a command|skill without a "use when"/.test(text));
  assert.ok(lines.length <= render.PANEL_LINES);

  const clean = render.findings(viewOf('clean'), { lang: 'en', colour: false, unicode: true });
  assert.deepEqual(clean, ['  Nothing to change. That is a good result.']);
});

test('every check has a short label of at most 34 characters, in both languages', () => {
  for (const lang of LANGS) {
    for (const check of new Set([...CHECKS, ...CANDIDATE_CHECKS, ...REVIEW_CHECKS])) {
      const label = STRINGS[lang][`ui.short.${check}`];
      assert.ok(label, `${lang} lacks the short label of ${check}`);
      assert.ok([...label].length <= 34, `${lang} ${check}: "${label}" is ${[...label].length} characters`);
    }
    for (const key of [...SKILL_NOTE_CHECKS, 'third-party', 'twin-same', 'twin-differs', 'linked']) {
      assert.ok(STRINGS[lang][`ui.note.${key}`], `${lang} lacks the skill note ${key}`);
    }
  }
});

test('the context panel: the place that pays most is opened, with its largest parts and the chain', () => {
  const lines = render.context(viewOf('main'), { lang: 'en', colour: false, unicode: true });
  const text = lines.join('\n');
  assert.match(lines[0], /^ {2}CONTEXT TAX {2}what is loaded before your first word$/);
  assert.match(text, /Tokens are estimated as bytes \/ 4: a default of this tool/);
  assert.match(text, /in alpha-service\s+≈ 7,104 tokens/);
  assert.match(text, / {4}~\/\.claude\/CLAUDE\.md\s+3,594 {2}█+\s+51%/);
  assert.match(text, /skill descriptions \(8\)\s+\d+/);
  assert.match(text, /\d+ more parts\s+\d+/);
  assert.match(text, /\n {4}in the order it loads:\n {4}user memory ─► project memory ─► imports ─► rule files ─► descriptions\n {4}3,594 +95 +2,849 +24 +542\n/);
  assert.match(text, /in beta-tool\s+≈ 6,994 tokens\n {2}user files only\s+≈ 6,947 tokens/);
  assert.match(text, /Descriptions of agents are not counted\./);
  // The parts of the opened place add up to its total.
  const sk = render.context(viewOf('main', 'sk'), { lang: 'sk', colour: false, unicode: true }).join('\n');
  assert.match(sk, /≈ 7 104 tokenov/);
});

test('the skills panel: user skills first, then one group per project headed by its path', () => {
  const lines = render.skills(viewOf('main'), { lang: 'en', colour: false, unicode: true });
  const text = lines.join('\n');
  assert.match(lines[0], /^ {2}SKILLS\s+lines\s+under 500 │\s+notes$/);
  assert.equal(lines[1], '  User skills · ~/.claude/skills (8)');
  assert.match(text, / {4}long-skill\s+512 {3}██████████│▓\s+over the recommendation/);
  assert.match(text, / {4}wordy-skill\s+6 {3}█░+│\s+description 1,783 \/ 1,536\n/);
  assert.match(text, / {4}shared-skill\s+\d+ {3}█░+│\s+≠ copy in alpha-service/);
  assert.match(text, /\n {2}\/work\/demo\/projects\/alpha-service \(1\)\n {4}shared-skill\s+\d+ {3}█░+│\s+≠ copy in ~\/\.claude\/skills/);
  assert.match(text, /No skills in: beta-tool\n/);
  assert.match(text, /Third-party skills \(marked do not edit\): 0/);
  assert.ok(lines.indexOf('  User skills · ~/.claude/skills (8)') < lines.findIndex((line) => line.includes('/work/demo/projects/alpha-service')));

  // Nested repositories are groups of their own; third-party and linked skills say what they are.
  const field = render.skills(viewOf('field'), { lang: 'en', colour: false, unicode: true }).join('\n');
  assert.match(field, /third-party · do not edit/);
  assert.match(field, /\/work\/demo\/projects\/outer-app\/clones\/inner-kit \(\d+\)/);
  assert.ok(render.skills(viewOf('field'), { lang: 'en', colour: false, unicode: true }).length <= render.PANEL_LINES);
});

test('a panel that would overflow says how much is left to the report', () => {
  const view = structuredClone(viewOf('main'));
  const group = view.skills.groups[1];
  for (let index = 0; index < 30; index += 1) {
    view.skills.groups.push({ ...group, key: `p${index}`, title: `/work/demo/projects/project-${index}`, rows: group.rows.map((row) => ({ ...row })) });
  }
  const many = structuredClone(viewOf('main'));
  many.loaded.places = Array.from({ length: 12 }, (_, index) => ({ ...many.loaded.places[1], key: `p${index}`, label: `in project-${index}`, lines: 400 + index }));
  many.contextTax.places = Array.from({ length: 12 }, (_, index) => ({ ...many.contextTax.places[1], key: `p${index}`, label: `in project-${index}`, tokens: 7000 + index }));
  many.contextTax.worst = 'p11';
  for (const lang of LANGS) {
    const o = { lang, colour: false, unicode: true };
    const skills = render.skills({ ...view, lang }, o);
    assert.ok(skills.length <= render.PANEL_LINES, `${lang}: the skills panel has ${skills.length} lines`);
    assert.match(skills.join('\n'), lang === 'en' ? /… \d+ more projects with skills in the report/ : /… ďalšie projekty so skillmi v správe: \d+/);
    for (const key of ['overview', 'context']) {
      const lines = render[key](many, o);
      assert.ok(lines.length <= render.PANEL_LINES, `${lang}: the ${key} panel has ${lines.length} lines`);
    }
    assert.match(render.overview(many, o).join('\n'), lang === 'en' ? /\+ 9 more places in the report/ : /\+ ďalšie miesta v správe: 9/);
    assert.match(render.context(many, o).join('\n'), lang === 'en' ? /… 10 more places in the report/ : /… ďalšie miesta v správe: 10/);
  }
});

test('a question is a numbered list that ends in a prompt, and the prompt names the default', () => {
  const o = { lang: 'en', colour: false, unicode: true };
  const q = { question: 'Which one?', sub: 'Pick.', options: [{ label: 'First', desc: 'the first one' }, { label: 'Second' }], focused: 1 };
  assert.deepEqual(render.numbered({ ...q, def: 1 }, o), [
    '  ? Which one?',
    '    Pick.',
    '    1  First',
    '         the first one',
    '    2  Second',
    '  Type 1-2 and press Enter [2]:',
  ]);
  assert.equal(render.answered('language', 'English', o), '  √ Language  English');
  // No screen names a key but Enter: nothing reads one.
  for (const lang of LANGS) {
    for (const unicode of [true, false]) {
      const screens = launcherScreens(viewOf('main', lang), { lang, colour: false, unicode }).flatMap(([, lines]) => lines).join('\n');
      assert.ok(!/[↑↓←]|\bq (quit|koniec)\b|press 1-|stlač 1-|\^v move|< > panel/.test(screens), `${lang}: a screen names a key that is not read`);
    }
  }
});

test('the progress screen prints measured numbers from the view', () => {
  const o = { lang: 'en', colour: false, unicode: true };
  const lines = render.progress(viewOf('main'), INFO, o);
  assert.deepEqual(lines, [
    '  √ User files   21 files in ~/.claude',
    '  √ Projects     2 found · 9 files',
    '  √ Imports      7 followed · 1 not found · 1 too deep',
    '  √ Settings     4 files · 4 hooks · values masked, never printed      41 ms',
    '  √ Checks       29 checks · 18 findings · 15 candidates · 1 to review',
    '  √ Context tax  ≈ 7,104 tokens before your first word (in alpha-service)',
    `  √ Report 1     ${RUN.report.name}                            26 ms`,
    '',
    '  Done in 0.14 s. No tokens used, nothing changed, nothing sent anywhere.',
  ]);
  // A time stands clear of the result or is left out: "1 to review 145 ms" reads as one number.
  // Whether it is shown depends on the result alone, so two runs of one setup print the same rows.
  const row = (text, ms) => render.progressRow('checks', text, ms, o);
  assert.equal(row('x'.repeat(51), 5), row('x'.repeat(51), 999).replace('999 ms', '  5 ms'));
  assert.match(row('x'.repeat(51), 999), /x {2}999 ms$/);
  assert.equal(row('x'.repeat(52), 5), `  √ Checks       ${'x'.repeat(52)}`);
  assert.equal(row('x'.repeat(52), 999), `  √ Checks       ${'x'.repeat(52)}`);
  assert.equal(row('x'.repeat(59), 5), `  √ Checks       ${'x'.repeat(59)}`, 'the result is never cut to make room for a time');
  const field = demo('field', 'en', {}).view;
  assert.match(render.progress(field, INFO, o).join('\n'), /√ Nested\s+2 repositories inside projects left out · --nested/);
  assert.match(render.progress(viewOf('main', 'sk'), INFO, { ...o, lang: 'sk' }).at(-1), /Hotovo za 0,14 s\./);
});

test('how to continue: Claude Code by its bare name, the command for it on a line of its own, never the two on one line', () => {
  const o = { lang: 'en', colour: false, unicode: true };
  // The folder of the tool is said, on a line of its own: the launcher may have been started from
  // any folder, and Claude Code has the skill only there.
  assert.deepEqual(render.wayOn(RUN, o, { folder: TOOL }), [
    '  ── How to continue ───────────────────────────────────────────────────────',
    '  Stopped here. Nothing was changed.',
    '  The changes need Claude Code:',
    '',
    '    1  open a terminal in the folder of this tool:',
    '         /work/demo/tool',
    '       and start Claude Code there:',
    '         claude',
    '    2  inside Claude Code, type:',
    '         /claude-health resume 20261001-131730',
    '',
    '  The run folder waits in ~/.claude/health-check/run-20261001-131730.',
    '  If your files change before you resume, the wizard scans again first.',
  ]);
  assert.deepEqual(render.wayOn(RUN, { ...o, lang: 'sk' }, { folder: TOOL }).slice(4, 10), [
    '    1  otvor terminál v priečinku tohto nástroja:',
    '         /work/demo/tool',
    '       a spusti v ňom Claude Code:',
    '         claude',
    '    2  v Claude Code napíš:',
    '         /claude-health resume 20261001-131730',
  ]);
  // Like the link, the folder is never cut: a path with a piece missing leads nowhere. A name
  // that holds what a terminal would act on is shown with a mark, as every other name is.
  const deep = `C:/${'a folder with a long name/'.repeat(5)}tool`;
  assert.equal(render.wayOn(RUN, o, { folder: deep })[5], `         ${deep}`);
  assert.equal(render.wayOn(RUN, o, { folder: 'C:/to\u001b[2Jol' })[5], `         C:/to${String.fromCodePoint(0xfffd)}[2Jol`);
  // Nor is it rewritten: the ASCII skin swaps the decoration of a sentence for look-alikes, and a
  // path with a character swapped names a folder that does not exist (verification of 3 Oct 2026).
  const odd = 'C:/tools \u2013 2026/a\u00b7b\u2026c/Matej\u2019s kit';
  for (const unicode of [true, false]) assert.equal(render.wayOn(RUN, { ...o, unicode }, { folder: odd })[5], `         ${odd}`, `the folder is not printed as it is spelled (unicode: ${unicode})`);
  assert.throws(() => render.wayOn(RUN, o), /folder of the tool/, 'how to continue is drawn without the place to continue in');
  // Started by an agent inside Claude Code: it is running already, so only the command is named.
  assert.deepEqual(render.wayOn(RUN, o, { agent: true }), ['  Started from inside Claude Code, so no question was asked. To go on, type:', '         /claude-health resume 20261001-131730']);
  // In every language and skin, with and without colour: the two commands stand alone on their lines.
  for (const lang of LANGS) {
    for (const skin of SKINS) {
      for (const agent of [false, true]) {
        const lines = render.wayOn(RUN, { lang, colour: skin.colour, unicode: skin.unicode }, { agent, folder: TOOL }).map(strip);
        assert.deepEqual(lines.filter((line) => /claude-health|(?<![\w./-])claude(?![\w./-])/.test(line)), [...(agent ? [] : ['         claude']), '         /claude-health resume 20261001-131730'], `${lang} ${skin.name}`);
      }
    }
  }
  // The run the renderer is handed is made in one place, and its start is a line a shell cannot change.
  assert.deepEqual(runInfo('20261001-131730', RUN.report), RUN);
});

// --- golden screens ----------------------------------------------------------------------------

const GOLDEN = path.join(PACKAGE_ROOT, 'tests', 'golden');

function goldenText(lang, skin) {
  const o = { lang, colour: false, unicode: skin !== 'ascii' };
  return launcherScreens(viewOf('main', lang), o)
    .map(([title, lines]) => `=== ${title}\n${lines.join('\n')}\n`)
    .join('\n');
}

for (const [lang, skin] of [['en', 'unicode'], ['sk', 'unicode'], ['en', 'ascii']]) {
  test(`golden screens of the main fixture: ${lang}, ${skin}`, () => {
    const file = path.join(GOLDEN, `launcher.${lang}.${skin}.txt`);
    const actual = goldenText(lang, skin);
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(file, actual);
    }
    assert.ok(existsSync(file), `${file} does not exist; run the tests once with UPDATE_GOLDEN=1 and read the file before keeping it`);
    const expected = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const [a, e] = [actual.split('\n'), expected.split('\n')];
    const at = a.findIndex((line, index) => line !== e[index]);
    assert.equal(actual, expected, at === -1 ? 'the golden file has more lines' : `first difference at line ${at + 1}:\n  now:    ${a[at]}\n  golden: ${e[at]}`);
  });
}
