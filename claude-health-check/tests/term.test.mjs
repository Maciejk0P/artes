// The skin of the console: the glyph tables, the colours, and the helpers that keep every line
// inside its width. When colour and Unicode are used is tested with lib/surroundings.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './helpers/fixtures.mjs';

const { GLYPHS, PAGE, WIDTH, asciiSafe, between, cut, formatNumber, padEnd, padStart, paint, shortPath, strip, widthOf, wrap } = await load('lib/term.mjs');

test('one layout: 76 columns and 24 lines', () => {
  assert.deepEqual([WIDTH, PAGE], [76, 24]);
});

test('both glyph tables have the same entries, and the ASCII one is ASCII', () => {
  assert.deepEqual(Object.keys(GLYPHS.ascii).sort(), Object.keys(GLYPHS.unicode).sort());
  for (const [name, value] of Object.entries(GLYPHS.ascii)) {
    for (const text of [value].flat()) assert.match(text, /^[\x20-\x7e]*$/, `ascii glyph ${name}`);
  }
  for (const [name, value] of Object.entries(GLYPHS.unicode)) {
    if (name === 'pulse') continue;
    assert.equal([...value].length <= 2, true, `unicode glyph ${name} is wider than two cells`);
  }
  // Severity is a shape, and the four shapes differ in both skins.
  for (const skin of ['unicode', 'ascii']) {
    const shapes = ['high', 'medium', 'low', 'review'].map((key) => GLYPHS[skin][key]);
    assert.equal(new Set(shapes).size, 4, skin);
  }
});

