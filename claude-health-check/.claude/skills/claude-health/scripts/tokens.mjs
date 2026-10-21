// The tokens of the person's own Claude Code sessions: where they went, and how much of them each
// of the usual savers could touch at all.
//
//   node tokens.mjs [--days 7] [--home <dir>] [--projects <dir> ...] [--lang en|sk] [--json]
//
// The one module of the package that reads session transcripts (decided 8 Oct 2026: they are the
// person's own sessions on their own machine; nothing in them is changed and nothing is sent). What
// leaves it is numbers, tool names, model ids and skill names: no text of a transcript, no tool
// input and no path of a transcript.
//
// Every share is of the person's own weighted usage (TOKENS in lib/facts.mjs). No percentage of a
// vendor or a study enters a number: what a saver would save is not known, only what it could
// touch. A third-party tool is never offered; it gets one line of independent evidence instead.
// The shares of tool output, hook output, history and the session start are estimates: a piece is
// written once and read again on every later call until a compaction, and its size is its part
// of what the context grew by (measureTranscript).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError, parseArgs, runCli } from './lib/cli.mjs';
import { LIMITS, TOKENS } from './lib/facts.mjs';
import { LANGS, t } from './lib/strings.mjs';
import { isProject, scan } from './scan.mjs';

const W = TOKENS.weights;
const DAY = 86_400_000;
const SEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch']);
const SKILLS_SHOWN = 15;

// Third-party savers, in the order of the cockpit catalogue they come from, with what each one
// works on. Only the share of those categories is computed; the tool is never offered.
export const TOOLS = [
  { id: 'rtk', touches: ['shell'], url: 'https://github.com/rtk-ai/rtk' },
  { id: 'context-mode', touches: ['shell', 'mcp', 'web'], url: 'https://github.com/mksglu/context-mode' },
  { id: 'headroom', touches: ['mcp', 'web', 'history'], url: 'https://github.com/headroomlabs-ai/headroom' },
  { id: 'claude-mem', touches: ['history'], url: 'https://github.com/thedotmack/claude-mem' },
  { id: 'caveman', touches: ['answers'], url: 'https://github.com/JuliusBrussee/caveman' },
  { id: 'serena', touches: ['read', 'search'], url: 'https://github.com/oraios/serena' },
  { id: 'ccusage', touches: [], url: 'https://github.com/ryoppippi/ccusage' },
];

function categoryOf(name = '') {
  if (name.startsWith('mcp__')) return 'mcp';
  if (['Bash', 'PowerShell', 'BashOutput'].includes(name)) return 'shell';
  if (['WebFetch', 'WebSearch'].includes(name)) return 'web';
  if (['Read', 'NotebookRead'].includes(name)) return 'read';
  if (['Grep', 'Glob', 'LS'].includes(name)) return 'search';
  return 'other';
}

// Text counts by its length; an image is left out, its JSON would count the encoding, not tokens.
function tokensOf(content) {
  const length = (block) => (typeof block?.text === 'string' ? block.text.length : block?.type === 'image' ? 0 : JSON.stringify(block ?? '').length);
  const chars = typeof content === 'string' ? content.length : Array.isArray(content) ? content.reduce((sum, block) => sum + length(block), 0) : length(content);
  return chars / LIMITS.bytesPerToken.value;
}

function unitsOf(usage) {
  const write = usage.cache_creation_input_tokens ?? 0;
  const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return (usage.input_tokens ?? 0) * W.input + (usage.cache_read_input_tokens ?? 0) * W.read + hour * W.write1h + (write - hour) * W.write5m + (usage.output_tokens ?? 0) * W.output;
}

// Main transcripts sit in <home>/.claude/projects/<project>/, a session's agents in
// <session>/subagents/ and its workflow agents one folder below <session>/subagents/workflows/.
// A link is not followed. A file not written to since `since` cannot hold a call of the window.
export function transcriptFiles(home, since) {
  const root = path.join(home, '.claude', 'projects');
  const list = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const files = [];
  const take = (dir, caller) => {
    for (const entry of list(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl') && statSync(file).mtimeMs >= since) files.push({ file, caller });
    }
  };
  for (const project of list(root).filter((entry) => entry.isDirectory())) {
    const dir = path.join(root, project.name);
    take(dir, 'main');
    for (const session of list(dir).filter((entry) => entry.isDirectory())) {
      const agents = path.join(dir, session.name, 'subagents');
      take(agents, 'subagent');
      const flows = path.join(agents, 'workflows');
      for (const flow of list(flows).filter((entry) => entry.isDirectory())) take(path.join(flows, flow.name), 'workflow');
    }
  }
  return files;
}

function emptyTotals() {
  return {
    files: { main: 0, subagent: 0, workflow: 0 },
    calls: 0,
    units: 0,
    unreadable: 0,
    callers: { main: 0, subagent: 0, workflow: 0 },
    models: new Map(),
    thinking: 0,
    answers: 0,
    base: 0,
    pieces: {},
    mainCalls: 0,
    long: { calls: 0, units: 0 },
    aboveStart: 0,
    searchOnly: { agents: 0, units: 0 },
    skillRuns: new Map(),
  };
}

const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value);

