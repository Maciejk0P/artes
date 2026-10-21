// The two HTML reports: the state before any change, and what changed afterwards.
// Each report is one self-contained file: inline CSS, no JavaScript, no external request.
// Both are drawn from the view model (lib/view.mjs) and from nothing else, so a number in a
// report is the number the console shows. Every piece of text goes through esc() before it
// reaches the page; diagrams are inline SVG from lib/flow-svg.mjs, which escapes its own text.
//
// A long setup must not become a wall: every skill is a closed <details> row, findings are
// grouped and only the first few rows are visible, candidates sit in one closed section.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UsageError, parseArgs, readJsonFile, requireOption, runCli } from './lib/cli.mjs';
import { layoutGraph, toSvg } from './lib/flow-svg.mjs';
import { SEVERITIES } from './lib/kinds.mjs';
import { healthDir, join, timestamp } from './lib/paths.mjs';
import { assertLang, t } from './lib/strings.mjs';
import { allowedOutput } from './lib/targets.mjs';
import { buildView } from './lib/view.mjs';

// How much is visible before the reader opens anything.
export const VISIBLE = {
  openGroups: 3, // groups of findings that start open
  rowsPerGroup: 3, // finding rows shown in an open group; the rest sit behind "more"
  openBodies: 3, // high-severity findings whose quote and reason start open
  skillRows: 12, // skill rows per group
  fileRows: 8, // rows of the file table
  taxRows: 6, // contributors per place
  listItems: 5, // items of a plain list
};
const DIAGRAM_WIDTH = 720;

export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Colours: neutral surfaces and ink, one accent for measures, and a reserved status set that is
// always paired with a text label, so nothing is told by colour alone.
const CSS = `
:root {
  color-scheme: light dark;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #6f6d68;
  --line: #e1e0d9; --accent: #2a78d6; --good: #0ca30c; --warning: #c98500; --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #9a9890;
    --line: #2c2c2a; --accent: #3987e5; --good: #0ca30c; --warning: #fab219; --critical: #e66767;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 4px; }
h2 { font-size: 1.15rem; margin: 40px 0 8px; padding-top: 16px; border-top: 1px solid var(--line); }
h3 { font-size: 1rem; margin: 20px 0 6px; }
h4 { font-size: 0.95rem; margin: 0 0 4px; }
p { margin: 0 0 8px; }
.meta, .note { color: var(--ink-2); font-size: 0.9rem; }
.note { margin-bottom: 12px; overflow-wrap: anywhere; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 20px 0 0; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.tile .label { display: block; color: var(--ink-2); font-size: 0.82rem; }
.tile .value { display: block; font-size: 1.7rem; font-weight: 600; line-height: 1.2; }
.tile .sub { display: block; color: var(--muted); font-size: 0.8rem; }
.scroll { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.path { overflow-wrap: anywhere; min-width: 160px; }
tr.total td { font-weight: 600; border-top: 1px solid var(--line); }
.meter-cell { min-width: 180px; }
.meter { display: block; position: relative; height: 10px; border-radius: 0 4px 4px 0; background: color-mix(in srgb, var(--fill) 18%, var(--surface)); }
.meter .fill { display: block; height: 100%; border-radius: 0 4px 4px 0; background: var(--fill); }
.meter .mark { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--ink-2); }
.meter.ok { --fill: var(--accent); }
.meter.near { --fill: var(--warning); }
.meter.over { --fill: var(--critical); }
.meter-text { display: block; margin-top: 4px; color: var(--ink-2); font-size: 0.8rem; }
.badge { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8rem; font-weight: 600; white-space: nowrap; }
.badge::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--dot); }
.badge.high { --dot: var(--critical); }
.badge.medium { --dot: var(--warning); }
.badge.low { --dot: var(--accent); }
.badge.plain { --dot: var(--muted); }
.tag { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; font-size: 0.78rem; color: var(--ink-2); white-space: nowrap; }
summary { cursor: pointer; }
details.group, details.more, details.block, details.change-file { margin: 8px 0; }
details.group > summary, details.block > summary { font-weight: 600; padding: 6px 0; }
details.change-file > summary { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; padding: 6px 0; }
details.change-file > summary .where { font-weight: 600; }
details.change-file h4 { margin: 10px 0 4px; }
.change-kind { color: var(--ink-2); font-size: 0.85rem; }
ul.changes-list { list-style: none; padding-left: 0; }
ul.changes-list li { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
ul.changes-list li > .count { min-width: 2.2em; text-align: right; font-variant-numeric: tabular-nums; }
details.more > summary { color: var(--ink-2); font-size: 0.9rem; padding: 4px 0; }
.count { color: var(--muted); font-weight: 400; }
details.finding, details.candidate, details.skill, .skill.linked {
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin: 6px 0;
}
details.finding > summary, details.candidate > summary, details.skill > summary {
  display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline;
}
details.finding > summary::before, details.candidate > summary::before, details.skill > summary::before, details.change-file > summary::before {
  content: "▸"; color: var(--ink-2); flex: 0 0 auto;
}
details.finding[open] > summary::before, details.candidate[open] > summary::before, details.skill[open] > summary::before, details.change-file[open] > summary::before {
  content: "▾";
}
.msg { flex: 1 1 280px; overflow-wrap: anywhere; }
.finding-body, .candidate-body, .skill-body { padding: 6px 0 4px; }
.where { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 0.85rem; overflow-wrap: anywhere; }
pre.quote, pre.source {
  margin: 8px 0; padding: 8px 10px; background: var(--page); border-left: 3px solid var(--line);
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 18em; overflow: auto;
  font: 0.85rem/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
dl { margin: 8px 0 0; }
dt { color: var(--ink-2); font-size: 0.8rem; font-weight: 600; margin-top: 6px; }
dd { margin: 0; overflow-wrap: anywhere; }
ul.plain { margin: 0; padding-left: 20px; }
ul.plain li { margin: 4px 0; overflow-wrap: anywhere; }
.empty { color: var(--ink-2); }
.diagram { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 8px; margin: 8px 0; }
.skill-name { font-weight: 600; min-width: 180px; overflow-wrap: anywhere; }
.skill-size { min-width: 200px; flex: 0 1 240px; }
.skill-notes { flex: 1 1 200px; color: var(--ink-2); font-size: 0.85rem; overflow-wrap: anywhere; }
.group-path { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 0.9rem; overflow-wrap: anywhere; }
footer { margin-top: 48px; color: var(--muted); font-size: 0.82rem; }
@media (max-width: 560px) {
  main { padding: 16px 12px 48px; }
  th, td { padding: 6px 8px; }
  .opt { display: none; }
  .meter-cell { min-width: 120px; }
  td.path { min-width: 110px; }
  .tile .value { font-size: 1.4rem; }
}
`;