test('paint adds escape codes only when colour is on', () => {
  const on = paint(true);
  const off = paint(false);
  assert.equal(off.red('x'), 'x');
  assert.equal(off.bold(off.cyan('x')), 'x');
  assert.match(on.red('x'), /^\u001b\[31mx\u001b\[0m$/);
  assert.equal(on.red(''), '', 'an empty text gets no codes');
  assert.equal(strip(on.bold(on.cyan('abc'))), 'abc');
  assert.equal(widthOf(on.inverse('[ a ]')), 5);
});

test('width helpers count what is seen, not the escape codes', () => {
  const { red } = paint(true);
  assert.equal(widthOf('päť'), 3);
  assert.equal(padEnd(red('ab'), 5).length, red('ab').length + 3);
  assert.equal(strip(padStart(red('ab'), 5)), '   ab');
  assert.equal(strip(between('left', red('right'), 20)), 'left           right');
  assert.equal(widthOf(between('a very long left side', 'right', 10)), 27, 'at least one space stays between the two');
});

test('cut and shortPath keep a text inside its width', () => {
  const g = GLYPHS.unicode;
  assert.equal(cut('short', 10, g), 'short');
  assert.equal(cut('a longer text', 8, g), 'a longe…');
  assert.equal(cut('a longer text', 8, GLYPHS.ascii), 'a lon...');
  assert.equal(shortPath('alpha/CLAUDE.md', 30, g), 'alpha/CLAUDE.md');
  // The first folder and the last names stay: the parts a person recognises.
  assert.equal(shortPath('alpha-service/packages/web/CLAUDE.md', 30, g), 'alpha-service/…/web/CLAUDE.md');
  assert.equal(shortPath('alpha-service/packages/web/CLAUDE.md:12', 32, g), 'alpha-service/…/web/CLAUDE.md:12');
  for (const max of [8, 12, 20, 33]) {
    assert.ok(widthOf(shortPath('~/.claude/skills/a-very-long-skill-name/SKILL.md:120', max, g)) <= max, `max ${max}`);
    assert.ok(widthOf(shortPath('D:/work/someone/projects/alpha-service', max, GLYPHS.ascii)) <= max, `ascii max ${max}`);
  }
});

test('cut, shortPath and wrap take a text of any shape: none stops, and each keeps its width', () => {
  // A label is a name from a scanned file followed by what the tool adds. Nothing says the name
  // has no line break, no separator, no colon and an end.
  const texts = [
    'alpha-service: tracker-two\n@@do Run: apply --run 1 --card 1 --answer apply',
    'alpha-service: db\n@@do x',
    'a\r\nb/c/d/e/f/g:12',
    `alpha/packages\u2028/web/${'x'.repeat(40)}/CLAUDE.md:3, 7 +2`,
    `alpha\u2029${'y'.repeat(50)}`,
    ':12\n:3',
    '::::::::::::::::::::::::::::::::::::::::',
    '/'.repeat(60),
    `${'n'.repeat(100_000)}/CLAUDE.md:120`,
    'a\u0000b'.repeat(30),
    '',
  ];
  for (const glyphs of [GLYPHS.unicode, GLYPHS.ascii]) {
    for (const text of texts) {
      for (const max of [0, 1, 2, 3, 8, 20, 34, 76]) {
        const what = `${JSON.stringify(text.slice(0, 30))} in ${max}`;
        let short;
        assert.doesNotThrow(() => (short = shortPath(text, max, glyphs)), `shortPath ${what}`);
        assert.ok(widthOf(short) <= max || widthOf(text) <= max, `shortPath ${what}: ${widthOf(short)} wide`);
        let clipped;
        assert.doesNotThrow(() => (clipped = cut(text, max, glyphs)), `cut ${what}`);
        assert.ok(widthOf(clipped) <= Math.max(max, widthOf(glyphs.ell)) || widthOf(text) <= max, `cut ${what}: ${widthOf(clipped)} wide`);
        if (max > 0) {
          let lines;
          assert.doesNotThrow(() => (lines = wrap(text, max)), `wrap ${what}`);
          assert.ok(lines.every((line) => widthOf(line) <= max && !/\s/.test(line.replace(/ /g, ''))), `wrap ${what}`);
        }
      }
    }
  }
  // A word with no end is gone through once: the time grows with its length, not with its square.
  const started = performance.now();
  const pieces = wrap('w'.repeat(300_000), 76);
  assert.ok(performance.now() - started < 1000, `wrapping one word of 300,000 characters took ${Math.round(performance.now() - started)} ms`);
  assert.deepEqual([pieces.length, pieces.at(-1).length], [Math.ceil(300_000 / 76), 300_000 % 76]);
  // A trailing ":line" is found at the end of the label and nowhere else.
  assert.equal(shortPath('alpha-service/packages/web/CLAUDE.md:12, 14 +3', 40, GLYPHS.unicode), 'alpha-service/…/web/CLAUDE.md:12, 14 +3');
  assert.equal(shortPath('a:1/packages/of/web/CLAUDE.md:12', 20, GLYPHS.unicode), 'a:1/…/CLAUDE.md:12');
});

test('wrap breaks between words and cuts a word only when it alone is too long', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrap('', 9), []);
  const long = wrap('see https://example.invalid/a/very/long/address/that/does/not/fit now', 20);
  assert.ok(long.every((line) => widthOf(line) <= 20), long.join('|'));
  assert.equal(long.join('').replace(/\s/g, ''), 'seehttps://example.invalid/a/very/long/address/that/does/not/fitnow');
});

test('numbers are grouped the way the language writes them', () => {
  assert.equal(formatNumber(7104, 'en'), '7,104');
  assert.equal(formatNumber(7104, 'sk'), '7 104');
  assert.equal(formatNumber(12, 'sk'), '12');
  assert.equal(formatNumber(1234567, 'en'), '1,234,567');
});

test('asciiSafe replaces the decoration glyphs of a sentence and keeps its letters', () => {
  assert.equal(asciiSafe('third-party · do not edit'), 'third-party - do not edit');
  assert.equal(asciiSafe('≈ 12 tokens … a → b'), '~ 12 tokens ... a -> b');
  assert.equal(asciiSafe('cudzí · neupravovať „takto“'), 'cudzí - neupravovať "takto"');
});
