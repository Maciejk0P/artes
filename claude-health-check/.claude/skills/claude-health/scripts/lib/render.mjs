// Every screen of the console, as a pure function: (data, { lang, colour, unicode, width }) -> lines.
// The launcher prints these lines in colour; inside Claude Code ui.mjs prints them plain and the
// wizard repeats them in a code fence. One renderer, so the two cannot drift apart.
//
// Data is the view model of lib/view.mjs, plus small objects the caller builds (the run, a card,
// a receipt). Nothing here reads a file, measures a terminal or knows the time.

import { CHANGES, NEVER } from './promise.mjs';
import { STRINGS, assertLang } from './strings.mjs';
import { GLYPHS, PAGE, WIDTH, asciiSafe, between, cut as cutText, formatNumber, padEnd, padStart, paint, shortPath as shortenPath, visible, widthOf, wrap } from './term.mjs';

export const STEPS = ['language', 'scope', 'scan', 'report', 'changes', 'summary'];
export const PANELS = ['overview', 'findings', 'context', 'skills'];
// What a panel may take: the page minus the rail, the tab line, a blank line under each and two
// lines to spare.
export const PANEL_LINES = PAGE - 6;

const SEVERITIES = ['high', 'medium', 'low'];

function skin(o = {}) {
  const lang = assertLang(o.lang ?? 'en');
  const unicode = o.unicode !== false;
  const G = unicode ? GLYPHS.unicode : GLYPHS.ascii;
  const W = Math.max(WIDTH, o.width ?? WIDTH);
  // Every text that is not this program's own passes here before a colour is put on it: it comes
  // out as one line, with a visible mark for what a terminal would act on (lib/term.mjs, visible).
  const safe = unicode ? (text) => visible(text) : (text) => asciiSafe(visible(text));
  const c = paint(Boolean(o.colour));
  const glyphs = { sep: G.sep, ell: G.ell, arrow: G.arrow, approx: G.approx, neq: G.neq, times: G.times, flow: G.flow, dash: G.dash };
  const tr = (key, params = {}) => {
    const template = STRINGS[lang][key];
    if (template === undefined) throw new Error(`Unknown string "${key}" for language "${lang}"`);
    const all = { ...glyphs, ...params };
    // {count:file|files} picks a word by the number it follows: English needs two forms.
    const text = template.replace(/\{(\w+):([^|}]*)\|([^}]*)\}/g, (_, name, one, other) => (Number(all[name]) === 1 ? one : other)).replace(/\{(\w+)\}/g, (_, name) => {
      if (all[name] === undefined || all[name] === null) throw new Error(`String "${key}" needs a value for {${name}}`);
      // What is filled in may come from a scanned file: it stays on the line it is put into.
      return visible(String(all[name]));
    });
    // The sentence itself is this program's own, and one of them (the help text) is several lines.
    return unicode ? text : asciiSafe(text);
  };
  return {
    lang, G, W, safe, tr, c,
    tone: { high: c.red, medium: c.yellow, low: c.cyan, review: c.dim },
    fmt: (number) => formatNumber(number, lang),
    // The two helpers that fit a text into its place on a line take a text of any shape.
    cut: (text, max) => cutText(safe(text), max, G),
    short: (label, max) => shortenPath(safe(label), max, G),
    rule: (title) => {
      const head = `  ${G.h}${G.h} ${title} `;
      return `  ${c.dim(G.h + G.h)} ${c.bold(title)} ${c.dim(G.h.repeat(Math.max(0, W - widthOf(head))))}`;
    },
  };
}

// The first `max` rows, or one row fewer and a line that says how many are left out.
function fitRows(rows, max, more) {
  if (rows.length <= max) return rows;
  const shown = rows.slice(0, Math.max(0, max - 1));
  return [...shown, more(rows.length - shown.length)];
}

// A bar against a limit: `cells` up to the limit, the mark, then up to `overCells` beyond it.
// Over the limit is told three ways: a different block, the colour, and a number next to the bar.
function bar(s, value, limit, cells = 20, overCells = 5) {
  const ratio = limit > 0 ? value / limit : 0;
  const filled = value <= 0 ? 0 : Math.max(1, Math.min(cells, Math.round(Math.min(ratio, 1) * cells)));
  const over = ratio > 1 ? Math.max(1, Math.min(overCells, Math.round(((ratio - 1) / 0.25) * overCells))) : 0;
  const tone = ratio > 1 ? s.c.red : ratio > 0.8 ? s.c.yellow : s.c.cyan;
  return tone(s.G.full.repeat(filled)) + s.c.dim(s.G.empty.repeat(cells - filled)) + s.c.dim(s.G.mark) + s.c.red(s.G.over.repeat(over)) + ' '.repeat(overCells - over);
}

function share(s, part, total, cells) {
  const filled = part <= 0 || total <= 0 ? 0 : Math.max(1, Math.min(cells, Math.round((part / total) * cells)));
  return s.c.cyan(s.G.full.repeat(filled)) + ' '.repeat(cells - filled);
}

const percentText = (value, limit) => {
  const percent = limit > 0 ? Math.round((value / limit) * 100) : 0;
  return percent > 999 ? '>999%' : `${percent}%`;
};

// --- the step rail and the banner -----------------------------------------------------------------

// The step indicator, the first line of every screen. The double bar marks where this program
// ends and Claude Code begins.
export function rail(step, o) {
  const s = skin(o);
  let line = '  ';
  STEPS.forEach((name, index) => {
    const label = s.tr(`ui.rail.${name}`);
    if (index < step) line += `${s.c.green(s.G.done)} ${label}`;
    else if (index === step) line += s.c.boldCyan(`${s.G.now} ${label.toUpperCase()}`);
    else line += s.c.dim(`${s.G.todo} ${label}`);
    if (index < STEPS.length - 1) line += s.c.dim(index === 3 ? ` ${s.G.hand} ` : ` ${s.G.h} `);
  });
  return between(line, s.c.dim(`${Math.min(step, STEPS.length - 1) + 1}/${STEPS.length}`), s.W);
}

// info: { version, session }. Inside Claude Code the two "who does what" lines are one sentence.
// What the tool changes and never changes is a screen of its own, shown right after this one
// once the language is known (promise below); the banner says in one line what is read.
export function banner(info, o) {
  const s = skin(o);
  const [top, middle, bottom] = s.G.pulse;
  const lines = [];
  if (top) lines.push(s.c.cyan(top));
  lines.push(between(`${s.c.cyan(middle)}  ${s.c.bold('claude-health check')}`, s.c.dim(info.version), s.W));
  lines.push(`${padEnd(s.c.cyan(bottom), widthOf(middle))}  ${s.tr('ui.banner.tagline')}`);
  lines.push('');
  const fact = (key) => `  ${padEnd(s.c.bold(s.tr(`ui.banner.${key}.k`)), 9)}${s.tr(`ui.banner.${key}.v`)}`;
  lines.push(fact('reads'), '');
  if (info.session) {
    lines.push(...wrap(s.tr('ui.banner.session'), s.W - 2).map((line) => `  ${line}`));
  } else {
    const who = (key) => between(`  ${padEnd(s.c.bold(s.tr(`ui.banner.${key}.k`)), 15)}${s.tr(`ui.banner.${key}.v`)}`, s.c.dim(s.tr(`ui.banner.${key}.cost`)), s.W);
    lines.push(who('here'), who('claude'));
  }
  return lines;
}

// --- what it changes, what it never changes -------------------------------------------------------

