// The token report: the numbers of a small, hand-computed setup, what it keeps of a transcript
// (numbers, never text), and the command line of the script and the launcher.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { PACKAGE_ROOT, emptySetup, load } from './helpers/fixtures.mjs';

const { measureTokens, renderTokens, tokensCommand } = await load('tokens.mjs');
const { UsageError } = await load('lib/cli.mjs');
const { LANGS } = await load('lib/strings.mjs');

const NOW = new Date();
const at = (daysAgo) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
const SECRETS = ['SECRET-PROMPT-TEXT', 'SECRET-COMMAND', 'SECRET-OUTPUT', 'HOOK-TEXT', 'sess-1', 'x-proj'];
const usage = (input, write, read, output, thinking = 0) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output, output_tokens_details: { thinking_tokens: thinking } });
const assistant = (id, use, content = [], model = 'claude-opus-5-5', when = at(1)) => ({ type: 'assistant', timestamp: when, message: { id, model, usage: use, content } });
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, content) => ({ type: 'user', timestamp: at(1), message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const jsonl = (rows) => rows.map((row) => JSON.stringify(row));

let setup;
let transcript;
before(() => {
  setup = emptySetup();
  const sessions = '.claude/projects/-x-proj';
  transcript = setup.write(`home/${sessions}/sess-1.jsonl`, jsonl([
    { type: 'user', timestamp: at(1), message: { content: 'SECRET-PROMPT-TEXT <command-name>/slash-skill</command-name>' } },
    assistant('m1', usage(10, 1000, 0, 100, 40), [toolUse('t1', 'Bash', { command: 'SECRET-COMMAND' })]),
    // The same response, written as a second row: its usage must count once.
    assistant('m1', usage(10, 1000, 0, 100, 40), [{ type: 'text', text: 'done' }]),
    toolResult('t1', 'SECRET-OUTPUT'),
    { type: 'attachment', timestamp: at(1), attachment: { type: 'hook_additional_context', content: 'HOOK-TEXT', hookEvent: 'PostToolUse' } },
    assistant('m2', usage(5, 300, 1010, 50), [toolUse('t2', 'Skill', { skill: 'used-skill' })]),
    { type: 'system', subtype: 'compact_boundary', timestamp: at(1) },
    assistant('m3', usage(5, 500, 0, 20)),
  ]));
  // A file written lately whose only call is older than the window.
  setup.write(`home/${sessions}/sess-old.jsonl`, jsonl([assistant('o1', usage(0, 9000, 0, 900), [], 'claude-opus-5-5', at(30))]));
  setup.write(`home/${sessions}/sess-1/subagents/agent-a.jsonl`, jsonl([
    assistant('s1', usage(0, 200, 0, 10), [toolUse('g1', 'Grep')], 'claude-haiku-5-5'),
    toolResult('g1', 'match'),
    assistant('s2', usage(0, 50, 200, 5), [], 'claude-haiku-5-5'),
  ]));
  for (const [name, extra] of [['used-skill', ''], ['idle-skill', ''], ['slash-skill', ''], ['hidden-skill', 'disable-model-invocation: true\n']]) {
    setup.write(`home/.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Does ${name} things when asked.\n${extra}---\n\nBody.\n`);
  }
  setup.write('home/.claude/settings.json', JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] },
    enabledPlugins: { 'caveman@market': true, 'context-mode@market': false },
  }));
});
after(() => setup.cleanup());