// One transcript into the totals. A response is written as one row per content block, all with
// the same message id and usage: the usage counts once, the tool calls of every row count.
//
// How big a piece is comes from the usage, not from its text: what the context grew by between
// two calls is shared among the pieces that arrived between them. What the model wrote gets its
// output tokens exactly; the rest of the growth goes to the other pieces by their length. Pieces
// before the first call of a segment are part of its start.
export function measureTranscript(text, caller, since, totals) {
  const seen = new Set();
  const names = new Map();
  const used = new Set();
  const events = [];
  let pending = [];
  let previous = null;
  let base = null;
  let units = 0;
  const piece = (category, tokens) => pending.push({ category, tokens });
  const call = (context, output, counted) => {
    if (previous !== null) {
      const exact = pending.filter((entry) => entry.exact).reduce((sum, entry) => sum + entry.tokens, 0);
      const rough = pending.filter((entry) => !entry.exact);
      const length = rough.reduce((sum, entry) => sum + entry.tokens, 0);
      const factor = length > 0 ? Math.max(0, context - previous - exact) / length : 0;
      for (const entry of rough) entry.tokens *= factor;
      events.push(...pending);
    }
    events.push({ call: true, counted });
    pending = [{ category: 'history', tokens: output, exact: true }];
    previous = context;
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      totals.unreadable += 1;
      continue;
    }
    const inWindow = Date.parse(row.timestamp) >= since;
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      events.push({ boundary: true });
      pending = [];
      previous = null;
      continue;
    }
    if (row.type === 'attachment') {
      const kind = String(row.attachment?.type ?? '');
      piece(kind.startsWith('hook_') ? 'hooks' : 'other', tokensOf(kind.startsWith('hook_') ? row.attachment.content : row.attachment));
      continue;
    }
    const message = row.message ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (row.type === 'user') {
      for (const block of content) {
        if (block?.type === 'tool_result') piece(categoryOf(names.get(block.tool_use_id)), tokensOf(block.content));
      }
      // A skill run by its slash command: only the command name is taken from what was typed.
      const typed = typeof message.content === 'string' ? message.content : content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
      piece('other', typed.length / LIMITS.bytesPerToken.value);
      if (inWindow) for (const match of typed.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) add(totals.skillRuns, match[1], 1);
      continue;
    }
    if (row.type !== 'assistant') continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      names.set(block.id, block.name);
      used.add(block.name);
      if (inWindow && block.name === 'Skill' && typeof block.input?.skill === 'string') add(totals.skillRuns, block.input.skill, 1);
    }
    const usage = message.usage;
    if (!usage || !message.id || seen.has(message.id) || message.model === '<synthetic>') continue;
    seen.add(message.id);
    const context = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    base ??= context;
    // What the model wrote stays in the context for the calls after it.
    call(context, usage.output_tokens ?? 0, inWindow);
    if (!inWindow) continue;
    const cost = unitsOf(usage);
    const thinking = usage.output_tokens_details?.thinking_tokens ?? 0;
    units += cost;
    totals.calls += 1;
    totals.units += cost;
    totals.callers[caller] += cost;
    add(totals.models, message.model ?? 'unknown', cost);
    totals.thinking += thinking * W.output;
    totals.answers += Math.max(0, (usage.output_tokens ?? 0) - thinking) * W.output;
    // The start is the front of the prompt: read from the cache as far as the cache reaches, and
    // written again past that, after a pause that let the cache expire.
    const read = usage.cache_read_input_tokens ?? 0;
    const written = usage.cache_creation_input_tokens ?? 0;
    const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const start = Math.min(context, base);
    const startCost = Math.min(start, read) * W.read + Math.max(0, start - read) * (written > 0 ? (hour * W.write1h + (written - hour) * W.write5m) / written : W.input);
    totals.base += startCost;
    if (caller === 'main') {
      totals.mainCalls += 1;
      // The start is priced at the write rate also where it was plain input, so this can dip below zero.
      totals.aboveStart += Math.max(0, cost - (usage.output_tokens ?? 0) * W.output - startCost);
      if (context > TOKENS.longContext.value) {
        totals.long.calls += 1;
        totals.long.units += cost;
      }
    }
  }
  // A piece is written by the first counted call after it and read by every one after that.
  let later = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.boundary) later = 0;
    else if (event.call) later += event.counted ? 1 : 0;
    else if (later > 0) totals.pieces[event.category] = (totals.pieces[event.category] ?? 0) + event.tokens * (W.write5m + W.read * (later - 1));
  }
  if (units > 0) totals.files[caller] += 1;
  if (caller !== 'main' && used.size > 0 && [...used].every((name) => SEARCH_TOOLS.has(name))) {
    totals.searchOnly.agents += 1;
    totals.searchOnly.units += units;
  }
  return totals;
}