// The two short lists a person meets before anything is read: what the tool changes (only after
// a yes to that one change, with a backup first) and what it never changes. The lines are those
// of lib/promise.mjs, which a test holds to the code that writes; nothing else is said here.
export function promise(o) {
  const s = skin(o);
  const bullet = (key) => wrap(s.tr(key), s.W - 4).map((line, index) => `  ${index === 0 ? s.c.dim(s.G.sep) : ' '} ${line}`);
  return [
    between(`  ${s.c.bold(s.tr('ui.promise.changes.title'))}`, s.c.dim(s.tr('ui.promise.changes.sub')), s.W),
    ...[...CHANGES.map((line) => line.key), 'folder'].flatMap((key) => bullet(`ui.promise.changes.${key}`)),
    '',
    `  ${s.c.bold(s.tr('ui.promise.never.title'))}`,
    ...NEVER.flatMap((key) => bullet(`ui.promise.never.${key}`)),
  ];
}

// --- questions of the launcher --------------------------------------------------------------------

// q: { question, sub, options: [{ label, desc }], def }. A numbered list; the last line is the
// prompt, which names the default, and the answer is typed after it.
export function numbered(q, o) {
  const s = skin(o);
  const lines = wrap(q.question, s.W - 4).map((line, index) => `  ${index === 0 ? s.G.ask : ' '} ${line}`);
  if (q.sub) lines.push(...wrap(q.sub, s.W - 4).map((line) => `    ${line}`));
  q.options.forEach((option, index) => {
    lines.push(`    ${index + 1}  ${option.label}`);
    if (option.desc) lines.push(...wrap(option.desc, s.W - 9).map((line) => ' '.repeat(9) + line));
  });
  lines.push(`  ${s.tr('ui.select.type', { n: q.options.length, def: (q.def ?? 0) + 1 })}`);
  return lines;
}

// The one line an answered question collapses to.
export function answered(key, value, o) {
  const s = skin(o);
  return `  ${s.c.green(s.G.done)} ${padEnd(s.tr(`ui.answer.${key}`), 10)}${s.cut(s.safe(value), s.W - 14)}`;
}

// The folder question: the ask line, the prompt mark, and the line that confirms or refuses a path.
export function inputAsk(text, o) {
  const s = skin(o);
  return wrap(text, s.W - 4).map((line, index) => `  ${index === 0 ? s.c.boldCyan(s.G.ask) : ' '} ${s.c.bold(line)}`);
}
export function inputMark(o) {
  const s = skin(o);
  return `  ${s.c.cyan(s.G.input)} `;
}
export function inputResult(ok, text, o) {
  const s = skin(o);
  return wrap(s.safe(text), s.W - 6).map((line, index) => `    ${index === 0 ? (ok ? s.c.green(s.G.done) : s.c.red(s.G.times)) : ' '} ${line}`);
}

// What "every project under my home folder" means, said before the search starts.
export function machineFacts(caps, o) {
  const s = skin(o);
  return ['ui.scope.machine.1', 'ui.scope.machine.2', 'ui.scope.machine.3', 'ui.scope.machine.4']
    .flatMap((key) => wrap(s.tr(key, { dirs: s.fmt(caps.maxDirs), depth: caps.maxDepth }), s.W - 6).map((line, index) => `    ${index === 0 ? s.c.dim(s.G.todo) : ' '} ${line}`));
}

// The scope as one value: for the answered line and the pick-up block.
export function scopeText(view, o) {
  const s = skin(o);
  const names = view.scope.projects.map((project) => project.name);
  if (view.scope.machine) return s.tr('ui.scope.value.machine', { count: names.length });
  if (!names.length) return s.tr('ui.scope.value.user');
  return s.tr('ui.scope.value.projects', { count: names.length, names: names.join(', ') });
}

// --- analysis in progress -------------------------------------------------------------------------

const PROGRESS_KEYS = ['user', 'projects', 'nested', 'imports', 'settings', 'checks', 'tax', 'report'];
const TIME_SLOT = 6;

function progressKeyWidth(s) {
  return 2 + Math.max(...PROGRESS_KEYS.map((key) => widthOf(s.tr(`ui.progress.${key}.k`))));
}

// One finished step: its name, what was found, and how long it took when that was measured.
export function progressRow(key, value, ms, o) {
  const s = skin(o);
  const keyWidth = progressKeyWidth(s);
  const text = s.safe(value);
  const measured = ms === undefined || ms === null ? '' : s.tr('ui.ms', { ms: Math.max(1, Math.round(ms)) });
  // The time is given up before a word of the result is, and it stands two columns clear of the
  // result or not at all. The room it is given is that of "999 ms" whatever was measured, so the
  // same result prints the same row on every run.
  const time = measured && widthOf(text) + 2 + Math.max(TIME_SLOT, widthOf(measured)) <= s.W - 4 - keyWidth ? measured : '';
  const room = s.W - 4 - keyWidth - (time ? widthOf(time) + 1 : 0);
  return between(`  ${s.c.green(s.G.done)} ${padEnd(s.tr(`ui.progress.${key}.k`), keyWidth)}${s.cut(text, room)}`, s.c.dim(time), s.W).replace(/\s+$/, '');
}

// The values of the rows, in order: [key, text].
export function progressValues(view, info, o) {
  const s = skin(o);
  const counts = view.counts;
  const worst = view.contextTax.places.find((place) => place.key === view.contextTax.worst);
  const leftOut = view.scope.nested.withSetup - view.scope.nested.included;
  return [
    ['user', s.tr('ui.progress.user.v', { count: s.fmt(counts.userFiles) })],
    ['projects', s.tr('ui.progress.projects.v', { count: s.fmt(counts.projects), files: s.fmt(counts.projectFiles) })],
    ...(leftOut > 0 ? [['nested', s.tr('ui.progress.nested.v', { count: s.fmt(leftOut) })]] : []),
    ['imports', s.tr('ui.progress.imports.v', { read: counts.imports.followed, missing: counts.imports.missing, deep: counts.imports.tooDeep })],
    ['settings', s.tr('ui.progress.settings.v', { count: counts.settings, hooks: counts.hooks })],
    ['checks', s.tr('ui.progress.checks.v', { checks: counts.checks, findings: counts.findings.total, candidates: counts.candidates.total, review: counts.review })],
    ...(worst ? [['tax', s.tr('ui.progress.tax.v', { tokens: s.fmt(worst.tokens), place: worst.label })]] : []),
    ['report', info.reportName],
  ];
}

// info: { reportName, timings: { scanMs, checksMs, reportMs }, capped }.
export function progress(view, info, o) {
  const s = skin(o);
  const timings = info.timings ?? {};
  const timeOf = { settings: timings.scanMs, checks: timings.checksMs, report: timings.reportMs };
  const lines = progressValues(view, info, o).map(([key, value]) => progressRow(key, value, timeOf[key], o));
  lines.push('', ...progressDone(info, o));
  return lines;
}

export function progressDone(info, o) {
  const s = skin(o);
  const timings = info.timings ?? {};
  const total = (timings.scanMs ?? 0) + (timings.checksMs ?? 0) + (timings.reportMs ?? 0);
  const secs = (total / 1000).toFixed(2).replace('.', s.lang === 'sk' ? ',' : '.');
  const lines = [];
  if (info.capped) lines.push(...wrap(s.tr('ui.progress.capped'), s.W - 4).map((line, index) => `  ${index === 0 ? s.c.yellow(s.G.medium) : ' '} ${line}`));
  // "No tokens used" is true of the launcher alone: a run inside Claude Code is paid for from the
  // person's plan, and says nothing about tokens here.
  lines.push(...wrap(s.tr(info.session ? 'ui.progress.done.session' : 'ui.progress.done', { secs }), s.W - 2).map((line) => `  ${line}`));
  return lines;
}

