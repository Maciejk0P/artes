// What the launcher showed before the two cuts of 2 Oct 2026 (AUDIT.md, "What to cut rather than
// repair") and shows after them: the opening block, the two lists, the questions as numbered
// lists, the progress lines and the four panels, on two fixtures, in both languages.
//
// The golden files were written by the launcher as it was before the cuts and were not written
// again after them. Each run is pinned from its first line to the link to report 1; what follows
// the link is what the cuts changed, and launcher.test.mjs holds that part.
//
// A run here uses only what the launcher had before the cuts and has after them: flags, answers
// from standard input, and the variable its shell script sets.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PACKAGE_ROOT, load, materialise } from './helpers/fixtures.mjs';
import { runLauncher } from './helpers/console.mjs';

const render = await load('lib/render.mjs');
const { LANGS } = await load('lib/strings.mjs');
const { strip } = await load('lib/term.mjs');

const GOLDEN = path.join(PACKAGE_ROOT, 'tests', 'golden');
const FIXTURES = ['main', 'clean'];

// One way through the launcher: its arguments, what is typed, and the environment of its shell.
const CASES = {
  // Every answer is a flag: nothing is asked.
  flags: (fx, lang) => ({ args: ['check', '--lang', lang, '--projects', fx.projects] }),
  // Every answer is typed: the language, "folders I name", one folder, the end of the list.
  asked: (fx, lang) => ({ args: ['check'], input: `${LANGS.indexOf(lang) + 1}\n3\n${fx.projects}\n\n` }),
  // The shell script says a terminal is on both ends: colour, and the two lists wait for Enter.
  terminal: (fx, lang) => ({ args: ['check', '--lang', lang], env: { CLAUDE_HEALTH_TTY: '1' }, input: '\n1\n' }),
  // The search of the home folder: the four facts first, then the folders outside it.
  'home folder': (fx, lang) => ({ args: ['check', '--lang', lang], input: '2\n\n' }),
  ascii: (fx, lang) => ({ args: ['check', '--lang', lang, '--user-only', '--ascii'] }),
};

// What differs from run to run and from machine to machine is given one spelling: the temp
// folder of the fixture, the stamp, the version and every measured time. An escape byte is
// shown as a mark, so the colours are pinned and the file stays readable.
function normal(text) {
  return text
    .replace(/file:\/\/[^\s\u001b]*claude-health-check-\w{6}/g, '<root>')
    .replace(/(?<=^|\s|\u001b\[[0-9;]*m)[A-Za-z0-9_.:~/\\…%-]*claude-health-check-\w{6}/gm, '<root>')
    .replace(/\d{8}-\d{6}/g, 'STAMP')
    .replace(/\u001b/g, '␛')
    .replace(/ +((?:␛\[2m)?)\d+ ms/g, ' $1N ms')
    .replace(/ +((?:␛\[2m)?)\d+\.\d+\.\d+((?:␛\[0m)?)$/m, ' $1VERSION$2')
    .replace(/(Done in|Hotovo za) [\d.,]+ s/, '$1 N s');
}

// From the first line to the link to report 1, the link included.
function pinned(out, lang, unicode) {
  const title = `  ${render.text({ lang, unicode })('ui.next.report')}`;
  const lines = out.split('\n');
  const at = lines.findIndex((line) => strip(line) === title);
  assert.ok(at !== -1, `the run never printed "${title.trim()}", so there is nothing to pin:\n${out.slice(-600)}`);
  return normal(lines.slice(0, at + 2).join('\n'));
}

for (const name of FIXTURES) {
  for (const lang of LANGS) {
    test(`the launcher on the ${name} fixture, ${lang}: everything up to the link is what it was before the cuts`, (t) => {
      const fx = materialise(name);
      t.after(() => fx.cleanup());
      const sections = Object.entries(CASES).map(([title, build]) => {
        const { args, env = {}, input = '' } = build(fx, lang);
        const run = runLauncher(args, { home: fx.home, env, input });
        assert.equal(run.status, 0, `${title}: ${run.stderr}`);
        assert.equal(run.stderr, '', title);
        return `=== ${title}\n${pinned(run.stdout, lang, title !== 'ascii')}\n`;
      });
      const actual = sections.join('\n');
      const file = path.join(GOLDEN, `run.${name}.${lang}.txt`);
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
}