function enabledPlugins(file) {
  try {
    const plugins = JSON.parse(readFileSync(file, 'utf8'))?.enabledPlugins;
    return plugins && typeof plugins === 'object' ? Object.entries(plugins).filter(([, on]) => on === true).map(([id]) => id.toLowerCase()) : [];
  } catch {
    return [];
  }
}

// Which third-party tool the setup already has: a hook that runs it, an enabled plugin, an MCP
// server of that name. Headroom and ccusage leave no trace these files show, so they are not asked.
function installed(setup) {
  const hooks = setup.settings.flatMap((entry) => entry.hooks ?? []);
  const plugins = setup.settings.filter((entry) => entry.kind !== 'mcp' && entry.valid && entry.keys.includes('enabledPlugins')).flatMap((entry) => enabledPlugins(entry.path));
  const servers = setup.settings.flatMap((entry) => entry.servers ?? []).map((name) => name.toLowerCase());
  const plugin = (name) => plugins.some((id) => id === name || id.startsWith(`${name}@`));
  return {
    rtk: hooks.some((hook) => /\brtk\b/i.test(`${hook.command ?? ''} ${hook.scripts.join(' ')}`)),
    'context-mode': plugin('context-mode'),
    'claude-mem': plugin('claude-mem'),
    caveman: plugin('caveman'),
    serena: servers.includes('serena') || plugin('serena'),
  };
}

const text = (value) => (typeof value === 'string' ? value : '');