// --- the report: four panels ----------------------------------------------------------------------

export function tabs(active, view, o) {
  const s = skin(o);
  const names = {
    overview: s.tr('ui.tab.overview'),
    findings: `${s.tr('ui.tab.findings')} ${view.counts.findings.total}`,
    context: s.tr('ui.tab.context'),
    skills: `${s.tr('ui.tab.skills')} ${view.skills.total}`,
  };
  const last = PANELS[PANELS.length - 1];
  const tab = (key) => (key === active ? s.c.inverse(`[ ${names[key]} ]`) : `  ${s.c.dim(names[key])}${key === last ? '' : '  '}`);
  return `  ${PANELS.map(tab).join(' ')}`;
}

function severityLine(s, view) {
  const part = (key, count) => `${s.tone[key](s.G[key])} ${count} ${s.tr(`ui.sev.${key}`)}`;
  const { high, medium, low } = view.counts.findings;
  return [part('high', high), part('medium', medium), part('low', low), part('review', view.counts.review)].join('   ');
}

const NAME = 33;
function meterRow(s, name, value, limit) {
  const tone = value > limit ? s.c.red : (text) => text;
  return `  ${padEnd(s.short(s.safe(name), NAME - 1), NAME)}${padStart(s.fmt(value), 6)}   ${bar(s, value, limit)} ${tone(padStart(percentText(value, limit), 5))}`.replace(/\s+$/, '');
}
// The column heading is the legend: its mark stands exactly above the marks of the bars.
function meterHead(s, title, limit) {
  const left = `  ${padEnd(s.c.bold(title), NAME)}${padStart(s.c.dim(s.tr('ui.col.lines')), 6)}   `;
  return `${left}${padStart(s.c.dim(s.tr('ui.scale.under', { limit })), 19)} ${s.c.dim(s.G.mark)} ${s.c.dim(s.tr('ui.scale.over'))}`;
}

export function overview(view, o) {
  const s = skin(o);
  const fileLimit = view.limits.memoryFileLines.value;
  const totalLimit = view.limits.alwaysLoadedLines.value;
  const memory = view.files.filter((file) => file.limit !== null).sort((a, b) => b.lines - a.lines);
  const places = [...view.loaded.places].sort((a, b) => b.lines - a.lines);
  const counts = `  ${s.tr('ui.overview.counts', { files: view.counts.files, projects: view.counts.projects })}`;
  const severities = severityLine(s, view);
  const head = widthOf(counts) + 2 + widthOf(severities) <= s.W ? [between(counts, severities, s.W)] : [counts, `  ${severities}`];
  const note = wrap(s.tr('ui.overview.note', { fileLimit, total: totalLimit }), s.W - 2).map((line) => `  ${s.c.dim(line)}`);
  // What is left of the panel after the fixed lines is shared by the two tables.
  const room = PANEL_LINES - head.length - note.length - 5;
  const placeRows = fitRows(
    places.map((place) => meterRow(s, place.label, place.lines, place.limit)),
    Math.min(4, Math.max(2, room - 2)),
    (count) => `  ${s.c.dim(s.tr('ui.overview.moreplaces', { count }))}`,
  );
  const memoryRows = memory.length
    ? fitRows(
        memory.map((file) => meterRow(s, file.label, file.lines, fileLimit)),
        Math.max(2, room - placeRows.length),
        (count) => `  ${s.c.dim(s.tr('ui.overview.more', { count }))}`,
      )
    : [`  ${s.c.dim(s.tr('files.none'))}`];
  return [...head, '', meterHead(s, s.tr('ui.overview.memory'), fileLimit), ...memoryRows, '', meterHead(s, s.tr('ui.overview.loaded'), totalLimit), ...placeRows, '', ...note];
}

const LABEL = 36;

// One line per kind of finding: a short label, how often, then where.
function findingRows(s, groups) {
  return [...groups]
    .map((group, index) => ({ group, index }))
    .sort((a, b) => b.group.count - a.group.count || a.index - b.index)
    .map(({ group }) => {
      const name = group.check === 'judgement' ? s.safe(group.title) : s.tr(`ui.short.${group.check}`);
      const files = [...new Set(group.items.map((item) => item.label))];
      const numbers = group.items.filter((item) => item.label === files[0] && item.line !== null).map((item) => item.line);
      const where = files[0] + (numbers.length ? `:${numbers.join(', ')}` : '') + (files.length > 1 ? ` +${files.length - 1}` : '');
      const times = group.count > 1 ? ` ${s.G.times}${group.count}` : '';
      return { count: group.count, line: `    ${padEnd(s.cut(name, LABEL - 1 - widthOf(times)) + times, LABEL)}${s.c.dim(s.short(where, s.W - 4 - LABEL))}` };
    });
}

export function findings(view, o) {
  const s = skin(o);
  const sections = view.findings.bySeverity.filter((entry) => entry.count > 0);
  const review = view.review.items;
  const sentence = view.candidates.total ? wrap(s.safe(view.candidates.sentence), s.W - 2).map((line) => `  ${line}`) : [];
  if (!sections.length && !review.length) return [`  ${s.safe(view.findings.none)}`, ...(sentence.length ? ['', ...sentence] : [])];

  const reviewRows = fitRows(
    review.map((item) => `    ${padEnd(s.cut(s.tr(`ui.short.${item.check}`), LABEL - 1), LABEL)}${s.c.dim(s.short(`${item.projectLabel}: ${item.servers.join(', ')}`, s.W - 4 - LABEL))}`),
    2,
    (count) => `    ${s.c.dim(s.tr('ui.findings.more', { count }))}`,
  );
  // The room for item lines: high severity first, then three fifths to medium and the rest to
  // low, each with a line that counts what is left out.
  let room = PANEL_LINES - sections.length - (review.length ? 1 + reviewRows.length : 0) - (sentence.length ? 1 + sentence.length : 0);
  const rows = Object.fromEntries(SEVERITIES.map((key) => [key, findingRows(s, view.findings.bySeverity.find((entry) => entry.severity === key)?.groups ?? [])]));
  const take = { high: Math.min(rows.high.length, 3) };
  room -= take.high;
  take.medium = Math.min(rows.medium.length, Math.ceil(room * 0.6));
  take.low = Math.min(rows.low.length, Math.max(0, room - take.medium));
  take.medium = Math.min(rows.medium.length, Math.max(0, room - take.low));

  const lines = [];
  for (const section of sections) {
    const key = section.severity;
    lines.push(`  ${s.tone[key](`${s.G[key]} ${s.safe(section.label).toUpperCase()} ${section.count}`)}`);
    const shown = rows[key].length <= take[key] ? rows[key] : rows[key].slice(0, Math.max(1, take[key] - 1));
    lines.push(...shown.map((row) => row.line));
    const hidden = rows[key].slice(shown.length).reduce((sum, row) => sum + row.count, 0);
    if (hidden) lines.push(`    ${s.c.dim(s.tr('ui.findings.more', { count: hidden }))}`);
  }
  if (review.length) {
    lines.push(between(`  ${s.c.dim(`${s.G.review} ${s.tr('ui.sev.review').toUpperCase()} ${review.length}`)}`, s.c.dim(s.tr('ui.findings.review.note')), s.W));
    lines.push(...reviewRows);
  }
  if (sentence.length) lines.push('', ...sentence);
  return lines;
}