const signed = (value) => (value > 0 ? `+${value}` : String(value));
const table = (head, rows) => `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
const empty = (text) => `<p class="empty">${esc(text)}</p>`;
const tag = (text) => `<span class="tag">${esc(text)}</span>`;

function page(view, body) {
  return `<!doctype html>
<html lang="${esc(view.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(view.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
<footer>${esc(view.generatedText)}</footer>
</main>
</body>
</html>
`;
}

function renderer(view) {
  const tr = (key, params) => t(view.lang, key, params);
  const number = (value) => Number(value).toLocaleString(view.lang === 'sk' ? 'sk-SK' : 'en-US');

  const tile = (labelText, value, sub = '') =>
    `<div class="tile"><span class="label">${esc(labelText)}</span>` +
    `<span class="value">${esc(value)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>`;

  // A bar against a limit, with the limit marked and the numbers written next to it.
  function meter(lines, limit, scaleMax) {
    const state = lines > limit ? 'over' : lines > limit * 0.8 ? 'near' : 'ok';
    const width = Math.min(100, (lines / scaleMax) * 100).toFixed(1);
    const mark = Math.min(100, (limit / scaleMax) * 100).toFixed(1);
    const text = tr('meter.label', { lines, limit });
    const status = lines > limit ? ` · ${tr('status.over')}` : '';
    return (
      `<span class="meter ${state}" role="img" aria-label="${esc(text)}">` +
      `<span class="fill" style="width:${width}%"></span><span class="mark" style="left:${mark}%"></span></span>` +
      `<span class="meter-text">${esc(text)}${esc(status)}</span>`
    );
  }

  // Items of a list; what does not fit the first few goes behind one "more" line.
  function list(items, visible = VISIBLE.listItems) {
    const li = (item) => `<li>${item}</li>`;
    const shown = items.slice(0, visible).map(li).join('');
    const rest = items.slice(visible);
    return (
      `<ul class="plain">${shown}</ul>` +
      (rest.length ? `<details class="more"><summary>${esc(tr('more', { count: rest.length }))}</summary><ul class="plain">${rest.map(li).join('')}</ul></details>` : '')
    );
  }

  // A diagram and, folded under it, the Mermaid text it was drawn from, for copying.
  function diagram(graph, mermaid, title, { natural = false } = {}) {
    const svg = toSvg(graph, natural ? { title } : { title, maxWidth: DIAGRAM_WIDTH });
    // A wide diagram keeps its size and scrolls sideways inside its frame instead of shrinking.
    const drawn = natural ? `<div class="canvas" style="min-width:${Math.min(layoutGraph(graph).width, 4000)}px">${svg}</div>` : svg;
    return (
      `<div class="diagram">${drawn}</div>` +
      `<details class="more mermaid"><summary>${esc(tr('diagram.source'))}</summary><pre class="source">${esc(mermaid)}</pre></details>`
    );
  }

  function header() {
    return (
      `<h1>${esc(view.title)}</h1>` +
      `<p class="meta">${esc(tr('report.home'))}: ${esc(view.home)} · ${esc(tr('report.scope'))}: ${esc(view.scope.text)} · ${esc(new Date(view.generatedAt).toLocaleString(view.lang))}</p>`
    );
  }

  // --- findings -----------------------------------------------------------------------------

  function findingRow(finding, open = false) {
    const related = finding.related
      .map((item) => `<dt>${esc(tr('finding.related'))} · <span class="where">${esc(item.where)}</span></dt><dd><pre class="quote">${esc(item.quote)}</pre></dd>`)
      .join('');
    return (
      `<details class="finding" id="${esc(finding.id)}" data-check="${esc(finding.check)}" data-severity="${esc(finding.severity)}"${open ? ' open' : ''}>` +
      `<summary><span class="badge ${esc(finding.severity)}">${esc(finding.severityLabel)}</span>` +
      `<span class="where">${esc(finding.where)}</span>` +
      `<span class="msg">${esc(finding.check === 'judgement' ? `${finding.title}: ${finding.message}` : finding.message)}</span>` +
      // A finding that came from a reader, not from a rule, says so.
      `${finding.check === 'judgement' ? tag(tr('check.judgement.title')) : ''}` +
      `${finding.status ? `<span class="badge plain">${esc(finding.status.label)}</span>` : ''}</summary>` +
      '<div class="finding-body">' +
      `${finding.quote === null ? '' : `<pre class="quote">${esc(finding.quote)}</pre>`}` +
      `${finding.error ? `<pre class="quote">${esc(finding.error)}</pre>` : ''}` +
      `<dl><dt>${esc(tr('finding.why'))}</dt><dd>${esc(finding.why)}</dd>` +
      `<dt>${esc(tr('finding.suggestion'))}: ${esc(finding.suggestion.label)}</dt>` +
      `<dd>${esc(finding.suggestion.detail)}</dd>${related}</dl></div></details>`
    );
  }

  // Findings by severity, then by kind. Only the first few groups start open, an open group
  // shows its first few rows, and only the first high-severity findings show their body.
  function findingGroups(bySeverity) {
    let openGroups = VISIBLE.openGroups;
    let openBodies = VISIBLE.openBodies;
    return bySeverity
      .filter((severity) => severity.count > 0)
      .map((severity) => {
        const groups = severity.groups
          .map((group) => {
            const isOpen = openGroups > 0;
            if (isOpen) openGroups -= 1;
            const rows = group.items.map((finding) => {
              const body = isOpen && finding.severity === 'high' && openBodies > 0;
              if (body) openBodies -= 1;
              return findingRow(finding, body);
            });
            const rest = rows.slice(VISIBLE.rowsPerGroup);
            return (
              `<details class="group" data-check="${esc(group.check)}"${isOpen ? ' open' : ''}>` +
              `<summary>${esc(group.title)} <span class="count">(${group.count})</span></summary>` +
              rows.slice(0, VISIBLE.rowsPerGroup).join('') +
              (rest.length ? `<details class="more"><summary>${esc(tr('more', { count: rest.length }))}</summary>${rest.join('')}</details>` : '') +
              '</details>'
            );
          })
          .join('');
        return `<h3><span class="badge ${esc(severity.severity)}">${esc(severity.label)}</span> <span class="count">(${severity.count})</span></h3>${groups}`;
      })
      .join('');
  }

  // Everything found by wording alone, in one closed section: nothing in it is a finding yet.
  function candidatesSection() {
    const { candidates } = view;
    if (candidates.total === 0) return empty(tr('candidates.none'));
    const row = (item) =>
      `<details class="candidate" id="${esc(item.id)}" data-check="${esc(item.check)}">` +
      `<summary>${tag(item.statusLabel)}<span class="where">${esc(item.where)}</span><span class="msg">${esc(item.message)}</span></summary>` +
      '<div class="candidate-body">' +
      `${item.quote === null ? '' : `<pre class="quote">${esc(item.quote)}</pre>`}` +
      item.related.map((other) => `<p class="where">${esc(other.where)}</p><pre class="quote">${esc(other.quote)}</pre>`).join('') +
      `${item.reason ? `<p>${esc(tr('candidate.reason'))}: ${esc(item.reason)}</p>` : ''}` +
      `<p class="note">${esc(item.why)}</p></div></details>`;
    const groups = candidates.groups
      .map((group) => `<h4>${esc(group.title)} <span class="count">(${group.count})</span></h4>${group.items.map(row).join('')}`)
      .join('');
    const pairs = candidates.conflictPairs.found ? `<p class="note">${esc(candidates.conflictPairs.text)}</p>` : '';
    return `<details class="block candidates"><summary>${esc(candidates.sentence)}</summary><p class="note">${esc(tr('candidates.note'))}</p>${pairs}${groups}</details>`;
  }

  function reviewSection() {
    const { items, note } = view.review;
    if (items.length === 0) return empty(tr('review.none'));
    return (
      `<p class="note">${esc(note)}</p>` +
      list(items.map((item) => `<strong>${esc(item.title)}</strong> · <span class="where">${esc(item.where)}</span> · ${esc(item.message)} <span class="note">${esc(item.why)}</span>`))
    );
  }

  // --- what loads and what it costs ---------------------------------------------------------

  function loadSection() {
    if (view.load.length === 0) return '';
    const [first, ...others] = view.load;
    return (
      `<h2>${esc(tr('section.load'))}</h2><p class="note">${esc(tr('section.load.note'))}</p>` +
      `<h3>${esc(first.label)}</h3>${diagram(first.graph, first.mermaid, first.title)}` +
      others
        .map((place) => `<details class="block"><summary>${esc(place.label)}</summary>${diagram(place.graph, place.mermaid, place.title)}</details>`)
        .join('')
    );
  }

  function loadedTable(places, withBefore = false) {
    const scaleMax = Math.max(...places.map((place) => place.lines), ...places.map((place) => place.limit * 1.25));
    const head =
      `<th>${esc(tr('col.group'))}</th>` +
      (withBefore ? `<th class="num">${esc(tr('col.before'))}</th>` : '') +
      `<th class="num">${esc(withBefore ? tr('col.after') : tr('col.lines'))}</th>` +
      (withBefore ? `<th class="num">${esc(tr('col.diff'))}</th>` : '') +
      `<th${withBefore ? ' class="opt"' : ''}>${esc(tr('col.size'))}</th>`;
    const rows = places
      .map(
        (place) =>
          `<tr><td class="path">${esc(place.label)}</td>` +
          (withBefore ? `<td class="num">${place.before === null ? '' : place.before}</td>` : '') +
          `<td class="num">${place.lines}</td>` +
          (withBefore ? `<td class="num">${place.diff === null ? '' : esc(signed(place.diff))}</td>` : '') +
          `<td class="meter-cell${withBefore ? ' opt' : ''}">${meter(place.lines, place.limit, scaleMax)}</td></tr>`,
      )
      .join('');
    return table(head, rows);
  }

  // What each place loads, file by file, and what a setting switches off there.
  function loadedDetails(places) {
    return places
      .map((place) => {
        const files = place.files.map((file) => `<span class="where">${esc(file.label)}</span> · ${esc(file.roleLabel)} · ${esc(tr('lines', { lines: file.lines }))}`);
        const excluded = place.excluded.map(
          (file) =>
            `<span class="where">${esc(file.label)}</span> · ${esc(tr('loaded.excluded', { lines: file.lines, pattern: file.pattern, setting: file.setting }))}`,
        );
        return (
          `<details class="more"><summary>${esc(tr('loaded.files', { place: place.label, count: place.files.length }))}` +
          `${excluded.length ? ` · ${esc(tr('loaded.excluded.count', { count: excluded.length }))}` : ''}</summary>` +
          `<ul class="plain">${[...files, ...excluded].map((item) => `<li>${item}</li>`).join('')}</ul></details>`
        );
      })
      .join('');
  }

  function taxSection() {
    const { places, estimate, notCounted } = view.contextTax;
    if (places.length === 0) return '';
    const sorted = [...places].sort((a, b) => b.tokens - a.tokens);
    const body = (place) => {
      const shown = place.contributors.slice(0, VISIBLE.taxRows);
      const rest = place.contributors.slice(VISIBLE.taxRows);
      const restTokens = rest.reduce((sum, part) => sum + part.tokens, 0);
      const rows = [
        ...shown.map((part) => [part.label, part.typeLabel, part.tokens, part.share]),
        ...(rest.length ? [[tr('tax.rest', { count: rest.length }), '', restTokens, place.tokens ? Math.round((restTokens / place.tokens) * 100) : 0]] : []),
      ]
        .map(
          ([name, type, tokens, share]) =>
            `<tr><td class="path">${esc(name)}</td><td class="opt">${esc(type)}</td><td class="num">${esc(number(tokens))}</td>` +
            `<td class="meter-cell"><span class="meter ok" role="img" aria-label="${esc(`${share}%`)}"><span class="fill" style="width:${Math.min(100, share)}%"></span></span>` +
            `<span class="meter-text">${share}%</span></td></tr>`,
        )
        .join('');
      const head = `<th>${esc(tr('col.contributor'))}</th><th class="opt">${esc(tr('col.kind'))}</th><th class="num">${esc(tr('col.tokens'))}</th><th>${esc(tr('col.share'))}</th>`;
      return table(head, rows) + (place.autoMemory ? `<p class="note">${esc(place.autoMemory.text)}</p>` : '');
    };
    const [worst, ...others] = sorted;
    const heading = (place) => `${esc(place.label)} · ${esc(tr('tax.tokens', { tokens: number(place.tokens) }))}`;
    return (
      `<h2>${esc(tr('section.tax'))}</h2><p class="note">${esc(tr('section.tax.note'))} ${esc(estimate)} ${esc(notCounted)}</p>` +
      `<h3>${heading(worst)}</h3>${body(worst)}` +
      others.map((place) => `<details class="block"><summary>${heading(place)}</summary>${body(place)}</details>`).join('')
    );
  }

  function filesSection() {
    const rows = [...view.files].sort((a, b) => b.lines - a.lines);
    if (rows.length === 0) return empty(tr('files.none'));
    const withLimit = rows.filter((file) => file.limit !== null);
    const scaleMax = Math.max(view.limits.memoryFileLines.value * 1.25, ...withLimit.map((file) => file.lines));
    const head =
      `<th>${esc(tr('col.file'))}</th><th class="opt">${esc(tr('col.kind'))}</th><th class="opt">${esc(tr('col.loads'))}</th>` +
      `<th class="num">${esc(tr('col.lines'))}</th><th class="num opt">${esc(tr('col.tokens'))}</th><th>${esc(tr('col.size'))}</th>`;
    const row = (file) =>
      `<tr><td class="path">${esc(file.label)}</td><td class="opt">${esc(file.kindLabel)}</td><td class="opt">${esc(file.loadsLabel)}</td>` +
      `<td class="num">${file.lines}</td><td class="num opt">${esc(number(file.tokens))}</td>` +
      `<td class="meter-cell">${file.limit === null ? '' : meter(file.lines, file.limit, scaleMax)}</td></tr>`;
    const rest = rows.slice(VISIBLE.fileRows);
    return (
      table(head, rows.slice(0, VISIBLE.fileRows).map(row).join('')) +
      (rest.length ? `<details class="more"><summary>${esc(tr('more', { count: rest.length }))}</summary>${table(head, rest.map(row).join(''))}</details>` : '')
    );
  }

  // --- skills -------------------------------------------------------------------------------

  function skillRow(skill) {
    const notes = skill.notes.map((note) => note.text).join(' · ');
    if (skill.linked) {
      return `<div class="skill linked" data-skill="${esc(skill.name)}"><span class="skill-name">${esc(skill.name)}</span> <span class="skill-notes">${esc(notes)}</span></div>`;
    }
    const flow = skill.flow;
    const steps =
      flow.graph === null
        ? empty(flow.text)
        : diagram(flow.graph, flow.mermaid, tr('skills.flow.title', { name: skill.name })) + (flow.capped ? `<p class="note">${esc(tr('skills.flow.capped', { count: flow.capped }))}</p>` : '');
    const facts = [
      `<span class="where">${esc(skill.label)}</span>`,
      esc(tr('skills.description', { chars: skill.description.chars, limit: skill.description.limit })),
      ...(skill.listed ? [] : [esc(tr('skills.notListed'))]),
      ...(skill.thirdParty ? skill.thirdParty.because.map((reason) => esc(reason)) : []),
    ];
    return (
      `<details class="skill" data-skill="${esc(skill.name)}">` +
      `<summary><span class="skill-name">${esc(skill.name)}</span>` +
      `<span class="skill-size">${meter(skill.lines, skill.limit, skill.limit * 1.25)}</span>` +
      `${tag(flow.graph === null ? tr('skills.steps.none') : tr('skills.steps', { count: flow.steps }))}` +
      `<span class="skill-notes">${esc(notes)}</span></summary>` +
      `<div class="skill-body"><ul class="plain">${facts.map((fact) => `<li>${fact}</li>`).join('')}</ul>` +
      `<h4>${esc(tr('skills.flow.heading'))}</h4>${steps}</div></details>`
    );
  }

  function skillsSection(groups = view.skills.groups) {
    const noted = (skill) => (skill.state === 'over' ? 0 : skill.notes.length ? 1 : 2);
    return groups
      .map((group) => {
        const rows = [...group.rows].sort((a, b) => noted(a) - noted(b)).map(skillRow);
        const rest = rows.slice(VISIBLE.skillRows);
        const heading =
          group.scope === 'user'
            ? `${esc(group.title)} · <span class="group-path">${esc(group.folderLabel)}</span>`
            : `<span class="group-path">${esc(group.title)}</span>`;
        return (
          `<section class="skill-group" data-group="${esc(group.key)}">` +
          `<h3>${heading} <span class="count">(${group.count})</span></h3>` +
          `${group.note ? `<p class="note">${esc(group.note)}</p>` : ''}` +
          (group.empty
            ? empty(group.emptyText)
            : rows.slice(0, VISIBLE.skillRows).join('') +
              (rest.length ? `<details class="more"><summary>${esc(tr('more', { count: rest.length }))}</summary>${rest.join('')}</details>` : '')) +
          '</section>'
        );
      })
      .join('');
  }

  function inventorySection() {
    const { agentsMd, nested, nestedHint, onDemand } = view.inventory;
    const items = [
      esc(tr('inventory.onDemand', onDemand)),
      ...agentsMd.map((file) => esc(file.text)),
      ...nested.map((repository) => esc(repository.text)),
    ];
    return list(items) + (nestedHint ? `<p class="note">${esc(nestedHint)}</p>` : '');
  }

  // One file of a file-by-file list: where it stands in the order, what it is, and `facts`.
  // Only the first few files start open; the order is the one the view gives.
  function changeFile(file, facts, body, open) {
    const size = file.lines === null ? '' : ` · ${file.linesBefore !== undefined && file.linesBefore !== null && file.linesBefore !== file.lines ? tr('byFile.lines', { before: file.linesBefore, after: file.lines }) : tr('lines', { lines: file.lines })}`;
    return (
      `<details class="change-file" data-file="${esc(file.path)}"${open ? ' open' : ''}>` +
      `<summary><span class="count">${esc(tr('changes.file', { k: file.k, of: file.of }))}</span> <span class="where">${esc(file.label)}</span> ` +
      `<span class="change-kind">${esc(file.kindLabel)}${esc(size)}</span> <span class="count">${esc(facts)}</span></summary>${body}</details>`
    );
  }

  // The suggested changes, file by file, in the order the wizard walks through them.
  function suggestionsSection() {
    const { files } = view.changes;
    if (files.length === 0) return empty(view.findings.none);
    const row = (item) =>
      `<li><span class="count">${item.n}</span> <a href="#${esc(item.id)}"><span class="where">${esc(item.where)}</span></a> ` +
      `<span class="badge ${esc(item.severity)}">${esc(item.severityLabel)}</span> <span class="msg">${esc(item.kindLabel)} · ${esc(item.message)}</span></li>`;
    const groups = files.map((file, index) => {
      const kinds = file.byKind.map((entry) => (entry.count > 1 ? `${entry.label} ×${entry.count}` : entry.label)).join(' · ');
      return changeFile(file, `${tr('changes.count', { count: file.count })} (${kinds})`, `<ul class="plain changes-list">${file.items.map(row).join('')}</ul>`, index < VISIBLE.openGroups);
    });
    return `<section class="changes"><p class="note">${esc(tr('changes.note'))}</p>${groups.join('')}</section>`;
  }

  // Report 2, file by file: what was applied there, what was skipped, what is still open.
  function decisionsSection(files) {
    const part = (title, rows) => (rows.length ? `<h4>${esc(title)} <span class="count">(${rows.length})</span></h4>${rows.join('')}` : '');
    const appliedRow = (entry) =>
      `<p>${entry.where ? `<span class="where">${esc(entry.where)}</span> · ` : ''}<strong>${esc(entry.kindLabel)}</strong>` +
      `${entry.message ? ` · ${esc(entry.message)}` : ''}${entry.files.length ? ` · <span class="where">${esc(entry.files.join(', '))}</span>` : ''}` +
      `${entry.note ? ` · ${esc(entry.note)}` : ''}</p>`;
    // A skipped change is named in one line; where its finding is still open, the line links to
    // it, so the finding itself stands in the report once.
    const openIds = new Set(files.flatMap((file) => file.open.map((finding) => finding.id)));
    const skippedRow = (entry) => {
      const where = `<span class="where">${esc(entry.where ?? entry.id)}</span>`;
      return (
        `<p>${openIds.has(entry.id) ? `<a href="#${esc(entry.id)}">${where}</a>` : where} · <strong>${esc(entry.kindLabel)}</strong>` +
        `${entry.finding ? ` · ${esc(entry.finding.message)}` : ''}${entry.note ? ` · ${esc(entry.note)}` : ''}</p>`
      );
    };
    const groups = files.map((file, index) => {
      const open = file.open.map((finding) => findingRow(finding));
      const rest = open.slice(VISIBLE.listItems);
      const body =
        part(tr('section.applied'), file.applied.map(appliedRow)) +
        part(tr('section.byHand'), file.byHand.map(appliedRow)) +
        part(tr('section.skipped'), file.skipped.map(skippedRow)) +
        (open.length
          ? `<h4>${esc(tr('section.open'))} <span class="count">(${open.length})</span></h4>${open.slice(0, VISIBLE.listItems).join('')}` +
            (rest.length ? `<details class="more"><summary>${esc(tr('more', { count: rest.length }))}</summary>${rest.join('')}</details>` : '')
          : '');
      const facts = tr('byFile.counts', { applied: file.applied.length, byHand: file.byHand.length, skipped: file.skipped.length, open: file.open.length });
      return changeFile(file, facts, body, index < VISIBLE.openGroups);
    });
    return `<section class="changes"><p class="note">${esc(tr('byFile.note'))}</p>${groups.join('')}</section>`;
  }

  function numbersSection() {
    const head = `<th>${esc(tr('col.number'))}</th><th class="num">${esc(tr('col.value'))}</th><th>${esc(tr('col.source'))}</th>`;
    const rows = view.numbers
      .map(
        (item) =>
          `<tr><td>${esc(item.label)}</td><td class="num">${esc(number(item.value))}</td>` +
          `<td class="path">${esc(item.documented ? `${item.mark}: ${item.source}` : item.mark)}</td></tr>`,
      )
      .join('');
    return (
      `<h2>${esc(tr('section.numbers'))}</h2><p class="note">${esc(tr('section.numbers.note', { date: view.factsCheckedOn ?? '-' }))}</p>` +
      `<details class="block"><summary>${esc(tr('numbers.show', { count: view.numbers.length }))}</summary>${table(head, rows)}</details>`
    );
  }

  const notesSection = () => (view.notes.items.length ? list(view.notes.items.map(esc)) : empty(view.notes.none));

  return {
    tr,
    number,
    tile,
    list,
    diagram,
    header,
    findingRow,
    findingGroups,
    candidatesSection,
    reviewSection,
    loadSection,
    loadedTable,
    loadedDetails,
    taxSection,
    filesSection,
    skillRow,
    skillsSection,
    inventorySection,
    suggestionsSection,
    decisionsSection,
    numbersSection,
    notesSection,
  };
}

// Report 1: the state of the setup.
export function renderStateView(view) {
  assertLang(view.lang);
  const r = renderer(view);
  const { tr } = r;
  const { counts } = view;
  const worstLoaded = view.loaded.places.find((place) => place.key === view.loaded.worst);
  const worstTax = view.contextTax.places.find((place) => place.key === view.contextTax.worst);

  const tiles = [
    r.tile(tr('tile.files'), counts.files),
    r.tile(tr('tile.memoryLines'), counts.memoryLines),
    r.tile(tr('tile.alwaysLoaded'), worstLoaded.lines, tr('tile.alwaysLoaded.note', { limit: worstLoaded.limit })),
    ...(worstTax ? [r.tile(tr('tile.tax'), `≈ ${r.number(worstTax.tokens)}`, tr('tile.tax.note', { place: worstTax.label }))] : []),
    ...SEVERITIES.map((severity) => r.tile(`${tr('tile.findings')}: ${tr(`severity.${severity}`)}`, counts.findings[severity])),
    r.tile(tr('tile.candidates'), counts.candidates.total, tr('tile.candidates.note')),
    r.tile(tr('tile.review'), counts.review),
    r.tile(tr('tile.skills'), counts.skills),
    r.tile(tr('tile.commands'), counts.commands),
    r.tile(tr('tile.agents'), counts.agents),
    r.tile(tr('tile.hooks'), counts.hooks),
  ].join('');

  const fileLimit = view.limits.memoryFileLines;
  const body = [
    r.header(),
    `<div class="tiles">${tiles}</div>`,
    r.loadSection(),
    `<h2>${esc(tr('section.alwaysLoaded'))}</h2>`,
    `<p class="note">${esc(view.loaded.note)}</p>`,
    r.loadedTable(view.loaded.places),
    r.loadedDetails(view.loaded.places),
    r.taxSection(),
    `<h2>${esc(tr('section.files'))}</h2>`,
    `<p class="note">${esc(tr('section.files.note', { limit: fileLimit.value, source: fileLimit.source }))}</p>`,
    r.filesSection(),
    `<h2 id="findings">${esc(tr('section.findings'))}</h2>`,
    view.findings.total ? r.findingGroups(view.findings.bySeverity) : empty(view.findings.none),
    `<h2 id="candidates">${esc(tr('section.candidates'))}</h2>`,
    r.candidatesSection(),
    `<h2 id="review">${esc(tr('section.review'))}</h2>`,
    r.reviewSection(),
    `<h2 id="skills">${esc(tr('section.skills'))}</h2>`,
    `<p class="note">${esc(tr('section.skills.note', { limit: view.skills.limit.value, source: view.skills.limit.source }))}` +
      `${view.skills.limit.carried ? ` ${esc(tr('section.skills.carried', { date: view.factsCheckedOn ?? '-' }))}` : ''} ${esc(view.skills.thirdPartyText)}</p>`,
    r.skillsSection(),
    `<h2>${esc(tr('section.inventory'))}</h2>`,
    r.inventorySection(),
    `<h2>${esc(tr('section.suggestions'))}</h2>`,
    r.suggestionsSection(),
    `<h2>${esc(tr('section.notes'))}</h2>`,
    r.notesSection(),
    r.numbersSection(),
  ].join('\n');

  return page(view, body);
}

// Report 2: what the changes did.
export function renderAfterView(view) {
  assertLang(view.lang);
  if (view.after === null) throw new Error('renderAfterView needs a view built with the earlier checks or the applied record');
  const r = renderer(view);
  const { tr } = r;
  const { after } = view;
  const { totals } = after;
  const was = (value) => tr('tile.before', { value });

  const tiles = [
    r.tile(tr('tile.memoryLines'), totals.memoryLines.after, was(totals.memoryLines.before)),
    r.tile(tr('tile.alwaysLoaded'), totals.loadedLines.after, was(totals.loadedLines.before)),
    ...(totals.tokens.after === null
      ? []
      : [r.tile(tr('tile.tax'), `≈ ${r.number(totals.tokens.after)}`, totals.tokens.before === null ? '' : was(`≈ ${r.number(totals.tokens.before)}`))]),
    r.tile(tr('tile.findings'), totals.findings.after, was(totals.findings.before)),
    r.tile(tr('tile.applied'), totals.applied),
    r.tile(tr('tile.byHand'), totals.byHand),
    r.tile(tr('tile.skipped'), totals.skipped),
    r.tile(tr('tile.skills'), totals.skills.after, was(totals.skills.before)),
    r.tile(tr('tile.hooks'), totals.hooks.after, was(totals.hooks.before)),
  ].join('');

  const lineRows = after.lines
    .map(
      (file) =>
        `<tr><td class="path">${esc(file.label)}${file.statusLabel ? ` <span class="badge plain">${esc(file.statusLabel)}</span>` : ''}</td>` +
        `<td class="num">${file.before ?? ''}</td><td class="num">${file.after ?? ''}</td><td class="num">${esc(signed(file.diff))}</td></tr>`,
    );
  const totalRow =
    `<tr class="total"><td>${esc(tr('col.total'))}</td><td class="num">${totals.memoryLines.before}</td>` +
    `<td class="num">${totals.memoryLines.after}</td><td class="num">${esc(signed(totals.memoryLines.after - totals.memoryLines.before))}</td></tr>`;
  const lineHead =
    `<th>${esc(tr('col.file'))}</th><th class="num">${esc(tr('col.before'))}</th>` +
    `<th class="num">${esc(tr('col.after'))}</th><th class="num">${esc(tr('col.diff'))}</th>`;
  const restLines = lineRows.slice(VISIBLE.fileRows);
  const linesTable =
    table(lineHead, lineRows.slice(0, VISIBLE.fileRows).join('') + (restLines.length ? '' : totalRow)) +
    (restLines.length
      ? `<details class="more"><summary>${esc(tr('more', { count: restLines.length }))}</summary>${table(lineHead, restLines.join('') + totalRow)}</details>`
      : '');

  const createdHead = `<th>${esc(tr('col.type'))}</th><th>${esc(tr('col.path'))}</th><th class="num">${esc(tr('col.lines'))}</th>`;
  const createdRows = after.created
    .map((item) => `<tr><td>${esc(item.typeLabel)}</td><td class="path">${esc(item.label)}</td><td class="num">${item.lines ?? ''}</td></tr>`)
    .join('');

  // What happened as a whole, in one line each where nothing did; the files follow.
  const decisions = [
    after.applied.length ? '' : empty(tr('applied.none')),
    after.skipped.length ? '' : empty(tr('skipped.none')),
    after.open.total ? '' : empty(after.open.none),
    after.files.length ? r.decisionsSection(after.files) : '',
  ].join('');

  const undo = [
    after.undo.text ? `<p>${esc(after.undo.text)}</p>${r.list(after.undo.backups.map((dir) => `${esc(tr('undo.folder'))}: <span class="where">${esc(dir)}</span>`))}` : '',
    after.undo.unbacked ? `<p>${esc(after.undo.unbacked)}</p>` : '',
    after.undo.none ? empty(after.undo.none) : '',
  ].join('');

  const body = [
    r.header(),
    `<div class="tiles">${tiles}</div>`,
    `<h2>${esc(tr('section.moved'))}</h2>`,
    after.moved.graph
      ? `<p class="note">${esc(tr('section.moved.note'))}</p>${r.diagram(after.moved.graph, after.moved.mermaid, after.moved.title, { natural: true })}`
      : empty(tr('moved.none')),
    `<h2>${esc(tr('section.lines'))}</h2>`,
    linesTable,
    `<h2>${esc(tr('section.alwaysLoaded'))}</h2>`,
    `<p class="note">${esc(view.loaded.note)}</p>`,
    r.loadedTable(after.loaded, true),
    `<h2>${esc(tr('section.created'))}</h2>`,
    after.created.length ? table(createdHead, createdRows) : empty(tr('created.none')),
    ...(after.createdSkills.length ? [`<h3>${esc(tr('section.createdSkills'))}</h3>`, after.createdSkills.map(r.skillRow).join('')] : []),
    `<h2 id="files">${esc(tr('section.byFile'))}</h2>`,
    decisions,
    `<h2>${esc(tr('section.next'))}</h2>`,
    r.list(after.next.map(esc), 20),
    `<h2 id="skills">${esc(tr('section.skills'))}</h2>`,
    r.skillsSection(),
    `<h2>${esc(tr('section.undo'))}</h2>`,
    undo,
    `<h2>${esc(tr('section.notes'))}</h2>`,
    r.notesSection(),
  ].join('\n');

  return page(view, body);
}

export function renderState({ scan, checks, lang = checks.lang, now = new Date() }) {
  return renderStateView(buildView({ scan, checks, lang, now }));
}

export function renderAfter({ before, scan, checks, applied = [], lang = checks.lang, now = new Date() }) {
  return renderAfterView(buildView({ scan, checks, before, applied, lang, now }));
}

// A report replaces an existing file only inside the health-check folder of `home`.
export function writeReport(html, out, home) {
  const target = allowedOutput(out, home);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, html);
  return { path: target, url: pathToFileURL(target).href };
}

runCli(import.meta.url, (argv) => {
  const args = parseArgs(argv, {
    scan: 'string',
    checks: 'string',
    before: 'string',
    applied: 'string',
    lang: 'string',
    out: 'string',
  });
  const [kind] = args._;
  if (kind !== 'state' && kind !== 'after') {
    throw new UsageError('report.mjs needs a report kind: state or after');
  }
  const now = new Date();
  let html;
  let scan;
  if (kind === 'state') {
    scan = readJsonFile(requireOption(args, 'scan'), 'scan');
    const checks = readJsonFile(requireOption(args, 'checks'), 'checks');
    html = renderState({ scan, checks, lang: args.lang ?? checks.lang, now });
  } else {
    const before = readJsonFile(requireOption(args, 'before'), 'before');
    scan = readJsonFile(requireOption(args, 'scan'), 'scan');
    const checks = readJsonFile(requireOption(args, 'checks'), 'checks');
    // No applied file means the user stopped before deciding on any change.
    const applied = args.applied ? readJsonFile(args.applied, 'applied') : [];
    if (!Array.isArray(applied)) throw new Error('The applied file must hold a JSON array');
    html = renderAfter({ before, scan, checks, applied, lang: args.lang ?? checks.lang, now });
  }
  return writeReport(html, args.out ?? join(healthDir(scan.home), `${kind}-${timestamp(now)}.html`), scan.home);
});