// Skills offered to the model that no Skill call and no slash command ran in the window, with
// what each costs in the listing at every session start.
function unusedSkills(setup, runs) {
  const ran = (name) => runs.has(name) || [...runs.keys()].some((key) => key.endsWith(`:${name}`));
  return setup.files
    .filter((file) => file.kind === 'skill' && file.frontMatter?.data?.['disable-model-invocation'] !== true && !ran(file.name))
    .map((file) => {
      const data = file.frontMatter?.data ?? {};
      const described = [text(data.description), text(data.when_to_use)].filter(Boolean).join(' ').slice(0, LIMITS.skillDescriptionChars.value);
      return { name: file.name, scope: file.scope, project: file.project, tokens: Math.ceil(Buffer.byteLength(`${file.name} ${described}`.trim()) / LIMITS.bytesPerToken.value) };
    })
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

const day = (time) => new Date(time).toISOString().slice(0, 10);

export function measureTokens({ home, days = TOKENS.defaultDays, projects = [], now = new Date() }) {
  const since = now.getTime() - days * DAY;
  const totals = emptyTotals();
  for (const { file, caller } of transcriptFiles(home, since)) measureTranscript(readFileSync(file, 'utf8'), caller, since, totals);
  const setup = scan({ home, projects });
  const share = (value) => (totals.units ? value / totals.units : 0);
  const piece = (name) => totals.pieces[name] ?? 0;
  const touched = (categories) => categories.reduce((sum, name) => sum + (name === 'answers' ? totals.answers : piece(name)), 0);
  const on = installed(setup);
  const agents = totals.callers.subagent + totals.callers.workflow;
  return {
    days,
    from: day(since),
    to: day(now),
    files: totals.files,
    calls: totals.calls,
    units: Math.round(totals.units),
    unreadable: totals.unreadable,
    callers: Object.fromEntries(Object.entries(totals.callers).map(([name, value]) => [name, share(value)])),
    models: [...totals.models].sort((a, b) => b[1] - a[1]).map(([model, value]) => ({ model, share: share(value) })),
    builtin: [
      { id: 'new-session', share: share(totals.aboveStart), long: share(totals.long.units), calls: totals.long.calls, all: totals.mainCalls },
      { id: 'agent-model', share: share(agents), search: share(totals.searchOnly.units), count: totals.searchOnly.agents },
      { id: 'effort', share: share(totals.thinking) },
      { id: 'lean-base', share: share(totals.base), estimate: true },
      { id: 'lean-hooks', share: share(piece('hooks')), estimate: true },
    ].sort((a, b) => b.share - a.share),
    tools: TOOLS.map((tool) => ({ id: tool.id, url: tool.url, share: tool.touches.length ? share(touched(tool.touches)) : null, on: on[tool.id] ?? null })).sort((a, b) => (b.share ?? -1) - (a.share ?? -1)),
    unusedSkills: unusedSkills(setup, totals.skillRuns),
  };
}

export function renderTokens(result, lang) {
  const say = (key, params) => t(lang, key, params);
  const locale = lang === 'sk' ? 'sk-SK' : 'en-US';
  const percent = (value) => `${(value * 100).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  const number = (value) => Math.round(value).toLocaleString(locale);
  const out = [say('tokens.title', { days: result.days, from: result.from, to: result.to }), ''];
  if (result.calls === 0) return `${[...out, say('tokens.none', { days: result.days })].join('\n')}\n`;
  const agents = result.files.subagent + result.files.workflow;
  out.push(say('tokens.read', { files: number(result.files.main + agents), main: number(result.files.main), agents: number(agents), calls: number(result.calls) }));
  if (result.unreadable) out.push(say('tokens.unreadable', { count: number(result.unreadable) }));
  out.push(say('tokens.weights'));
  out.push(say('tokens.total', { units: number(result.units), main: percent(result.callers.main), subagent: percent(result.callers.subagent), workflow: percent(result.callers.workflow) }));
  out.push(say('tokens.models', { list: result.models.map((entry) => `${entry.model} ${percent(entry.share)}`).join(', ') }), '');
  out.push(say('tokens.builtin'));
  result.builtin.forEach((entry, index) => {
    const params = { ...entry, share: percent(entry.share) };
    if (entry.long !== undefined) Object.assign(params, { long: percent(entry.long), calls: number(entry.calls), all: number(entry.all) });
    if (entry.search !== undefined) Object.assign(params, { search: percent(entry.search), count: number(entry.count) });
    out.push(`${String(index + 1).padStart(2)}. ${say(`tokens.rec.${entry.id}`, params)}`);
  });
  out.push('', say('tokens.tools'));
  for (const entry of result.tools) {
    const found = entry.on ? ` (${say('tokens.on')})` : '';
    out.push(`  - ${say(`tokens.tool.${entry.id}`, { share: entry.share === null ? '' : percent(entry.share), url: entry.url })}${found}`);
  }
  out.push('');
  if (result.unusedSkills.length === 0) out.push(say('tokens.skills.none', { days: result.days }));
  else {
    const shown = result.unusedSkills.slice(0, SKILLS_SHOWN).map((skill) => `${skill.name} ~${number(skill.tokens)}`);
    const rest = result.unusedSkills.length - SKILLS_SHOWN;
    if (rest > 0) shown.push(say('tokens.skills.more', { count: number(rest) }));
    const total = result.unusedSkills.reduce((sum, skill) => sum + skill.tokens, 0);
    out.push(say('tokens.skills', { days: result.days, count: number(result.unusedSkills.length), tokens: number(total) }), `  ${shown.join(', ')}`);
  }
  out.push('', say('tokens.estimate'));
  return `${out.join('\n')}\n`;
}

// `claude-health tokens ...` and `node tokens.mjs ...`: the report as text, or as JSON with --json.
// A wrong option throws a UsageError.
export function tokensCommand(argv, { cwd = process.cwd(), home = os.homedir(), lang: fallback = 'en' } = {}) {
  const args = parseArgs(argv, { days: 'number', home: 'string', projects: 'list', lang: 'string', json: 'boolean' });
  const days = args.days ?? TOKENS.defaultDays;
  if (days < 1 || days > TOKENS.maxDays) throw new UsageError(`--days needs a number from 1 to ${TOKENS.maxDays}, got ${days}`);
  const lang = args.lang ?? fallback;
  if (!LANGS.includes(lang)) throw new UsageError(`--lang needs one of ${LANGS.join(', ')}, got "${lang}"`);
  const folder = args.home ?? home;
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--home is not a folder: ${folder}`);
  const projects = args.projects.length ? args.projects : isProject(cwd) ? [cwd] : [];
  const result = measureTokens({ home: folder, days, projects });
  return args.json ? `${JSON.stringify(result, null, 2)}\n` : renderTokens(result, lang);
}

runCli(import.meta.url, (argv) => {
  process.stdout.write(tokensCommand(argv));
});