function contributorName(s, part) {
  if (part.type === 'skill-listing') return s.tr('ui.context.skills', { count: part.count });
  if (part.type === 'command-listing') return s.tr('ui.context.commands', { count: part.count });
  if (part.type === 'auto-memory') return s.tr('ui.context.auto');
  return s.safe(part.label);
}

const STAGES = ['user', 'project', 'imports', 'rules', 'autoMemory', 'listing'];

export function context(view, o) {
  const s = skin(o);
  const places = [...view.contextTax.places].sort((a, b) => b.tokens - a.tokens);
  const lines = [
    `  ${s.c.bold(s.tr('ui.context.title'))}  ${s.tr('ui.context.sub')}`,
    ...wrap(s.safe(view.contextTax.estimate), s.W - 2).map((line) => `  ${s.c.dim(line)}`),
  ];
  if (!places.length) return lines;
  const [worst, ...others] = places;
  const tokens = (count) => s.tr('ui.context.tokens', { tokens: s.fmt(count) });
  lines.push('', between(`  ${s.c.bold(s.cut(s.safe(worst.label), s.W - 26))}`, s.c.bold(tokens(worst.tokens)), s.W));
  const top = worst.contributors.slice(0, 4).map((part) => ({ name: contributorName(s, part), tokens: part.tokens }));
  const rest = worst.contributors.slice(4);
  if (rest.length === 1) top.push({ name: contributorName(s, rest[0]), tokens: rest[0].tokens });
  else if (rest.length) top.push({ name: s.tr('ui.context.more', { count: rest.length }), tokens: rest.reduce((sum, part) => sum + part.tokens, 0) });
  for (const entry of top) {
    const percent = worst.tokens ? `${Math.round((entry.tokens / worst.tokens) * 100)}%` : '0%';
    lines.push(`    ${padEnd(s.short(entry.name, 31), 32)}${padStart(s.fmt(entry.tokens), 7)}  ${share(s, entry.tokens, worst.tokens, 26)}${padStart(percent, 5)}`.replace(/\s+$/, ''));
  }
  // The console echo of the "how this setup loads" diagram that the HTML report draws.
  const gap = ` ${s.G.flow} `;
  const chain = (suffix) => STAGES.filter((key) => worst.stages[key] > 0).map((key) => ({ name: s.tr(`ui.stage.${key}${suffix}`), tokens: s.fmt(worst.stages[key]) }));
  const chainWidth = (list) => list.reduce((sum, stage) => sum + Math.max(widthOf(stage.name), widthOf(stage.tokens)), 0) + widthOf(gap) * (list.length - 1);
  // The full names when they fit on the line, the short ones when they do not.
  const stages = chainWidth(chain('')) <= s.W - 4 ? chain('') : chain('.short');
  if (stages.length > 1) {
    const cells = stages.map((stage) => Math.max(widthOf(stage.name), widthOf(stage.tokens)));
    lines.push('', `    ${s.c.dim(s.tr('ui.context.order'))}`);
    lines.push(`    ${stages.map((stage, index) => padEnd(stage.name, cells[index])).join(s.c.dim(gap))}`.replace(/\s+$/, ''));
    lines.push(`    ${stages.map((stage, index) => padEnd(s.c.cyan(stage.tokens), cells[index])).join(' '.repeat(widthOf(gap)))}`.replace(/\s+$/, ''));
  }
  if (others.length) {
    lines.push('');
    lines.push(
      ...fitRows(
        others.map((place) => between(`  ${s.cut(s.safe(place.label), s.W - 26)}`, tokens(place.tokens), s.W)),
        2,
        (count) => `  ${s.c.dim(s.tr('ui.context.moreplaces', { count }))}`,
      ),
    );
  }
  lines.push(`  ${s.c.dim(s.safe(view.contextTax.notCounted))}`);
  return lines;
}

const SKILL = 20;

function skillNote(s, row, note) {
  if (note.key === 'twin-same' || note.key === 'twin-differs') {
    const relation = note.key === 'twin-same' ? 'same' : 'differs';
    const twin = row.twins.find((entry) => entry.relation === relation);
    const where = twin && twin.label.startsWith('~/') ? '~/.claude/skills' : (twin?.label.split('/')[0] ?? '');
    return s.tr(`ui.note.${note.key}`, { where });
  }
  if (note.key === 'skill-description-too-long') {
    return s.tr('ui.note.skill-description-too-long', { chars: s.fmt(row.description.chars), limit: s.fmt(row.description.limit) });
  }
  return s.tr(`ui.note.${note.key}`);
}

export function skills(view, o) {
  const s = skin(o);
  const limit = view.skills.limit.value;
  const noteWidth = s.W - (4 + SKILL + 6 + 3 + 15);
  const scale = `${s.tr('ui.skills.scale', { limit })} ${s.G.mark}`;
  const lines = [`  ${padEnd(s.c.bold(s.tr('ui.skills.title')), SKILL + 2)}${padStart(s.c.dim(s.tr('ui.col.lines')), 6)}   ${padEnd(s.c.dim(padStart(scale, 11)), 15)}${s.c.dim(s.tr('ui.skills.notes'))}`];
  if (view.skills.total === 0) return [...lines, `  ${s.c.dim(s.tr('ui.skills.empty'))}`];

  const noted = (row) => Boolean(row.thirdParty) || row.notes.length > 0 || row.state === 'over';
  const rowLine = (row) => {
    // Somebody else's skill carries one note: what else was seen there is in the report.
    const notes = (row.thirdParty ? row.notes.slice(0, 1) : row.notes).map((note) => skillNote(s, row, note));
    const note = notes.length > 1 ? `${s.cut(notes[0], noteWidth - 3)} +${notes.length - 1}` : (notes[0] ?? '');
    const tone = row.state === 'over' ? s.c.red : (text) => text;
    const size = row.lines === null ? `${padStart(s.G.dash, 6)}   ${' '.repeat(13)}` : `${padStart(s.fmt(row.lines), 6)}   ${bar(s, row.lines, row.limit, 10, 2)}`;
    return `    ${padEnd(s.cut(row.name, SKILL - 1), SKILL)}${size}  ${tone(s.cut(note, noteWidth))}`.replace(/\s+$/, '');
  };
  const groups = view.skills.groups.filter((group) => group.count > 0);
  const empty = view.skills.groups.filter((group) => group.scope === 'project' && group.count === 0);
  const footer = ['', ...(empty.length ? [`  ${s.c.dim(s.cut(s.tr('ui.skills.none', { paths: empty.map((group) => group.label).join(', ') }), s.W - 2))}`] : []), `  ${s.c.dim(s.tr('ui.skills.thirdparty', { count: view.skills.thirdParty }))}`];
  const available = PANEL_LINES - lines.length - footer.length;

  // Rows are cut group by group until the panel fits; then whole groups are left to the report.
  const costOf = (list, cap) => list.reduce((sum, group, index) => sum + (index ? 2 : 1) + Math.min(group.count, cap), 0);
  let cap = 8;
  while (cap > 2 && costOf(groups, cap) > available) cap -= 1;
  let shown = groups;
  if (costOf(shown, cap) > available) {
    // One line says how many groups are left to the report.
    while (shown.length > 1 && costOf(shown, cap) + 1 > available) shown = shown.slice(0, -1);
  }

  shown.forEach((group, index) => {
    if (index) lines.push('');
    const title = group.scope === 'user' ? s.tr('ui.skills.user', { path: group.folderLabel, count: group.count }) : `${s.short(group.title, s.W - 10)} (${group.count})`;
    lines.push(`  ${s.c.bold(title)}`);
    const ordered = [...group.rows.filter(noted), ...group.rows.filter((row) => !noted(row))];
    lines.push(...fitRows(ordered.map(rowLine), cap, (count) => `    ${s.c.dim(s.tr('ui.skills.more', { count }))}`));
  });
  if (shown.length < groups.length) lines.push(`  ${s.c.dim(s.tr('ui.skills.moregroups', { count: groups.length - shown.length }))}`);
  return [...lines, ...footer];
}