// The hand-computed numbers of the setup above (weights: read 0.1, write 1.25, input 1, output 5).
const UNITS = 1760 + 731 + 730 + 300 + 107.5;
const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual}, expected ${expected}`);

test('tokens: the units of each call count once, inside the window only', () => {
  const result = measureTokens({ home: setup.home, days: 7, now: NOW });
  assert.equal(result.calls, 5);
  // Without the de-duplication by message id the duplicate row of m1 would add 1760.
  assert.equal(result.units, Math.round(UNITS));
  assert.deepEqual(result.files, { main: 1, subagent: 1, workflow: 0 }, 'the file whose only call is older than the window counts');
  close(result.callers.main, 3221 / UNITS, 'main thread');
  close(result.callers.subagent, 407.5 / UNITS, 'subagents');
  assert.deepEqual(result.models.map((entry) => entry.model), ['claude-opus-5-5', 'claude-haiku-5-5']);
});

test('tokens: each built-in saver gets the share of the units its mechanism can touch', () => {
  const result = measureTokens({ home: setup.home, days: 7, now: NOW });
  const by = Object.fromEntries(result.builtin.map((entry) => [entry.id, entry]));
  close(by.effort.share, 200 / UNITS, 'thinking');
  close(by['lean-base'].share, 2264.75 / UNITS, 'the start of each session and agent');
  close(by['new-session'].share, 380 / UNITS, 'the context above the start');
  assert.equal(by['new-session'].calls, 0);
  assert.equal(by['new-session'].all, 3);
  close(by['agent-model'].share, 407.5 / UNITS, 'agents');
  close(by['agent-model'].search, 407.5 / UNITS, 'agents that only searched');
  assert.equal(by['agent-model'].count, 1);
  // Hook output gets its part of what the context grew by between m1 and m2: 305 less m1's 100 output tokens.
  close(by['lean-hooks'].share, ((205 * 2.25) / 5.5) * 1.25 / UNITS, 'hook output');
  assert.deepEqual(result.builtin.map((entry) => entry.share), [...result.builtin.map((entry) => entry.share)].sort((a, b) => b - a), 'not sorted by share');
});

test('tokens: a third-party tool is never offered, gets what it could touch, and is found when installed', () => {
  const result = measureTokens({ home: setup.home, days: 7, now: NOW });
  const by = Object.fromEntries(result.tools.map((entry) => [entry.id, entry]));
  close(by.rtk.share, ((205 * 3.25) / 5.5) * 1.25 / UNITS, 'Bash output');
  close(by.caveman.share, 725 / UNITS, 'answers without thinking');
  close(by.serena.share, 50 / UNITS, 'Grep output of the agent');
  assert.equal(by.ccusage.share, null);
  assert.equal(by.rtk.on, true, 'a hook that runs rtk');
  assert.equal(by.caveman.on, true, 'an enabled plugin');
  assert.equal(by['context-mode'].on, false, 'a plugin that is switched off');
  assert.equal(by.headroom.on, null, 'Headroom leaves no trace in these files');
});

test('tokens: skills that ran through Skill or a slash command, and skills the model is not offered, are not unused', () => {
  const result = measureTokens({ home: setup.home, days: 7, now: NOW });
  assert.deepEqual(result.unusedSkills.map((skill) => skill.name), ['idle-skill']);
  assert.ok(result.unusedSkills[0].tokens > 0);
});

test('tokens: no text, tool input or path of a transcript leaves the report, in either language or as JSON', () => {
  // The marks are in the transcript, so a leak would show.
  const raw = readFileSync(transcript, 'utf8');
  for (const secret of SECRETS.slice(0, 4)) assert.ok(raw.includes(secret), `${secret} is not in the transcript, so its absence proves nothing`);
  const result = measureTokens({ home: setup.home, days: 7, now: NOW });
  const outputs = [JSON.stringify(result), ...LANGS.map((lang) => renderTokens(result, lang))];
  for (const out of outputs) for (const secret of SECRETS) assert.ok(!out.includes(secret), `${secret} reached the report`);
});

test('tokens: the command line refuses a wrong option and says why, and an empty home has nothing to measure', () => {
  assert.throws(() => tokensCommand(['--days', '0', '--home', setup.home], { cwd: setup.root }), UsageError);
  assert.throws(() => tokensCommand(['--days', '91', '--home', setup.home], { cwd: setup.root }), /from 1 to 90/);
  assert.throws(() => tokensCommand(['--lang', 'de', '--home', setup.home], { cwd: setup.root }), /--lang/);
  assert.throws(() => tokensCommand(['--home', path.join(setup.root, 'nowhere')], { cwd: setup.root }), /--home is not a folder/);
  const empty = emptySetup();
  try {
    assert.match(tokensCommand(['--home', empty.home, '--lang', 'en'], { cwd: empty.root }), /No session in the last 7 days/);
  } finally {
    empty.cleanup();
  }
  for (const lang of LANGS) assert.match(tokensCommand(['--home', setup.home, '--lang', lang], { cwd: setup.root }), lang === 'en' ? /Not offered/ : /Neponúka sa/);
});

test('tokens: the launcher runs the report as "claude-health tokens"', () => {
  const run = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'claude-health.mjs'), 'tokens', '--home', setup.home, '--lang', 'en', '--json'], { cwd: setup.root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).units, Math.round(UNITS));
  const wrong = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'claude-health.mjs'), 'tokens', '--days', 'x'], { cwd: setup.root, encoding: 'utf8' });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /--days needs a non-negative whole number/);
});