const PANEL_BODY = { overview, findings, context, skills };

// One panel of the report. The panels are printed one after another; the rail is left out
// after the first one: the tab line alone says where one is.
export function panel(key, view, o, { rail: withRail = true } = {}) {
  return [...(withRail ? [rail(3, o), ''] : []), tabs(key, view, o), '', ...PANEL_BODY[key](view, o)];
}

// --- after the report -----------------------------------------------------------------------------

// run: { stamp, start, inside, report: { name, url } }, all ready to print.
export function reportLink(run, o, key = 'ui.next.report') {
  const s = skin(o);
  return [`  ${s.c.bold(s.tr(key))}`, `  ${s.c.cyan(run.report.url)}`];
}

// The scope question. `here` is the working directory when it is a project other than this tool.
export function scopeQuestion({ here = null } = {}, o) {
  const s = skin(o);
  return {
    question: s.tr('ui.scope.question'),
    sub: s.tr('ui.scope.always'),
    options: [
      ...(here ? [{ value: 'here', label: s.tr('ui.scope.here.label'), desc: s.short(s.safe(here), s.W - 9) }] : []),
      { value: 'user', label: s.tr('ui.scope.user.label'), desc: s.tr('ui.scope.user.desc') },
      { value: 'machine', label: s.tr('ui.scope.home.label'), desc: s.tr('ui.scope.home.desc') },
      { value: 'named', label: s.tr('ui.scope.named.label'), desc: s.tr('ui.scope.named.desc') },
    ],
    focused: 0,
  };
}

// Asked only when repositories with their own setup sit inside the scanned projects.
export function nestedQuestion(count, o) {
  const s = skin(o);
  return {
    question: s.tr('ui.nested.question', { count }),
    sub: s.tr('ui.nested.sub'),
    options: [
      { value: false, label: s.tr('ui.nested.no.label'), desc: s.tr('ui.nested.no.desc') },
      { value: true, label: s.tr('ui.nested.yes.label'), desc: s.tr('ui.nested.yes.desc') },
    ],
    focused: 0,
  };
}

// How to go on after the report, in a form no shell can damage. Claude Code is started by its
// bare name, in the folder of this tool, and the command for it is typed inside it: each stands
// on a line of its own, and the two are never one line.
// `folder`: the folder of this tool. The launcher may have been started from any folder, and the
// skill is a project skill of this one, so the folder is said: on a line of its own, as a place
// and not as an argument of a command, and never cut.
// `agent`: the run was started by an agent inside Claude Code, where nobody was asked anything
// and Claude Code is running already.
export function wayOn(run, o, { agent = false, folder } = {}) {
  const s = skin(o);
  const own = (text) => `         ${s.c.cyan(text)}`;
  if (agent) return [...wrap(s.tr('ui.agent.line'), s.W - 2).map((line) => `  ${line}`), own(run.inside)];
  if (!folder) throw new Error('How to continue needs the folder of the tool');
  const step = (number, key) => wrap(s.tr(key), s.W - 7).map((line, index) => `    ${index === 0 ? s.c.cyan(number) : ' '}  ${line}`);
  return [
    s.rule(s.tr('ui.next.title')),
    `  ${s.tr('ui.quit.bye')}`,
    `  ${s.tr('ui.next.needs')}`,
    '',
    ...step('1', 'ui.next.s1'),
    // A path is not a sentence: it is made printable, but never rewritten for the ASCII skin.
    `         ${visible(folder)}`,
    ...step(' ', 'ui.next.s1.then'),
    own(run.start),
    ...step('2', 'ui.next.s2'),
    own(run.inside),
    '',
    `  ${s.c.dim(s.tr('ui.next.waits', { dir: `~/.claude/health-check/run-${run.stamp}` }))}`,
    `  ${s.c.dim(s.tr('ui.next.stale'))}`,
  ];
}

// A setup with nothing to change: the report is there, and there is nothing to continue.
export function cleanLine(view, o) {
  const s = skin(o);
  return [`  ${s.c.green(s.G.done)} ${s.safe(view.findings.none)}`];
}

// A run on a home folder other than the person's own (--home): the wizard works on the
// person's own home folder, so there is nothing to continue.
export function foreignHome(o) {
  const s = skin(o);
  return wrap(s.tr('ui.quit.foreign'), s.W - 2).map((line) => `  ${line}`);
}

// What stands on the page at each step of the launcher. A question is a numbered list that
// ends in a prompt.
const ask = (q, o) => numbered({ ...q, def: q.focused ?? 0 }, o);
const answers = (list, o) => list.map(([key, value]) => answered(key, value, o));

export const compose = {
  launch: (info, q, o) => [...banner(info, o), '', rail(0, o), '', ...ask(q, o)],
  ask: (step, done, q, o) => [rail(step, o), '', ...answers(done, o), ...(done.length ? [''] : []), ...ask(q, o)],
  scan: (done, view, info, o) => [rail(2, o), '', ...answers(done, o), '', ...progress(view, info, o)],
};

// --- inside Claude Code ---------------------------------------------------------------------------

// info: { changed (number of files that changed since the scan), readable (files to read), judged (the reading is merged) }.
export function pickup(view, run, o, info) {
  const s = skin(o);
  const candidates = view.counts.candidates.open;
  return [
    rail(4, o),
    '',
    `  ${s.tr('ui.pickup.l1', { run: `run-${run.stamp}`, language: s.tr('ui.language.name') })}`,
    `  ${s.cut(scopeText(view, o), s.W - 2)}`,
    `  ${info.changed ? s.tr('ui.pickup.changed', { count: info.changed, findings: view.counts.findings.total }) : s.tr('ui.pickup.same', { findings: view.counts.findings.total })}`,
    `  ${info.judged ? s.tr('ui.pickup.judged') : candidates ? s.tr('ui.pickup.reading', { files: info.readable, candidates }) : s.tr('ui.pickup.nothing', { files: info.readable })}`,
  ];
}

// A quote is verbatim: a long line continues on the next row. The break stands for the one
// space it falls on; a line with no space near the edge is cut where the row ends. No other
// character is added, dropped or changed.
// A line has no bounded length, so it is gone through once, from the left.
function hardWrap(text, first, rest) {
  const rows = [];
  const chars = [...text];
  let from = 0;
  let room = first;
  while (chars.length - from > room) {
    let space = -1;
    for (let index = room; index > room * 0.6; index -= 1) {
      if (chars[from + index] === ' ') {
        space = index;
        break;
      }
    }
    rows.push(chars.slice(from, from + (space === -1 ? room : space)).join(''));
    from += space === -1 ? room : space + 1;
    room = rest;
  }
  rows.push(chars.slice(from).join(''));
  return rows;
}

// A quote is a block of lines by the tool's own making: it is split where the tool joined it, and
// each line is then one line whatever it holds.
function quoteLines(s, text, max = 2) {
  const all = String(text).split('\n');
  const shown = all.slice(0, max).flatMap((line) => hardWrap(visible(line), s.W - 4, s.W - 6).map((row, index) => `  ${s.c.dim(s.G.v)} ${index ? '  ' : ''}${row}`));
  if (all.length > max) shown.push(`  ${s.c.dim(s.G.v)} ${s.c.dim(`${s.G.ell} +${all.length - max}`)}`);
  return shown;
}

// What the reading changed. The view is the one built after the judgement was merged.
export function judged(view, o, info = {}) {
  const s = skin(o);
  const items = view.candidates.groups.flatMap((group) => group.items);
  const byFinding = new Map(view.findings.bySeverity.flatMap((entry) => entry.groups.flatMap((group) => group.items)).map((item) => [item.id, item]));
  const confirmedIds = new Set(items.filter((item) => item.finding).map((item) => item.finding));
  const added = [...byFinding.values()].filter((item) => item.check === 'judgement' && !confirmedIds.has(item.id));
  const dismissed = items.filter((item) => item.status === 'dismissed');
  const confirmed = items.filter((item) => item.status === 'confirmed').map((item) => byFinding.get(item.finding)).filter(Boolean);

  const head = [
    rail(4, o),
    '',
    between(
      `  ${s.c.bold(s.tr('ui.judged.title'))}`,
      s.tr('ui.judged.counts', { candidates: view.candidates.total, confirmed: confirmed.length, dismissed: dismissed.length, added: added.length }),
      s.W,
    ),
  ];
  const tail = [''];
  if (info.rewritten !== false) tail.push(`  ${s.tr('ui.judged.report')}`);
  tail.push(`  ${view.counts.findings.total ? s.tr('ui.judged.queue', { count: info.queue ?? view.counts.findings.total }) : s.safe(view.findings.none)}`);

  const blocks = [];
  // What was confirmed or added comes back as a card; here it is named with its quote.
  const findingBlock = (item) => [
    between(`  ${s.tone[item.severity](s.G[item.severity])} ${s.cut(s.safe(item.title), s.W - 8 - Math.min(widthOf(item.where), 34))}`, s.c.dim(s.short(item.where, 34)), s.W),
    ...(item.quote ? quoteLines(s, item.quote, 1) : []),
  ];
  const section = (title, list, render) => {
    if (!list.length) return;
    blocks.push({ title: `  ${s.c.bold(s.tr(title))}`, items: list.map(render) });
  };
  section('ui.judged.dismissed', dismissed, (item) => [
    between(`  ${s.c.dim(s.G.todo)} ${s.cut(s.tr(`ui.short.${item.check}`), s.W - 8 - Math.min(widthOf(item.where), 34))}`, s.c.dim(s.short(item.where, 34)), s.W),
    ...(item.quote ? quoteLines(s, item.quote, 1) : []),
    `    ${s.c.dim(s.cut(s.safe(item.reason ?? ''), s.W - 4))}`,
  ]);
  section('ui.judged.confirmed', confirmed, findingBlock);
  section('ui.judged.added', added, findingBlock);

  // Whatever does not fit the page is counted, and report 1 has it in full. The line that
  // counts takes room itself, so it is made room for only when something is left out.
  const fit = (room) => {
    const lines = [];
    let left = 0;
    for (const block of blocks) {
      const part = ['', block.title];
      let shown = 0;
      for (const item of block.items) {
        if (lines.length + part.length + item.length <= room) {
          part.push(...item);
          shown += 1;
        } else left += 1;
      }
      if (shown) lines.push(...part);
    }
    return { lines, left };
  };
  const room = PAGE - head.length - tail.length;
  const whole = fit(room);
  const { lines: body, left: hidden } = whole.left ? fit(room - 1) : whole;
  if (hidden) body.push(`  ${s.c.dim(s.tr('ui.judged.more', { count: hidden }))}`);
  return [...head, ...body, ...tail];
}

// --- the changes, file by file --------------------------------------------------------------------

const CHANGE_LABEL = 50;

// The list the walk goes through: one row per file, in the order the view gives. The order
// itself is made in lib/order.mjs; nothing is sorted here.
export function changes(view, o) {
  const s = skin(o);
  const { files, total } = view.changes;
  const lines = [
    between(`  ${s.c.bold(s.tr('ui.changes.title'))}`, s.tr('ui.changes.counts', { changes: total, files: files.length }), s.W),
    `  ${s.c.dim(s.tr('ui.changes.order'))}`,
  ];
  if (!files.length) return [...lines, `  ${s.safe(view.findings.none)}`];
  const numberWidth = Math.max(2, String(files.length).length);
  const rows = files.map((file) => {
    const shapes = SEVERITIES.filter((key) => file.severities[key] > 0).map((key) => s.tone[key](`${s.G[key]}${file.severities[key]}`)).join(' ');
    return `  ${padStart(String(file.k), numberWidth)}  ${padEnd(s.short(s.safe(file.label), CHANGE_LABEL), CHANGE_LABEL)}${padStart(String(file.count), 4)}  ${shapes}`.replace(/\s+$/, '');
  });
  return [...lines, ...fitRows(rows, PAGE - lines.length, (count) => `  ${s.c.dim(s.tr('ui.changes.more', { count }))}`)];
}

// Items joined with a separator and broken only between two items, never inside one.
function flow(s, lead, items, width) {
  const rows = [lead];
  items.forEach((item, index) => {
    const text = index < items.length - 1 ? `${item} ${s.G.sep}` : item;
    const last = rows[rows.length - 1];
    if (last === '') rows[rows.length - 1] = text;
    else if (widthOf(`${last} ${text}`) <= width) rows[rows.length - 1] = `${last} ${text}`;
    else rows.push(text);
  });
  return rows.map((row) => s.cut(row, width));
}

// What the walk prints when it enters a file: which file of how many, what it is, its lines
// against the recommendation where there is one, and what is suggested in it, by kind.
// file: { k, of, label, kindLabel, lines, limit, count, byKind: [{ label, count }] }.
export function fileHeader(file, o) {
  const s = skin(o);
  const kind = s.safe(file.kindLabel);
  const lines = [s.rule(s.tr('ui.file.title', { k: file.k, of: file.of })), between(`  ${s.c.bold(s.short(s.safe(file.label), s.W - 4 - widthOf(kind)))}`, s.c.dim(kind), s.W)];
  if (file.lines !== null) {
    const count = s.tr('ui.file.lines', { lines: s.fmt(file.lines) });
    const against = file.limit === null ? '' : `   ${bar(s, file.lines, file.limit)} ${padStart(percentText(file.lines, file.limit), 5)} ${s.tr('ui.file.of', { limit: s.fmt(file.limit) })}`;
    lines.push(`  ${count}${against}`.replace(/\s+$/, ''));
  }
  const kinds = file.byKind.map((entry) => (entry.count > 1 ? `${s.safe(entry.label)} ${s.G.times}${entry.count}` : s.safe(entry.label)));
  lines.push(...flow(s, s.tr('ui.file.changes', { count: file.count }), kinds, s.W - 2).map((row) => `  ${row}`));
  return lines;
}

// --- change cards ---------------------------------------------------------------------------------

// The first sentence of a reason; its sources stay in the HTML report.
function firstSentence(text) {
  const plain = String(text)
    .replace(/\s*\((?:sources?|zdroj[e]?)\s*:[^)]*\)/gi, '')
    .replace(/\s*(?:Sources?|Zdroj[e]?)\s*:.*$/i, '');
  return plain.split(/(?<=[.!?])\s+/)[0].trim();
}

// A value as JSON that fits the width: on one line when it can, else one entry per line.
export function compactJson(value, width, indent = 0) {
  const inline = JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ');
  if (value === null || typeof value !== 'object' || indent + widthOf(inline) <= width) return [' '.repeat(indent) + inline];
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item) => [null, item]) : Object.entries(value);
  if (!entries.length) return [' '.repeat(indent) + inline];
  // One entry per line, the brackets on the first and the last: every character is JSON, and a
  // small patch stays a few lines.
  const lines = [];
  entries.forEach(([key, item], index) => {
    const prefix = key === null ? '' : `${JSON.stringify(key)}: `;
    const child = compactJson(item, width - widthOf(prefix), indent + 2);
    child[0] = ' '.repeat(indent + 2) + prefix + child[0].trimStart();
    if (index < entries.length - 1) child[child.length - 1] += ',';
    lines.push(...child);
  });
  lines[0] = `${' '.repeat(indent)}${isArray ? '[' : '{'} ${lines[0].trimStart()}`;
  lines[lines.length - 1] += isArray ? ' ]' : ' }';
  return lines;
}

// One side of a diff: every row starts with the sign, and a long line continues under a mark.
function diffRows(s, sign, lines, tone) {
  return lines.flatMap((line) => hardWrap(visible(line), s.W - 1, s.W - 5).map((row, index) => tone(`${sign}${index ? `  ${s.G.wrap} ` : ''}${row}`)));
}

const MOVED_SHOWN = 3;

// The lines of one hunk of a card, as a unified diff: file headers and signs start in column
// one, so a diff fence colours them; every other line of a card starts with a space.
export function hunkLines(hunk, o) {
  const s = skin(o);
  const header = (sign, label, note) => between(`${sign} ${s.short(label, s.W - 6 - widthOf(note))}`, note, s.W);
  const lineNote = (before, after) => s.tr('ui.card.lines', { before: s.fmt(before), after: s.fmt(after) });
  const at = (from, count, heading) => s.c.cyan(s.cut(`@@ -${from},${count} @@${heading ? ` ${heading}` : ''}`, s.W));
  const lines = [];
  if (hunk.kind === 'remove' || hunk.kind === 'replace') {
    lines.push(header('---', hunk.label, lineNote(hunk.before, hunk.after)), at(hunk.from, hunk.removed.length, hunk.heading));
    // Lines that move into a new file are named, not repeated; lines that are deleted are shown in full.
    const shown = hunk.moved && hunk.removed.length > MOVED_SHOWN + 1 ? hunk.removed.slice(0, MOVED_SHOWN) : hunk.removed;
    lines.push(...diffRows(s, '-', shown, s.c.red));
    if (shown.length < hunk.removed.length) lines.push(s.c.red(`- ${s.tr('ui.card.more.moved', { count: hunk.removed.length - shown.length })}`));
    if (hunk.kind === 'replace') lines.push(...diffRows(s, '+', hunk.added, s.c.green));
  } else if (hunk.kind === 'create') {
    lines.push(header('+++', hunk.label, s.tr('ui.card.new', { lines: s.fmt(hunk.total) })));
    lines.push(...diffRows(s, '+', hunk.written, s.c.green));
    if (hunk.moved) lines.push(s.c.green(`+ ${s.tr('ui.card.moved', { count: hunk.moved })}`));
  } else if (hunk.kind === 'append') {
    lines.push(header('+++', hunk.label, lineNote(hunk.before, hunk.after)));
    lines.push(...diffRows(s, '+', hunk.written, s.c.green));
    if (hunk.moved) lines.push(s.c.green(`+ ${s.tr('ui.card.moved', { count: hunk.moved })}`));
  } else if (hunk.kind === 'settings') {
    lines.push(header('+++', hunk.label, s.tr(hunk.created ? 'ui.card.settings.new' : 'ui.card.settings.adds')));
    for (const entry of hunk.entries) {
      lines.push(s.c.cyan(s.cut(`@@ ${entry.key} @@`, s.W)));
      // A hook or a rule is read in full before a yes: never elided.
      lines.push(...diffRows(s, '+', compactJson(entry.value, s.W - 2), s.c.green));
    }
  } else if (hunk.kind === 'manual') {
    lines.push(`  ${padEnd(s.c.bold(s.tr('ui.card.byhand')), 9)}${s.short(hunk.label, s.W - 11)}`);
    lines.push(...hunk.text.flatMap((text) => wrap(s.safe(text), s.W - 11)).map((line) => `${' '.repeat(11)}${line}`));
    lines.push(...wrap(hunk.copy ? s.tr('ui.card.byhand.copy', { file: hunk.copy }) : s.tr('ui.card.byhand.nocopy'), s.W - 11).map((line) => `${' '.repeat(11)}${s.c.dim(line)}`));
  }
  return lines;
}

// One change, as it is shown before it is decided. Its position says which file of how many the
// walk is in, and which change of how many this is.
// model: { n, total, file: { k, of }, severity, title, where, was, what, why, quote, pair: [{ where, quote }, ...], hunks, notes, backup }.
export function card(model, o) {
  const s = skin(o);
  const KEY = 9;
  const keyed = (key, rows) => rows.map((text, index) => `  ${index === 0 ? padEnd(s.c.bold(key), KEY) : ' '.repeat(KEY)}${text}`);
  // A reason or a remark is at most three rows; what does not fit is in the report.
  const rows = (text) => {
    const all = wrap(s.safe(text), s.W - 2 - KEY);
    return all.length > 3 ? [...all.slice(0, 2), s.cut(all.slice(2).join(' '), s.W - 2 - KEY)] : all;
  };
  const severity = s.tr(`ui.sev.${model.severity}`);
  const position = s.tr('ui.card.position', { k: model.file.k, of: model.file.of, n: model.n, total: model.total });
  const lines = [
    between(
      `  ${s.tone[model.severity](s.G[model.severity])} ${s.c.bold(position)}  ${s.c.bold(s.cut(s.safe(model.title), s.W - 10 - widthOf(position) - widthOf(severity)))}`,
      s.tone[model.severity](severity),
      s.W,
    ),
  ];
  if (model.pair) {
    // Two lines that disagree: both in full, named A and B, the way the answers name them.
    model.pair.forEach((side, index) => {
      lines.push(`  ${s.c.bold('AB'[index])}  ${s.c.cyan(s.short(side.where, s.W - 5))}`, ...quoteLines(s, side.quote, 6));
    });
  } else {
    const was = model.was ? `  ${s.c.dim(`(${s.tr('ui.card.was', { line: model.was })})`)}` : '';
    lines.push(`  ${s.c.cyan(s.short(model.where, s.W - 2 - widthOf(was)))}${was}`);
    if (model.quote) lines.push(...quoteLines(s, model.quote, 6));
  }
  if (model.what) lines.push(...keyed(s.tr('ui.card.what'), rows(model.what)));
  // A reason from the checks is long and cites its page; its first sentence is the reason.
  lines.push(...keyed(s.tr('ui.card.why'), rows(model.wholeWhy ? model.why : firstSentence(model.why))));
  for (const hunk of model.hunks) lines.push(...hunkLines(hunk, o));
  model.notes.forEach((text, index) => lines.push(...keyed(index === 0 ? s.tr('ui.card.note') : '', rows(text))));
  if (model.backup) lines.push(`  ${s.c.dim(s.cut(s.tr('ui.card.backupfirst', { dir: model.backup }), s.W - 2))}`);
  return lines;
}

// What one option of a card's picker does to the files: the text of its preview pane.
export function previewLines(hunks, o, { title } = {}) {
  const s = skin(o);
  return [...(title ? [title] : []), ...hunks.flatMap((hunk) => hunkLines(hunk, { ...o, colour: false }))].map((line) => s.cut(line, s.W));
}

// What one decision did, in one line; a second line only when the first cannot hold it.
// model: { status, n, total, parts, count }.
export function receipt(model, o) {
  const s = skin(o);
  const position = `${model.n}/${model.total}`;
  const mark = model.status === 'applied' || model.status === 'by-hand' ? s.c.green(s.G.done) : s.c.dim(s.G.todo);
  const parts = [s.tr(`ui.receipt.${model.status}`, { position, count: model.count ?? 0 }), ...(model.parts ?? []).map((part) => s.safe(part))];
  // A row breaks between two parts, never inside one.
  const rows = [];
  for (const part of parts) {
    const last = rows[rows.length - 1];
    if (last !== undefined && widthOf(`${last} ${s.G.sep} ${part}`) <= s.W - 4) rows[rows.length - 1] = `${last} ${s.G.sep} ${part}`;
    else rows.push(part);
  }
  return rows.map((row, index) => `  ${index === 0 ? mark : ' '} ${s.cut(row, s.W - 4)}`);
}

// One thing that was done, said in a sentence.
export function doneLine(text, o) {
  const s = skin(o);
  return wrap(s.safe(text), s.W - 4).map((line, index) => `  ${index === 0 ? s.c.green(s.G.done) : ' '} ${line}`);
}

// The parts of a receipt, worded here so that ui.mjs holds no sentence of its own.
export function receiptPart(kind, params, o) {
  const s = skin(o);
  return s.tr(`ui.receipt.part.${kind}`, params);
}

// What became of the changes of a walk, one item per outcome. A change the person made by hand
// is an outcome of its own: this tool applied nothing there. It is named only when there is one,
// and so is "resolved on the way" in the short form; the last item is what is left.
function countItems(s, counts, { short = false } = {}) {
  return [
    ['applied', counts.applied, true],
    ['byHand', counts.byHand ?? 0, false],
    ['skipped', counts.skipped, true],
    ['resolved', counts.resolved, !short],
    [short ? 'togo' : 'open', counts.open, true],
  ]
    .filter(([, count, always]) => always || count > 0)
    .map(([key, count]) => s.tr(`ui.count.${key}`, { count }));
}

// counts: { applied, byHand, skipped, resolved, open }. Rows break between two items.
export function countRows(counts, o) {
  const s = skin(o);
  return flow(s, '', countItems(s, counts), s.W - 2).map((row) => `  ${row}`);
}

// The same as one line, for the preview of "stop here": every number of the walk, so they add up.
export function countsText(counts, o) {
  const s = skin(o);
  return countItems(s, counts, { short: true }).join(` ${s.G.sep} `);
}

export function walkEnd(counts, o) {
  const s = skin(o);
  return [`  ${s.tr(counts.stopped ? 'ui.walk.stopped' : 'ui.walk.done')}`, ...countRows(counts, o)];
}

// --- the closing summary --------------------------------------------------------------------------

// view is the "after" view. info: { counts: { applied, skipped, resolved, open }, before: { high, medium, low }, backup }.
export function summary(view, run, o, info) {
  const s = skin(o);
  const after = view.after;
  const NAMEW = 21;
  const row = (name, before, afterText) => `  ${padEnd(s.cut(s.safe(name), NAMEW - 1), NAMEW)}${padEnd(before, 25)}${s.c.dim(s.G.arrow)}  ${afterText}`.replace(/\s+$/, '');
  const value = (number, detail) => `${padStart(number, 7)} ${detail}`;
  const lines = [rail(5, o), '', `  ${s.c.bold(s.tr('ui.summary.title'))}`];

  const fileLimit = view.limits.memoryFileLines.value;
  const file = after.lines.find((entry) => entry.before !== null && entry.after !== null);
  const mini = (count) => value(s.fmt(count), bar(s, count, fileLimit, 10, 3));
  if (file) lines.push(row(s.short(file.label, NAMEW - 1), mini(file.before), mini(file.after)));
  const totalLimit = view.limits.alwaysLoadedLines.value;
  const state = (count) => value(s.fmt(count), `${count > totalLimit ? s.c.red(s.tr('ui.summary.over')) : s.c.green(s.tr('ui.summary.within'))} ${totalLimit}`);
  lines.push(row(s.tr('ui.summary.start'), state(after.totals.loadedLines.before), state(after.totals.loadedLines.after)));
  if (after.totals.tokens.before !== null && after.totals.tokens.after !== null) {
    const tax = (count) => value(`${s.G.approx} ${s.fmt(count)}`, s.tr('ui.summary.tokens'));
    lines.push(row(s.tr('ui.summary.tax'), tax(after.totals.tokens.before), tax(after.totals.tokens.after)));
  }
  const shapes = (counts) => `  ${SEVERITIES.map((key) => `${s.tone[key](s.G[key])} ${counts[key]}`).join('  ')}`;
  lines.push(row(s.tr('ui.summary.findings'), info.before ? shapes(info.before) : value(s.fmt(after.totals.findings.before), ''), shapes(view.counts.findings)));
  lines.push('', ...countRows(info.counts, o), '', `  ${s.c.bold(s.tr('ui.summary.where'))}`);

  const moves = after.moved.entries;
  if (!moves.length) lines.push(`  ${s.c.dim(s.tr('ui.summary.nowhere'))}`);
  // From the line the person was shown in report 1, to what it became, with what that is at the edge.
  const fromWidth = Math.min(26, Math.max(0, ...moves.map((move) => widthOf(move.from))));
  const moveRows = moves.map((move) => {
    const type = move.type ? s.safe(move.type).toLowerCase() : '';
    const room = s.W - 2 - fromWidth - 2 - widthOf(s.G.flow) - (type ? widthOf(type) + 2 : 0);
    const target = move.type ? s.short(move.to, room) : s.cut(s.safe(move.to), room);
    const left = `  ${padEnd(s.short(move.from, fromWidth), fromWidth)} ${s.c.dim(s.G.flow)} ${target}`;
    return type ? between(left, s.c.dim(type), s.W) : left;
  });
  const undo = info.backup
    ? [`  ${padEnd(s.c.bold(s.tr('ui.summary.undo.k')), 10)}${s.tr('ui.summary.undo.v')}`, `  ${' '.repeat(10)}${s.c.cyan(s.short(info.backup, s.W - 12))}`]
    : [`  ${padEnd(s.c.bold(s.tr('ui.summary.undo.k')), 10)}${s.tr('ui.summary.undo.none')}`];
  const tail = ['', ...undo, '', `  ${s.c.bold(s.tr('ui.summary.report2'))}`, `  ${s.c.cyan(run.report.url)}`];
  lines.push(...fitRows(moveRows, Math.max(1, PAGE - lines.length - tail.length), (count) => `  ${s.c.dim(s.tr('ui.summary.more', { count }))}`));
  return [...lines, ...tail];
}

// The string table with the glyphs of a skin filled in, for callers that word a picker or a line
// outside a screen: const tr = text(o); tr('ui.lang.question').
export function text(o) {
  return skin(o).tr;
}
