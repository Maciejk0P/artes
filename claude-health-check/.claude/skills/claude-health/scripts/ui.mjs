// What the wizard calls inside Claude Code. One script, one subcommand per step:
//
//   banner | scope --lang L                       the two pickers that start a run in a session;
//                                                  scope first prints what the tool changes and never changes
//   check --lang L [--user-only | --machine] [--projects D ...] [--nested]
//   nested --run S                                 scan again with the repositories inside projects
//   resume S                                       pick up a run the launcher left
//   panels --run S [--panel overview|findings|context|skills|changes]
//   judged --run S                                 merge what the reading confirmed and dismissed
//   card --run S [--walk all|urgent]               the next change, as a card with its picker
//   apply --run S --card N --answer apply|keep|choice-1|choice-2
//   decide --run S --card N --answer skip|skip-file|skip-kind|stop|done
//   flow --run S                                   add branches read in prose to a skill's diagram
//   finish --run S                                 scan again, report 2, the closing summary
//
// Each prints the block the wizard repeats in a code fence, unchanged. With --json the output is
// an envelope: the block between two marker lines, then the picker for AskUserQuestion as one
// line of JSON, then the command each answer leads to. The wizard decides nothing about files:
// a change is a plan (a default one, or a draft the wizard wrote into the run folder), the card
// is drawn from that plan, and apply carries out the same plan through apply.mjs.
//
// The walk goes file by file, in the order of lib/order.mjs: when it enters a file it prints a
// header for that file, and a card says which file of how many and which change of how many.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendLines, backupFiles, mergeSettings, previewMerge, record, removeLines, replaceLines, writeNew } from './apply.mjs';
import { CANDIDATE_CHECKS, runChecks } from './checks.mjs';
import { UsageError, parseArgs, readJsonFile } from './lib/cli.mjs';
import { extractFlow, mergeBranches } from './lib/flow.mjs';
import { splitLines } from './lib/markdown.mjs';
import { byFile } from './lib/order.mjs';
import { absolute, displayPath, entryType, join } from './lib/paths.mjs';
import { VERSION, changedSince, check, isStamp, loadRun, nestedLeftOut, resolveHome, runFiles, runInfo, scanAgain, scanSetup, startRun, writeJson, writeStateReport } from './lib/pipeline.mjs';
import * as render from './lib/render.mjs';
import { LANGS, STRINGS, t } from './lib/strings.mjs';
import { localeLanguage, surroundings } from './lib/surroundings.mjs';
import { SHAPES, WRITES, allowedTarget, canonical, classifyTarget, writableTarget } from './lib/targets.mjs';
import { cut, visible } from './lib/term.mjs';
import { buildView, fileFacts } from './lib/view.mjs';
import { renderAfterView, writeReport } from './report.mjs';
import { DEFAULT_CAPS, isProject } from './scan.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECIPES = join(SKILL_DIR, 'recipes.md');
// The repository this skill ships in, when it runs from there: never offered as "this folder".
const TOOL_ROOT = path.resolve(SKILL_DIR, '..', '..', '..');

const OPTIONS = {
  lang: 'string', home: 'string', run: 'string', json: 'boolean', ascii: 'boolean',
  'user-only': 'boolean', machine: 'boolean', projects: 'list', nested: 'boolean',
  panel: 'string', walk: 'string', card: 'number', answer: 'string',
};

// Findings that need an edit this tool does not make: the person changes the file.
export const BY_HAND = ['settings-invalid-json', 'hook-missing-file', 'hook-unknown-event', 'skill-copies-differ'];
// The steps a plan may hold.
export const STEP_OPS = ['write-new', 'append', 'merge-settings', 'remove', 'replace', 'by-hand'];
// The write each step is, in the table of lib/targets.mjs that says what a write may touch.
// A step that is not here writes nothing: "by-hand" tells the person what to change.
export const STEP_WRITES = { 'write-new': 'write-new', append: 'append-lines', 'merge-settings': 'merge-settings', remove: 'remove-lines', replace: 'replace-lines' };
const CREATED = { skill: 'skill', command: 'command', rule: 'rule-file' };

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const linesOfFile = (file) => splitLines(readFileSync(file, 'utf8'));

// --- the envelope -------------------------------------------------------------------------------

// What one call answers with. Blocks are for the person; everything else is for the wizard.
function createOutput() {
  return { blocks: [], questions: [], then: {}, card: null, need: null, flow: null, files: null, open: null, say: null, do: null };
}

// A block holds names and lines of scanned files. Colour is never on here, so every line can be
// held to one rule on its way out: it is one line, with no character a terminal would act on
// (lib/term.mjs, visible). A value with a line break in it cannot add a line to a block.
function addBlock(out, lines, fence = 'text') {
  if (lines.length) out.blocks.push({ fence, lines: lines.map((line) => visible(line)) });
}

// How long a text of a picker may be. A label or a sentence that holds a name from a scanned
// file has the length of that name; a picker gets an end.
const PICKER_LABEL = 80;
const PICKER_TEXT = 240;
const said = (text, max) => cut(visible(text), max);

// picker: { header, question, options: [{ label, description, preview }] }; next: { label: arguments }.
function addPicker(out, picker, next) {
  if ([...picker.header].length > 12) throw new Error(`The picker header "${picker.header}" is longer than 12 characters`);
  if (picker.options.length < 2 || picker.options.length > 4) throw new Error(`The picker "${picker.header}" has ${picker.options.length} options; it needs 2 to 4`);
  // What a picker says is shown in the same terminal as a block, so it is held to the same rule.
  // The label is also the key of what follows the answer, so both are made from the one clean text.
  // A preview is a block of lines: each of its lines was made one line where it was put together.
  const options = picker.options.map((option) => ({
    label: said(option.label, PICKER_LABEL),
    description: said(option.description, PICKER_TEXT),
    ...(option.preview ? { preview: visible(option.preview, { breaks: true }) } : {}),
  }));
  out.questions.push({ question: said(picker.question, PICKER_TEXT), header: picker.header, multiSelect: false, options });
  out.then[picker.header] = Object.fromEntries(Object.entries(next).map(([label, command]) => [said(label, PICKER_LABEL), command]));
}

function envelope(out) {
  const parts = ['@@claude-health 1'];
  for (const block of out.blocks) {
    // A mark no scanned file can know: a quoted line cannot pass for the end of the block.
    const mark = randomBytes(4).toString('hex');
    parts.push(`@@block fence=${block.fence} lines=${block.lines.length} mark=${mark}`, `<<< ${mark}`, ...block.lines, `>>> ${mark}`);
  }
  if (out.questions.length) parts.push('@@ask', JSON.stringify({ questions: out.questions }), '@@then', JSON.stringify(out.then));
  if (out.card) parts.push('@@card', JSON.stringify(out.card));
  if (out.need) parts.push('@@need', JSON.stringify(out.need));
  if (out.flow) parts.push('@@flow', JSON.stringify(out.flow));
  if (out.files) parts.push('@@files', JSON.stringify(out.files));
  if (out.open) parts.push('@@open', out.open);
  // The two sections that are plain text can name a file; they are held to the rule of the blocks.
  if (out.say) parts.push('@@say', visible(out.say));
  if (out.do) parts.push('@@do', visible(out.do));
  return `${parts.join('\n')}\n`;
}

// Reads an envelope back. A section starts at a line that begins with @@ outside a block; a
// block ends only at the line that carries its own mark.
export function parseEnvelope(text) {
  const lines = text.split('\n');
  const result = { blocks: [] };
  let index = 0;
  const jsonSections = ['ask', 'then', 'card', 'need', 'flow', 'files'];
  while (index < lines.length) {
    const head = /^@@(\w[\w-]*)(.*)$/.exec(lines[index]);
    index += 1;
    if (!head) continue;
    const [, name, rest] = head;
    if (name === 'block') {
      const meta = /fence=(\w+) lines=(\d+) mark=([0-9a-f]+)/.exec(rest);
      const start = lines.indexOf(`<<< ${meta[3]}`, index);
      const end = lines.indexOf(`>>> ${meta[3]}`, start);
      result.blocks.push({ fence: meta[1], lines: Number(meta[2]), mark: meta[3], text: lines.slice(start + 1, end).join('\n') });
      index = end + 1;
    } else if (jsonSections.includes(name)) {
      result[name] = JSON.parse(lines[index]);
      index += 1;
    } else if (['open', 'say', 'do'].includes(name)) {
      result[name] = lines[index];
      index += 1;
    }
  }
  return result;
}

// --- context --------------------------------------------------------------------------------------

// A block is repeated by the wizard in a code fence: printed as for a pipe, never in colour.
function skinOf(args, io, lang) {
  const { colour, unicode, width } = surroundings({ env: io.env, platform: io.platform, flags: { plain: true, ascii: args.ascii } });
  return { lang, colour, unicode, width };
}

// A run opened for a subcommand: its files, its language, and helpers that word and label things.
function openRun(args, io) {
  const home = resolveHome(args.home ?? io.home);
  const stamp = args.run ?? args._[1];
  if (!stamp) throw new UsageError('This command needs the stamp of a run: --run 20261001-131730');
  const run = loadRun({ home, stamp });
  const o = skinOf(args, io, run.session.lang);
  const projects = run.scan.projects.map((project) => project.path);
  return {
    home, stamp, run, files: run.files, o, lang: run.session.lang, tr: render.text(o),
    projects,
    label: (file) => displayPath(file, home, projects),
    info: runInfo(stamp, { name: path.basename(run.files.report1), url: fileUrl(run.files.report1), path: run.files.report1 }),
  };
}

const fileUrl = (file) => pathToFileURL(file).href;

function readState(ctx) {
  return existsSync(ctx.files.state) ? readJsonFile(ctx.files.state, 'state') : null;
}

function filesSection(ctx) {
  return { run: ctx.files.dir, reading: ctx.files.reading, judgement: ctx.files.judgement, drafts: ctx.files.drafts, recipes: RECIPES };
}

const flowDraft = (ctx) => join(ctx.files.drafts, 'flow.json');

// Branches the wizard read in the prose of one skill, for its diagram in report 2. The draft
// names the skill and lists the branches; each needs the exact text of the line it was read
// from, and the flow module refuses one that does not have it. With no branches the call
// answers with the steps a program read, so the wizard knows what a branch can hang on.
function flow(args, io) {
  const ctx = openRun(args, io);
  const file = flowDraft(ctx);
  if (!existsSync(file)) throw new Error(`There is no draft at ${file}. Write { "skill": "<path of its SKILL.md>", "branches": [] } there first.`);
  const draft = readJsonFile(file, 'flow draft');
  if (draft === null || typeof draft !== 'object' || typeof draft.skill !== 'string' || !Array.isArray(draft.branches ?? [])) {
    throw new Error('The flow draft must be { "skill": "<path>", "branches": [ ... ] }');
  }
  const { scan } = scanAgain({ home: ctx.home, scan: ctx.run.scan });
  const skill = scan.files.find((entry) => entry.kind === 'skill' && entry.path === absolute(draft.skill));
  if (!skill) throw new Error(`${draft.skill} is not a skill this run lists; a diagram is drawn for the SKILL.md files of the scan only.`);
  const text = readFileSync(skill.path, 'utf8');
  const labels = { start: t(ctx.lang, 'flow.start'), end: t(ctx.lang, 'flow.end'), yes: t(ctx.lang, 'flow.yes'), no: t(ctx.lang, 'flow.no'), more: STRINGS[ctx.lang]['flow.more'] };
  const read = extractFlow(text, { labels });
  const branches = draft.branches ?? [];
  const merged = mergeBranches(read, branches, text, { labels });
  const out = createOutput();
  out.flow = {
    skill: skill.path,
    source: read.source,
    steps: read.nodes.filter((node) => node.kind === 'step' || node.kind === 'decision').map((node) => ({ id: node.id, kind: node.kind, label: node.label, line: node.line ?? null })),
    accepted: merged.accepted,
    rejected: merged.rejected.map((item) => ({ index: item.index, reason: item.reason, message: t(ctx.lang, `flow.reject.${item.reason}`) })),
  };
  if (read.source === 'none') {
    out.do = 'This skill has no numbered list and no step headings, so it has no diagram and takes no branch. Say so; do not invent steps.';
    return out;
  }
  const flows = existsSync(ctx.files.flows) ? readJsonFile(ctx.files.flows, 'flows') : {};
  flows[skill.path] = merged.accepted.map((item) => branches[item.index]);
  writeJson(ctx.files.flows, flows);
  if (merged.accepted.length) addBlock(out, render.doneLine(ctx.tr('ui.flow.added', { skill: ctx.label(skill.path), count: merged.accepted.length }), ctx.o));
  out.do = merged.rejected.length
    ? `Some branches were refused: read the lines again, correct ${file} (every accepted branch stays in it) and run: flow --run ${ctx.stamp}`
    : merged.accepted.length
      ? `To change the branches, rewrite ${file} with the whole list and run: flow --run ${ctx.stamp}`
      : `To add a branch, read the skill, put it into ${file} as recipes.md says under "flow" and run: flow --run ${ctx.stamp}`;
  return out;
}

// The one shell line that opens a report, or null when the path holds a character that a shell
// would read as more than a path. Then the link in the block is what there is.
export function opener(file, platform) {
  if (!/^[A-Za-z0-9 _.\/\\:~()-]+$/.test(file)) return null;
  if (platform === 'win32') return `explorer.exe "${file.replace(/\//g, '\\')}"`;
  return `${platform === 'darwin' ? 'open' : 'xdg-open'} "${file}"`;
}

// --- the reading ------------------------------------------------------------------------------------

// What the wizard reads: the memory files that load, and every candidate with its exact lines.
function writeReading(ctx, scan, checks) {
  const kinds = ['memory', 'memory-local', 'import'];
  const entry = (file) => ({ file: file.path, label: ctx.label(file.path), kind: file.kind, lines: file.lines });
  writeJson(ctx.files.reading, {
    run: ctx.stamp,
    lang: ctx.lang,
    read: scan.files.filter((file) => kinds.includes(file.kind)).map(entry),
    onlyWhenAFindingPointsThere: scan.files.filter((file) => file.kind === 'memory-nested').map(entry),
    candidates: checks.candidates.map((candidate) => ({
      id: candidate.id,
      check: candidate.check,
      file: candidate.file,
      line: candidate.line,
      endLine: candidate.endLine,
      quote: candidate.quote,
      related: (candidate.related ?? []).map((other) => ({ file: other.file, line: other.line, quote: other.quote })),
      asks: candidate.message,
      // What it would become if it is what it looks like: the kind to confirm it with, and what the
      // check read from the line (a command, a rule, a project).
      kind: candidate.suggestion.kind,
      ...(candidate.data ? { data: candidate.data } : {}),
    })),
    judgement: ctx.files.judgement,
  });
  return scan.files.filter((file) => kinds.includes(file.kind)).length;
}

const readingStep = (ctx) =>
  `Read ${ctx.files.reading}, then the files it lists under "read" and no other file. Judge every candidate, add findings of your own, write ${ctx.files.judgement}, then run: judged --run ${ctx.stamp}`;

// The first line of `wanted` in `lines`, nearest to where it was; null when it is gone.
function locate(lines, wanted, hint) {
  const hits = [];
  for (let index = 0; index + wanted.length <= lines.length; index += 1) {
    if (wanted.every((text, offset) => lines[index + offset] === text)) hits.push(index + 1);
  }
  if (!hits.length) return null;
  return hits.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint))[0];
}

// The candidates of the run that have a verdict, as the checks listed them when they were read.
// A later run of the checks is told about them: the list of pairs that may contradict is
// bounded, and the bound must not drop a pair that a reader has already judged (checks.mjs).
const judgedCandidates = (ctx, entries) => {
  const judged = new Set(entries.map((entry) => entry?.candidate).filter((id) => typeof id === 'string'));
  return ctx.run.checks.candidates.filter((candidate) => judged.has(candidate.id));
};

// The entries of the judgement that still hold for a later scan: a quote is found again where
// its lines moved to, an entry whose lines are gone is dropped, and so is a verdict on a
// candidate that no longer exists.
function judgementNow(scan, base, entries) {
  const candidates = new Set(base.candidates.map((candidate) => candidate.id));
  const listed = new Set(scan.files.map((file) => file.path));
  const cache = new Map();
  const lines = (file) => {
    if (!cache.has(file)) cache.set(file, linesOfFile(file));
    return cache.get(file);
  };
  const move = (item) => {
    const file = absolute(String(item.file ?? ''));
    if (!listed.has(file)) return null;
    const wanted = String(item.quote ?? '').split('\n');
    const line = locate(lines(file), wanted, item.line ?? 1);
    return line === null ? null : { ...item, file, line, endLine: line + wanted.length - 1 };
  };
  const kept = [];
  for (const entry of entries) {
    if (entry.dismissed === true) {
      if (candidates.has(entry.candidate)) kept.push(entry);
      continue;
    }
    // What was read into a candidate holds while the candidate is there. One that the checks no
    // longer find (a rule now covers the command, the description now says when) is settled.
    if (entry.candidate !== undefined && !candidates.has(entry.candidate)) continue;
    const own = move(entry);
    const related = (entry.related ?? []).map(move);
    if (!own || related.includes(null)) continue;
    kept.push({ ...own, ...(related.length ? { related } : {}) });
  }
  return kept;
}

// The setup as it is now: scanned again with the same scope, checked with what the reading said.
function current(ctx, { judged = true } = {}) {
  const { scan } = scanAgain({ home: ctx.home, scan: ctx.run.scan });
  const entries = judged && existsSync(ctx.files.judgement) ? readJsonFile(ctx.files.judgement, 'judgement') : [];
  const read = judgedCandidates(ctx, entries);
  const base = runChecks(scan, { lang: ctx.lang, read });
  const judgement = judgementNow(scan, base, entries);
  const checks = judgement.length ? runChecks(scan, { lang: ctx.lang, read, judgement }) : base;
  return { scan, checks, judgement };
}

// --- the queue ---------------------------------------------------------------------------------------

// The walk, file by file: the order is the one of lib/order.mjs, the same the reports list.
function orderQueue(ctx, scan, findings) {
  return byFile(scan, findings).flatMap((group) =>
    group.items.map((finding) => ({
      id: finding.id,
      check: checkOf(finding),
      kind: finding.suggestion.kind,
      severity: finding.severity,
      title: titleOf(ctx, finding),
      where: whereOf(ctx, finding),
      line: finding.line,
      file: group.path,
      place: group.place,
    })),
  );
}

const titleOf = (ctx, finding) => (finding.check === 'judgement' ? finding.title : ctx.tr(`check.${finding.check}.title`));
// The check a change comes from: for a candidate that a reader confirmed, the check that found the
// candidate. A finding the reader added on its own has none but "judgement".
const checkOf = (finding) => finding.origin ?? finding.check;
// What a kind of change is called when all of it is skipped. Confirmed candidates of one check
// carry the titles their reader gave them, which may differ, so the kind goes by the short name
// of its check.
const kindTitle = (ctx, item) => (CANDIDATE_CHECKS.includes(item.check) ? ctx.tr(`ui.short.${item.check}`) : item.title);
const whereOf = (ctx, item) =>
  item.line === null || item.line === undefined ? ctx.label(item.file) : `${ctx.label(item.file)}:${item.line}${item.endLine && item.endLine !== item.line ? `-${item.endLine}` : ''}`;
const walkList = (state) => state.queue.filter((item) => state.walk !== 'urgent' || item.severity !== 'low');

// Where the file of a change stands in a walk: file k of m, and the changes of the walk that are in it.
function fileOf(list, item) {
  const files = [...new Set(list.map((entry) => entry.file))];
  return { k: files.indexOf(item.file) + 1, of: files.length, items: list.filter((entry) => entry.file === item.file) };
}

// The header of the file the walk enters: what the file is now, and what the walk holds for it, by kind.
function fileHeader(ctx, now, list, item) {
  const { k, of, items } = fileOf(list, item);
  const [group] = byFile(now.scan, [{ file: item.file, line: null, endLine: null }]);
  const byKind = [];
  for (const entry of items) {
    let kind = byKind.find((other) => other.kind === entry.kind);
    if (!kind) byKind.push((kind = { kind: entry.kind, label: ctx.tr(`suggestion.${entry.kind}`), count: 0 }));
    kind.count += 1;
  }
  return render.fileHeader({ k, of, ...fileFacts({ scan: now.scan, checks: now.checks, lang: ctx.lang })(group), count: items.length, byKind }, ctx.o);
}

function tally(state) {
  const list = walkList(state);
  const count = (status) => list.filter((item) => state.decisions[item.id]?.status === status).length;
  const [applied, byHand, skipped, resolved] = [count('applied'), count('by-hand'), count('skipped'), count('resolved')];
  return { applied, byHand, skipped, resolved, open: list.length - applied - byHand - skipped - resolved, stopped: Boolean(state.stopped) };
}

// --- plans ------------------------------------------------------------------------------------------

const draftFile = (ctx, id) => join(ctx.files.drafts, `${id}.json`);

function settingsFor(ctx, now, file) {
  const entry = now.scan.files.find((item) => item.path === file);
  return entry?.project ? join(entry.project, '.claude', 'settings.json') : join(ctx.home, '.claude', 'settings.json');
}

// The plan a program can make without a model: nothing in it is worded by anyone.
function defaultPlan(ctx, now, finding) {
  const data = finding.data ?? {};
  if (BY_HAND.includes(finding.check)) {
    const other = finding.related?.[0]?.file;
    const params = { error: data.error ?? '', event: data.event ?? '', file: data.file ? ctx.label(data.file) : '', other: other ? ctx.label(other) : '' };
    return { steps: [{ op: 'by-hand', file: finding.file, text: ctx.tr(`ui.manual.${finding.check}`, params) }] };
  }
  if (finding.check === 'duplicate-within' || finding.check === 'duplicate-across') return { steps: [{ op: 'remove' }] };
  // A candidate that a reader confirmed is a finding of the reading; the check that found it and
  // what that check read from the line came along (checks.mjs), so its plan needs no draft.
  const origin = checkOf(finding);
  if (origin === 'permission-in-prose' && finding.suggestion.kind === 'make-setting' && data.rule) {
    return { steps: [{ op: 'merge-settings', file: settingsFor(ctx, now, finding.file), patch: { permissions: { [data.list]: [data.rule] } } }, { op: 'remove' }] };
  }
  if (origin === 'project-specific-in-user' && finding.suggestion.kind === 'move-to-project' && data.projectPath) {
    const target = join(data.projectPath, 'CLAUDE.md');
    return { steps: [entryType(target) === 'file' ? { op: 'append', file: target, moves: true } : { op: 'write-new', file: target, content: '', moves: true }, { op: 'remove' }] };
  }
  if (finding.check === 'same-line-in-projects') {
    const target = join(ctx.home, '.claude', 'CLAUDE.md');
    const others = (finding.related ?? []).filter((other) => other.line !== null);
    return {
      steps: [
        entryType(target) === 'file' ? { op: 'append', file: target, content: `${finding.quote}\n` } : { op: 'write-new', file: target, content: `${finding.quote}\n` },
        { op: 'remove' },
        ...others.map((other) => ({ op: 'remove', file: other.file, from: other.line, to: other.endLine ?? other.line })),
      ],
    };
  }
  if (finding.suggestion.kind === 'review-conflict' && finding.related?.length === 1 && finding.related[0].line !== null) {
    const [other] = finding.related;
    return {
      choices: [
        { key: 'keepA', steps: [{ op: 'remove', file: other.file, from: other.line, to: other.endLine ?? other.line }] },
        { key: 'keepB', steps: [{ op: 'remove' }] },
      ],
    };
  }
  // A question only the person can answer; a draft can add the edit that removes the exception.
  if (finding.suggestion.kind === 'review-exception') return { steps: [] };
  return null;
}

const REFUSED = 'The draft is refused: ';
const refuse = (message) => {
  throw new Error(`${REFUSED}${message}`);
};

// Turns the steps of a plan into what will be done to which lines, as the files stand now.
function resolveSteps(ctx, now, finding, steps) {
  const where = { home: ctx.home, projects: ctx.projects };
  // The folders of the skills the scan marked as somebody else's: no step writes into one.
  const foreign = now.scan.files.filter((item) => item.kind === 'skill' && item.thirdParty).map((item) => path.posix.dirname(item.path));
  // The file a step may write to: inside the setup, of a kind the table of writes allows for
  // that step, and not part of a third-party skill. Anything else refuses the draft.
  const target = (file, op) => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) refuse(`a step needs the full path of its file, got ${JSON.stringify(file)}`);
    let allowed;
    try {
      allowed = allowedTarget(file, where, WRITES[STEP_WRITES[op]], op);
    } catch (error) {
      return refuse(error.message);
    }
    if (foreign.some((dir) => allowed === dir || allowed.startsWith(`${dir}/`))) refuse(`${ctx.label(allowed)} belongs to a third-party skill; this tool does not edit it`);
    try {
      return writableTarget(allowed, where, STEP_WRITES[op]);
    } catch (error) {
      return refuse(error.message);
    }
  };
  const resolved = [];
  for (const step of steps) {
    if (step === null || typeof step !== 'object') refuse('a step must be an object');
    if (step.op === 'remove' || step.op === 'replace') {
      const file = target(step.file ?? finding.file, step.op);
      const implied = step.from === undefined && step.file === undefined;
      const [from, to] = implied ? [finding.line, finding.endLine ?? finding.line] : [step.from, step.to ?? step.from];
      if (from === null || from === undefined) refuse(`the finding names no line; a ${step.op} step needs "from" and "to"`);
      const all = linesOfFile(file);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > all.length) refuse(`lines ${from}-${to} are outside ${ctx.label(file)} (${all.length} lines)`);
      const lines = all.slice(from - 1, to);
      // Whether the step takes the lines the finding quotes: those are the lines that may stay as a reminder.
      const own = file === finding.file && finding.line !== null && from <= finding.line && to >= (finding.endLine ?? finding.line);
      if (step.op === 'replace' && (typeof step.content !== 'string' || step.content.trim() === '')) refuse('a replace step needs its new text ("content")');
      resolved.push({ op: step.op, file, from, to, lines, sha: sha256(lines.join('\n')), own, ...(step.op === 'replace' ? { content: step.content } : {}) });
    } else if (step.op === 'write-new' || step.op === 'append') {
      const file = target(step.file, step.op);
      if (step.op === 'write-new' && entryType(file) !== null) refuse(`${ctx.label(file)} already exists; a new file cannot replace it`);
      if (step.op === 'append' && entryType(file) !== 'file') refuse(`${ctx.label(file)} does not exist; lines can only be added to a file that is there`);
      if (step.content !== undefined && typeof step.content !== 'string') refuse('"content" must be text');
      resolved.push({ op: step.op, file, content: step.content ?? '', moves: step.moves === true });
    } else if (step.op === 'merge-settings') {
      const file = target(step.file, 'merge-settings');
      if (step.patch === null || typeof step.patch !== 'object' || Array.isArray(step.patch)) refuse('a merge-settings step needs a "patch" object');
      // A merge only adds. A patch that would change or remove an entry that is there is refused
      // here, before a card could show it as something that can be done.
      try {
        previewMerge({ ...where, file, patch: step.patch });
      } catch (error) {
        refuse(error.message);
      }
      resolved.push({ op: 'merge-settings', file, patch: step.patch });
    } else if (step.op === 'by-hand') {
      if (typeof step.file !== 'string' || !path.isAbsolute(step.file)) refuse('a by-hand step needs the full path of its file');
      if (typeof step.text !== 'string' || step.text.trim() === '') refuse('a by-hand step needs "text": what the person should change');
      resolved.push({ op: 'by-hand', file: absolute(step.file), text: step.text });
    } else {
      refuse(`unknown step "${step.op}"; use one of: ${STEP_OPS.join(', ')}`);
    }
  }
  // Lines that move: what the plan removes is what a step marked "moves" receives, unchanged.
  const moved = resolved.filter((step) => step.op === 'remove').flatMap((step) => step.lines);
  for (const step of resolved) {
    if (step.op !== 'write-new' && step.op !== 'append') continue;
    const written = splitLines(step.content);
    const all = [...written, ...(step.moves ? moved : [])];
    if (!all.length) refuse(`the ${step.op} step for ${ctx.label(step.file)} has no text`);
    Object.assign(step, { written, moved: step.moves ? moved.length : 0, content: `${all.join('\n')}\n` });
    if (step.op === 'append') {
      const before = linesOfFile(step.file);
      Object.assign(step, { before: before.length, wholeSha: sha256(before.join('\n')) });
    }
  }
  return resolved;
}

// The plan of a finding: the wizard's draft when there is one, else the default, else null.
function planFor(ctx, now, finding) {
  const file = draftFile(ctx, finding.id);
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    let draft;
    try {
      draft = JSON.parse(text);
    } catch {
      refuse(`${file} is not valid JSON`);
    }
    if (draft === null || typeof draft !== 'object' || !Array.isArray(draft.steps)) refuse('a draft must be an object with a list of steps');
    if (!draft.steps.length) refuse('the draft has no steps');
    return { source: 'draft', sha: sha256(text), note: typeof draft.note === 'string' ? draft.note : null, steps: resolveSteps(ctx, now, finding, draft.steps) };
  }
  const plan = defaultPlan(ctx, now, finding);
  if (!plan) return null;
  const made = { source: 'default', sha: null, note: null };
  try {
    if (plan.choices) return { ...made, choices: plan.choices.map((choice) => ({ key: choice.key, steps: resolveSteps(ctx, now, finding, choice.steps) })) };
    return { ...made, steps: resolveSteps(ctx, now, finding, plan.steps) };
  } catch (error) {
    if (!String(error.message).startsWith(REFUSED)) throw error;
    // The lines are in a file this tool does not edit (an imported document, say): the person
    // makes the change, told what the finding suggests.
    return { ...made, steps: resolveSteps(ctx, now, finding, [{ op: 'by-hand', file: finding.file, text: finding.suggestion.detail }]) };
  }
}

// Everything a plan would do, as one number: the files, the lines with their text, the new text.
const digestOf = (plan) => sha256(JSON.stringify({ steps: plan.steps ?? null, choices: plan.choices ?? null }));

// --- cards ------------------------------------------------------------------------------------------

const headingAbove = (lines, from) => {
  for (let index = from - 2; index >= 0; index -= 1) if (/^#{1,6}\s/.test(lines[index])) return lines[index];
  return null;
};

// A settings patch as what it adds where: one entry per value, keyed by its path.
function flattenPatch(patch, trail = []) {
  return Object.entries(patch).flatMap(([key, value]) => {
    if (Array.isArray(value)) return value.map((item) => ({ key: [...trail, key].join('.'), value: item }));
    if (value !== null && typeof value === 'object') return flattenPatch(value, [...trail, key]);
    return [{ key: [...trail, key].join('.'), value }];
  });
}

// The hunks of a list of steps: what each file loses and gains, with the line counts it ends at.
function hunksOf(ctx, steps, { backup = null } = {}) {
  const totals = new Map();
  const total = (file) => {
    if (!totals.has(file)) totals.set(file, entryType(file) === 'file' ? linesOfFile(file).length : 0);
    return totals.get(file);
  };
  const after = new Map();
  for (const step of steps) {
    if (step.op === 'remove') after.set(step.file, (after.get(step.file) ?? total(step.file)) - step.lines.length);
    if (step.op === 'replace') after.set(step.file, (after.get(step.file) ?? total(step.file)) - step.lines.length + splitLines(step.content).length);
    if (step.op === 'append') after.set(step.file, (after.get(step.file) ?? total(step.file)) + splitLines(step.content).length);
  }
  const moves = steps.some((step) => step.moves);
  return steps.map((step) => {
    const label = ctx.label(step.file);
    if (step.op === 'remove' || step.op === 'replace') {
      return {
        kind: step.op, label, before: total(step.file), after: after.get(step.file), from: step.from, removed: step.lines,
        heading: headingAbove(linesOfFile(step.file), step.from), moved: step.op === 'remove' && moves,
        ...(step.op === 'replace' ? { added: splitLines(step.content) } : {}),
      };
    }
    if (step.op === 'write-new') return { kind: 'create', label, total: splitLines(step.content).length, written: step.written, moved: step.moved };
    if (step.op === 'append') return { kind: 'append', label, before: step.before, after: after.get(step.file), written: step.written, moved: step.moved };
    if (step.op === 'merge-settings') return { kind: 'settings', label, created: entryType(step.file) === null, entries: flattenPatch(step.patch) };
    return { kind: 'manual', label, text: [step.text], copy: backup };
  });
}

// Cautions a program can see: a hook that already sits on the same event and matcher, and that a
// rule is broader than a sentence.
function cautions(ctx, now, steps) {
  const notes = [];
  for (const step of steps.filter((item) => item.op === 'merge-settings')) {
    const existing = now.scan.settings.find((item) => item.path === step.file)?.hooks ?? [];
    for (const [event, groups] of Object.entries(step.patch.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        const same = existing.find((hook) => hook.event === event && (hook.matcher ?? null) === (group.matcher ?? null));
        if (same) notes.push(ctx.tr('ui.card.existing.hook', { event, matcher: group.matcher ?? '*', script: path.basename(same.scripts?.[0] ?? same.command ?? '?') }));
      }
    }
    if (step.patch.hooks) notes.push(ctx.tr('ui.card.hook.every'));
    if (step.patch.permissions) notes.push(ctx.tr('ui.card.rule.broader'));
  }
  return [...new Set(notes)];
}

// Everything about the card of one finding: what is drawn, what is asked, and what each answer runs.
function buildCard(ctx, now, state, item, n, total, finding, plan) {
  const { tr, o, stamp } = ctx;
  const where = whereOf(ctx, finding);
  const steps = plan.steps ?? [];
  const byHand = steps.length > 0 && steps.every((step) => step.op === 'by-hand');
  const question = steps.length === 0 && !plan.choices;
  let backup = null;
  if (byHand) {
    // The copy is taken before the person edits: once the card is on screen it may be too late.
    const safe = steps.filter((step) => SHAPES.includes(classifyTarget(step.file, { home: ctx.home, projects: ctx.projects })?.shape));
    if (safe.length) {
      backupFiles({ files: safe.map((step) => step.file), out: ctx.files.backup, home: ctx.home, projects: ctx.projects });
      backup = ctx.label(ctx.files.backup);
    }
  }
  const own = steps.find((step) => (step.op === 'remove' || step.op === 'replace') && step.own);
  const writes = steps.some((step) => step.op !== 'by-hand') || Boolean(plan.choices);
  const list = walkList(state);
  const inFile = fileOf(list, item);
  const model = {
    n, total,
    file: { k: inFile.k, of: inFile.of },
    severity: finding.severity,
    title: byHand ? tr('ui.card.title.byhand') : finding.check === 'judgement' ? finding.title : tr(`suggestion.${finding.suggestion.kind}`),
    where,
    was: item.line !== null && finding.line !== null && item.line !== finding.line ? item.line : null,
    what: finding.message,
    why: finding.why,
    wholeWhy: finding.check === 'judgement',
    // The quote stands on its own where no hunk shows it.
    quote: finding.quote !== null && !own && !plan.choices && !byHand ? finding.quote : null,
    pair: plan.choices ? [{ where, quote: finding.quote }, { where: whereOf(ctx, finding.related[0]), quote: finding.related[0].quote }] : null,
    hunks: hunksOf(ctx, steps, { backup }),
    notes: [...(plan.note ? [plan.note] : []), ...cautions(ctx, now, steps)],
    backup: writes ? ctx.label(ctx.files.backup) : null,
  };

  const left = list.filter((entry) => !state.decisions[entry.id]);
  const restOfFile = left.filter((entry) => entry.file === item.file);
  const sameKind = checkOf(finding) === 'judgement' ? [] : left.filter((entry) => entry.check === checkOf(finding));
  const position = tr('ui.pick.card.header', { n, total });
  const header = [...position].length <= 12 ? position : `${n}/${total}`;
  const counts = tally(state);
  // A preview is put together line by line, and each line is one line whatever a file put into it.
  const before = [tr('ui.pick.preview.before'), where, ...(finding.quote ?? '').split('\n').filter(Boolean)].map((line) => visible(line)).join('\n');
  const preview = (list, tail = []) => render.previewLines(hunksOf(ctx, list), o, { title: tr('ui.pick.preview.after') }).concat(tail).join('\n');
  const base = `--run ${stamp} --card ${n} --answer`;
  const skip = { label: tr('ui.pick.card.skip'), description: tr('ui.pick.card.skip.d'), preview: before };
  const stop = { label: tr('ui.pick.card.stop'), description: tr('ui.pick.card.stop.d'), preview: render.countsText(counts, o) };
  const skipKind = sameKind.length > 1 ? { label: tr('ui.pick.card.skipkind', { count: sameKind.length }), description: tr('ui.pick.card.skipkind.d', { title: kindTitle(ctx, item) }) } : null;
  // Skipping the rest of a file moves on to the next file; it does not end the walk.
  const skipFile =
    restOfFile.length > 1
      ? {
          label: tr('ui.pick.card.skipfile', { count: restOfFile.length }),
          description: tr('ui.pick.card.skipfile.d', { others: restOfFile.length - 1, file: ctx.label(item.file) }),
          preview: [tr('ui.pick.preview.before'), ...restOfFile.map((entry) => visible(`${entry.where}  ${entry.title}`))].join('\n'),
        }
      : null;
  const files = new Set(steps.map((step) => step.file)).size;
  const options = [];
  const next = {};
  const add = (option, command) => {
    options.push(option);
    next[option.label] = command;
  };
  // A picker holds four answers and the last one is "stop". What the answers of the card itself
  // leave free goes to "skip the rest of this file" first, then to "skip all of this kind".
  const fill = () => {
    if (skipFile && options.length < 3) add(skipFile, `decide ${base} skip-file`);
    if (skipKind && options.length < 3) add(skipKind, `decide ${base} skip-kind`);
  };
  let kind = byHand ? 'byhand' : finding.suggestion.kind;
  if (plan.choices) {
    const [a, b] = plan.choices;
    add({ label: tr('ui.pick.conflict.keepA'), description: tr('ui.pick.conflict.keep.d', { where: model.pair[1].where }), preview: preview(a.steps) }, `apply ${base} choice-1`);
    add({ label: tr('ui.pick.conflict.keepB'), description: tr('ui.pick.conflict.keep.d', { where: model.pair[0].where }), preview: preview(b.steps) }, `apply ${base} choice-2`);
    add({ label: tr('ui.pick.conflict.none'), description: tr('ui.pick.conflict.none.d') }, `decide ${base} skip`);
    kind = 'review-conflict';
  } else if (byHand) {
    add({ label: tr('ui.pick.byhand.done'), description: tr('ui.pick.byhand.done.d') }, `decide ${base} done`);
    add(skip, `decide ${base} skip`);
  } else if (question) {
    add({ label: tr('ui.pick.exception.holds'), description: tr('ui.pick.exception.holds.d'), preview: before }, `decide ${base} skip`);
  } else if (finding.suggestion.kind === 'review-exception') {
    add({ label: tr('ui.pick.exception.remove'), description: tr('ui.pick.exception.remove.d'), preview: preview(steps) }, `apply ${base} apply`);
    add({ label: tr('ui.pick.exception.holds'), description: tr('ui.pick.exception.holds.d'), preview: before }, `decide ${base} skip`);
  } else {
    add({ label: tr('ui.pick.card.apply'), description: tr('ui.pick.card.apply.d', { files }), preview: preview(steps) }, `apply ${base} apply`);
    const adds = steps.some((step) => step.op === 'merge-settings');
    if (adds && own) {
      const kept = steps.filter((step) => step !== own);
      add({ label: tr('ui.pick.card.keep'), description: tr('ui.pick.card.keep.d'), preview: preview(kept, [tr('ui.pick.preview.stays', { where })]) }, `apply ${base} keep`);
    }
    add(skip, `decide ${base} skip`);
  }
  fill();
  add(stop, `decide ${base} stop`);
  next['@other'] = `The person typed what should be different. Write the draft ${draftFile(ctx, finding.id)} to match (${RECIPES}), then run: card --run ${stamp}`;
  const picker = { header, question: tr(`ui.pick.card.q.${kind}`, { where }), options };
  return {
    model,
    picker,
    next,
    // Which card is on screen, and a digest of what it showed. The steps themselves are not kept:
    // apply makes them again from the draft and the files, and compares. Of a card that is
    // changed by hand, the files it named are kept: they are what is recorded when the person
    // has made the change, and nothing is ever written from them.
    current: {
      id: finding.id, n, total, source: plan.source, draftSha: plan.sha, digest: digestOf(plan),
      backup: byHand ? Boolean(backup) : null,
      byHand: byHand ? [...new Set(steps.map((step) => step.file))] : null,
    },
  };
}

const receiptOf = (ctx, status, n, total, parts, count) => render.receipt({ status, n, total, parts, count }, ctx.o);

// Shows what comes next in the walk: the card of the first undecided finding, or what it needs,
// or the end. A finding that is no longer found was resolved by an earlier change, and says so.
function showNext(ctx, state, out, receipts = [], { afterAnswer = false } = {}) {
  const list = walkList(state);
  const now = current(ctx);
  // Receipts that could not be told earlier (a call ended in a refusal) are told first.
  const told = [...(state.receipts ?? []), ...receipts];
  const save = (waiting) => {
    state.receipts = waiting;
    writeJson(ctx.files.state, state);
  };
  for (;;) {
    const index = list.findIndex((item) => !state.decisions[item.id]);
    if (state.stopped || index === -1) {
      state.current = null;
      save([]);
      addBlock(out, [...told, ...render.walkEnd(tally(state), ctx.o)]);
      out.do = `Run: finish --run ${ctx.stamp}`;
      return;
    }
    const item = list[index];
    const n = index + 1;
    const finding = now.checks.findings.find((entry) => entry.id === item.id);
    if (!finding) {
      state.decisions[item.id] = { status: 'resolved', n, at: new Date().toISOString() };
      told.push(...receiptOf(ctx, 'resolved', n, list.length, [item.title, item.where]));
      continue;
    }
    const about = { id: finding.id, n, total: list.length, check: checkOf(finding), kind: finding.suggestion.kind, title: item.title };
    const need = () => ({
      ...about,
      severity: finding.severity, file: finding.file, line: finding.line, endLine: finding.endLine, quote: finding.quote,
      related: finding.related ?? [], data: finding.data ?? null, message: finding.message, suggested: finding.suggestion.detail,
      draft: draftFile(ctx, finding.id), settings: settingsFor(ctx, now, finding.file),
    });
    state.current = { id: item.id, n, total: list.length, pending: true };
    // The walk enters a file: its header is printed once, before whatever comes first in it.
    const enter = () => {
      if (state.fileShown === item.file) return [];
      state.fileShown = item.file;
      return fileHeader(ctx, now, list, item);
    };
    const withHeader = (lines, header) => (header.length ? [...lines, ...(lines.length ? [''] : []), ...header] : lines);
    let plan;
    try {
      plan = planFor(ctx, now, finding);
    } catch (error) {
      if (!afterAnswer || !String(error.message).startsWith(REFUSED)) {
        // Nothing is printed by a call that fails, so what there was to tell waits for the next one.
        save(told);
        throw error;
      }
      // An answer was just carried out and stands; it is told, and the next card waits for its draft.
      const header = enter();
      save([]);
      addBlock(out, withHeader(told, header));
      out.need = need();
      out.do = `The draft ${out.need.draft} was refused: ${error.message.slice(REFUSED.length)}. Correct it as ${RECIPES} says and run: card --run ${ctx.stamp}`;
      return;
    }
    if (!plan) {
      const header = enter();
      save([]);
      addBlock(out, withHeader(told, header));
      out.need = need();
      out.do = `Write the draft ${out.need.draft} as ${RECIPES} says under "${finding.suggestion.kind}", then run: card --run ${ctx.stamp}. If no draft can be made, ask the person and run: decide --run ${ctx.stamp} --card ${n} --answer skip`;
      return;
    }
    const built = buildCard(ctx, now, state, item, n, list.length, finding, plan);
    state.current = built.current;
    const header = enter();
    save([]);
    // The header is a block of its own, before the card: a card is a diff, a header is not.
    if (header.length) {
      addBlock(out, withHeader(told, header));
      addBlock(out, render.card(built.model, ctx.o), 'diff');
    } else addBlock(out, [...told, ...render.card(built.model, ctx.o)], 'diff');
    addPicker(out, built.picker, built.next, ctx.o);
    out.card = about;
    return;
  }
}

function requireCard(ctx, state, args) {
  if (!state) throw new Error(`The reading of run ${ctx.stamp} is not merged yet. Run: judged --run ${ctx.stamp}`);
  if (!state.current) throw new Error(`No card is on screen. Run: card --run ${ctx.stamp}`);
  if (args.card !== state.current.n) throw new Error(`Card ${args.card} is not the card on screen (that is card ${state.current.n}). An answer belongs to the card it was given for. Run: card --run ${ctx.stamp}`);
  return state.current;
}

// --- subcommands ------------------------------------------------------------------------------------

function banner(args, io) {
  // Before a language is chosen the banner follows the system, like the launcher's first question.
  const lang = args.lang ?? localeLanguage(io.env);
  const o = skinOf(args, io, lang);
  const tr = render.text(o);
  const out = createOutput();
  addBlock(out, render.banner({ version: VERSION, session: true }, o));
  addPicker(
    out,
    { header: tr('ui.pick.lang.header'), question: `${tr('ui.lang.question')}?`, options: LANGS.map((value) => ({ label: tr(`ui.lang.${value}`), description: tr(`ui.pick.lang.${value}.d`) })) },
    Object.fromEntries(LANGS.map((value) => [tr(`ui.lang.${value}`), `scope --lang ${value}`])),
    o,
  );
  return out;
}

// A folder as it can stand between double quotes in a command; null when it cannot.
const quotable = (folder) => (/^[^"$`\\\r\n]+$/.test(folder) ? `"${folder}"` : null);

function scope(args, io) {
  const lang = requireLang(args);
  const o = skinOf(args, io, lang);
  const tr = render.text(o);
  const out = createOutput();
  const cwd = absolute(io.cwd);
  // Not the tool itself, and not the home folder: that one holds a .claude folder and is no project.
  const other = [TOOL_ROOT, resolveHome(args.home ?? io.home)].every((folder) => canonical(folder) !== canonical(cwd));
  const here = isProject(cwd) && other && quotable(cwd) ? cwd : null;
  const q = render.scopeQuestion({ here }, o);
  const facts = render.machineFacts(DEFAULT_CAPS, o).map((line) => line.trim()).join('\n');
  const commands = { here: `check --lang ${lang} --projects ${quotable(cwd)}`, user: `check --lang ${lang} --user-only`, machine: `check --lang ${lang} --machine` };
  const options = q.options.filter((option) => option.value !== 'named');
  // The first thing shown once the language is known: what the tool changes and what it never
  // changes, the same two lists the launcher shows and the README prints.
  addBlock(out, render.promise(o));
  addBlock(out, [render.rail(1, o), '', render.answered('language', tr('ui.language.name'), o)]);
  addPicker(
    out,
    {
      header: tr('ui.pick.scope.header'),
      question: q.question,
      options: options.map((option) => ({ label: option.label, description: option.value === 'here' ? tr('ui.pick.scope.here.d', { path: here }) : option.desc, ...(option.value === 'machine' ? { preview: facts } : {}) })),
    },
    { ...Object.fromEntries(options.map((option) => [option.label, commands[option.value]])), '@other': `check --lang ${lang} --projects "<each folder the person typed, in double quotes, without a backslash at its end>"` },
    o,
  );
  return out;
}

function requireLang(args) {
  if (!LANGS.includes(args.lang)) throw new UsageError(`This command needs the language: --lang ${LANGS.join(' or ')}`);
  return args.lang;
}

// The progress block and the four panels of a run, as blocks.
function reportBlocks(ctx, out, view, { progress = null, panels = render.PANELS } = {}) {
  if (progress) {
    const answers = [['language', ctx.tr('ui.language.name')], ['scope', render.scopeText({ scope: { projects: view.scope.projects.filter((project) => !project.nestedIn), machine: view.scope.machine } }, ctx.o)]];
    // This script runs inside Claude Code: the call and what it prints are paid for from the plan.
    addBlock(out, render.compose.scan(answers, view, { ...progress, session: true }, ctx.o));
  }
  for (const key of panels) addBlock(out, render.panel(key, view, ctx.o, { rail: false }));
}

function contextOf(args, io, started) {
  const o = skinOf(args, io, started.session.lang);
  const projects = started.scan.projects.map((project) => project.path);
  return {
    home: started.session.home, stamp: started.stamp, run: started, files: started.files, o, lang: started.session.lang, tr: render.text(o), projects,
    label: (file) => displayPath(file, started.session.home, projects),
  };
}

function startInSession(args, io) {
  const lang = requireLang(args);
  if (args['user-only'] && (args.machine || args.projects.length)) throw new UsageError('--user-only cannot be combined with --machine or --projects');
  const home = resolveHome(args.home ?? io.home);
  const scanned = scanSetup({ home, scope: { projects: args.projects.map((folder) => path.resolve(io.cwd, folder)), machine: args.machine, nested: args.nested } });
  const started = startRun({ home, scan: scanned.scan, scanMs: scanned.scanMs, lang, startedBy: 'session' });
  const ctx = contextOf(args, io, started);
  const out = createOutput();
  writeReading(ctx, started.scan, started.checks);
  out.files = filesSection(ctx);
  const progress = { reportName: started.report.name, timings: started.timings, capped: started.scan.capped.hit };
  const leftOut = nestedLeftOut(started.scan);
  if (leftOut > 0) {
    // The panels wait for the answer: they would be printed twice otherwise.
    reportBlocks(ctx, out, started.view, { progress, panels: [] });
    const q = render.nestedQuestion(leftOut, ctx.o);
    addPicker(
      out,
      { header: ctx.tr('ui.pick.nested.header'), question: q.question, options: q.options.map((option) => ({ label: option.label, description: option.desc })) },
      { [q.options[0].label]: `panels --run ${started.stamp}`, [q.options[1].label]: `nested --run ${started.stamp}` },
      ctx.o,
    );
    return out;
  }
  reportBlocks(ctx, out, started.view, { progress });
  out.do = readingStep(ctx);
  return out;
}

// The same run with the repositories inside its projects: scanned again, written again.
function includeNested(args, io) {
  const ctx = openRun(args, io);
  if (readState(ctx)) throw new Error(`The reading of run ${ctx.stamp} is merged already; start a new run to change its scope.`);
  const started = performance.now();
  const { scan } = scanAgain({ home: ctx.home, scan: ctx.run.scan, nested: true });
  const scanMs = performance.now() - started;
  const { checks, view, checksMs } = check({ scan, lang: ctx.lang });
  writeJson(ctx.files.scan, scan);
  writeJson(ctx.files.checks, checks);
  writeJson(ctx.files.session, { ...ctx.run.session, scope: { ...ctx.run.session.scope, nested: true } });
  const { report, reportMs } = writeStateReport({ view, file: ctx.files.report1, home: ctx.home });
  const again = { ...ctx, run: { ...ctx.run, scan, checks }, projects: scan.projects.map((project) => project.path) };
  writeReading(again, scan, checks);
  const out = createOutput();
  out.files = filesSection(ctx);
  reportBlocks(again, out, view, { progress: { reportName: report.name, timings: { scanMs, checksMs, reportMs }, capped: scan.capped.hit } });
  out.do = readingStep(ctx);
  return out;
}

function panels(args, io) {
  const ctx = openRun(args, io);
  // The four panels of the report, and the list of suggested changes file by file.
  const names = [...render.PANELS, 'changes'];
  if (args.panel !== undefined && !names.includes(args.panel)) throw new UsageError(`Unknown panel "${args.panel}"; use one of: ${names.join(', ')}`);
  const view = buildView({ scan: ctx.run.scan, checks: ctx.run.checks, lang: ctx.lang });
  const out = createOutput();
  if (args.panel === 'changes') addBlock(out, render.changes(view, ctx.o));
  else reportBlocks(ctx, out, view, { panels: args.panel ? [args.panel] : render.PANELS });
  if (!readState(ctx)) {
    out.files = filesSection(ctx);
    out.do = readingStep(ctx);
  }
  return out;
}

function resume(args, io) {
  const ctx = openRun(args, io);
  const state = readState(ctx);
  const now = current(ctx, { judged: Boolean(state) });
  const before = JSON.stringify([ctx.run.checks.findings.map((item) => [item.id, item.line]), ctx.run.checks.candidates.map((item) => [item.id, item.line])]);
  const after = JSON.stringify([now.checks.findings.map((item) => [item.id, item.line]), now.checks.candidates.map((item) => [item.id, item.line])]);
  const changed = changedSince(ctx.run.scan, now.scan);
  const view = buildView({ scan: now.scan, checks: now.checks, lang: ctx.lang });
  // The setup moved on since the launcher looked: the run is brought up to date before anything is read.
  if ((changed.length || before !== after) && !state) {
    writeJson(ctx.files.scan, now.scan);
    writeJson(ctx.files.checks, now.checks);
    writeStateReport({ view, file: ctx.files.report1, home: ctx.home });
  }
  const readable = writeReading(ctx, now.scan, now.checks);
  const out = createOutput();
  addBlock(out, render.pickup(view, ctx.info, ctx.o, { changed: state ? 0 : changed.length || (before !== after ? 1 : 0), readable, judged: Boolean(state) }));
  out.files = filesSection(ctx);
  out.do = state ? `The reading of this run is merged already. Run: card --run ${ctx.stamp}` : readingStep(ctx);
  return out;
}

function judged(args, io) {
  const ctx = openRun(args, io);
  const earlier = readState(ctx);
  if (earlier && Object.keys(earlier.decisions).length) throw new Error(`The walk of run ${ctx.stamp} has started; the reading cannot be merged again.`);
  const { scan } = scanAgain({ home: ctx.home, scan: ctx.run.scan });
  const hasFile = existsSync(ctx.files.judgement);
  const entries = hasFile ? readJsonFile(ctx.files.judgement, 'judgement') : [];
  if (!Array.isArray(entries)) throw new Error('The judgement file must hold a JSON array');
  // What was read is listed again whatever the setup did in the meantime, so a verdict meets its candidate.
  const read = judgedCandidates(ctx, entries);
  const base = runChecks(scan, { lang: ctx.lang, read });
  if (!hasFile && base.candidates.length) throw new Error(ctx.tr('ui.judged.missing', { file: ctx.files.judgement, count: base.candidates.length }));
  const named = new Set(entries.map((entry) => entry?.candidate).filter(Boolean));
  const waiting = base.candidates.filter((candidate) => !named.has(candidate.id));
  if (waiting.length) throw new Error(ctx.tr('ui.judged.unjudged', { count: waiting.length, ids: waiting.map((candidate) => candidate.id).join(', ') }));
  // The checks refuse an entry whose quote is not the exact text of its lines: no quote, no finding.
  const checks = runChecks(scan, { lang: ctx.lang, read, judgement: entries });
  const view = buildView({ scan, checks, lang: ctx.lang });
  writeJson(ctx.files.scan, scan);
  writeJson(ctx.files.checks, checks);
  writeStateReport({ view, file: ctx.files.report1, home: ctx.home });
  const queue = orderQueue(ctx, scan, checks.findings);
  writeJson(ctx.files.state, { version: 1, judgedAt: new Date().toISOString(), walk: null, stopped: false, fileShown: null, queue, decisions: {}, current: null });

  const out = createOutput();
  const { tr, o, stamp } = ctx;
  addBlock(out, render.judged(view, o, { queue: queue.length }));
  // What the walk will go through, file by file: the same list report 1 has.
  if (queue.length) addBlock(out, render.changes(view, o));
  if (ctx.run.session.startedBy === 'session') {
    out.open = opener(ctx.files.report1, io.platform);
    addPicker(
      out,
      {
        header: tr('ui.pick.report1.header'),
        question: tr('ui.pick.report1.q'),
        options: [
          { label: tr('ui.pick.report.yes'), description: tr('ui.pick.report1.yes.d') },
          { label: tr('ui.pick.report.no'), description: tr('ui.pick.report.no.d') },
        ],
      },
      { [tr('ui.pick.report.yes')]: out.open ? '@open' : '', [tr('ui.pick.report.no')]: '' },
      o,
    );
  }
  if (queue.length) {
    const urgent = queue.filter((item) => item.severity !== 'low').length;
    const some = urgent > 0 && urgent < queue.length;
    addPicker(
      out,
      {
        header: tr('ui.pick.changes.header'),
        question: tr('ui.pick.changes.q', { count: queue.length }),
        options: [
          { label: tr('ui.pick.changes.all'), description: tr('ui.pick.changes.all.d') },
          ...(some ? [{ label: tr('ui.pick.changes.some'), description: tr('ui.pick.changes.some.d', { count: urgent }) }] : []),
          { label: tr('ui.pick.changes.no'), description: tr('ui.pick.changes.no.d') },
        ],
      },
      { [tr('ui.pick.changes.all')]: `card --run ${stamp} --walk all`, ...(some ? { [tr('ui.pick.changes.some')]: `card --run ${stamp} --walk urgent` } : {}), [tr('ui.pick.changes.no')]: '' },
      o,
    );
  }
  return out;
}

function card(args, io) {
  const ctx = openRun(args, io);
  const state = readState(ctx);
  if (!state) throw new Error(`The reading of run ${ctx.stamp} is not merged yet. Run: judged --run ${ctx.stamp}`);
  if (args.walk !== undefined) {
    if (!['all', 'urgent'].includes(args.walk)) throw new UsageError(`Unknown walk "${args.walk}"; use all or urgent`);
    if (Object.keys(state.decisions).length && state.walk !== args.walk) throw new Error('The walk has started; its extent cannot change now.');
    state.walk = args.walk;
  }
  if (!state.walk) state.walk = 'all';
  const out = createOutput();
  showNext(ctx, state, out);
  return out;
}

// The plan behind the card on screen, made again from its draft and from the files as they are
// now. The state file says only which card is shown and carries a digest of what it showed: what
// apply does is never taken from there, so editing that file cannot change it. A draft or a
// file that changed since the card was shown gives another digest, and the answer is refused.
function shownPlan(ctx, state, args) {
  const shown = requireCard(ctx, state, args);
  if (shown.pending) throw new Error(`Card ${shown.n} has not been shown yet. Run: card --run ${ctx.stamp}`);
  const now = current(ctx);
  const finding = now.checks.findings.find((entry) => entry.id === shown.id);
  const again = `Nothing was written. Run: card --run ${ctx.stamp}`;
  if (!finding) throw new Error(`A file changed since the card was shown. ${again}`);
  let plan = null;
  try {
    plan = planFor(ctx, now, finding);
  } catch (error) {
    if (!String(error.message).startsWith(REFUSED)) throw error;
  }
  if (!plan || digestOf(plan) !== shown.digest) {
    const draft = existsSync(draftFile(ctx, shown.id)) ? sha256(readFileSync(draftFile(ctx, shown.id), 'utf8')) : null;
    throw new Error(draft !== shown.draftSha ? `The draft changed after its card was shown. ${again}` : `A file changed since the card was shown. ${again}`);
  }
  return { shown, finding, plan };
}

// Carries out the plan of the card on screen: what is created first, what leaves second, so a
// failure never loses text.
function apply(args, io) {
  const ctx = openRun(args, io);
  const state = readState(ctx);
  const { shown, finding, plan } = shownPlan(ctx, state, args);
  let steps;
  if (args.answer === 'apply' && plan.steps?.length) steps = plan.steps;
  else if (args.answer === 'keep' && plan.steps?.some((step) => step.own)) steps = plan.steps.filter((step) => !step.own);
  else if (/^choice-[12]$/.test(args.answer ?? '') && plan.choices) steps = plan.choices[Number(args.answer.slice(-1)) - 1].steps;
  else throw new UsageError(`"${args.answer}" is not an answer this card has`);
  if (steps.some((step) => step.op === 'by-hand')) throw new UsageError('This card is changed by hand; its answers are done, skip and stop');

  const where = { home: ctx.home, projects: ctx.projects, backup: ctx.files.backup };
  const parts = [];
  const created = [];
  const touched = new Set();
  const shapeOf = (file) => classifyTarget(file, { home: ctx.home, projects: ctx.projects })?.shape;
  for (const step of steps.filter((entry) => ['write-new', 'append', 'merge-settings'].includes(entry.op))) {
    touched.add(step.file);
    if (step.op === 'write-new') {
      writeNew({ ...where, file: step.file, content: step.content });
      created.push({ type: CREATED[shapeOf(step.file)] ?? 'file', path: step.file });
      parts.push(render.receiptPart('created', { file: ctx.label(step.file) }, ctx.o));
    } else if (step.op === 'append') {
      const result = appendLines({ ...where, file: step.file, expectSha: step.wholeSha, content: step.content });
      parts.push(render.receiptPart('lines', { file: ctx.label(step.file), before: result.linesBefore, after: result.linesAfter }, ctx.o));
    } else {
      const result = mergeSettings({ ...where, file: step.file, patch: step.patch });
      if (!result.changed) parts.push(ctx.tr('ui.receipt.part.nochange'));
      else {
        created.push({ type: step.patch.hooks ? 'hook' : 'setting', path: step.file });
        const keys = flattenPatch(step.patch).map((entry) => entry.key);
        for (const key of new Set(keys)) parts.push(render.receiptPart('settings', { key, count: keys.filter((name) => name === key).length }, ctx.o));
      }
    }
  }
  // Line edits of one file go from the bottom up, so the lines above keep their numbers.
  const edits = steps.filter((entry) => entry.op === 'remove' || entry.op === 'replace').sort((a, b) => (a.file === b.file ? b.from - a.from : 0));
  const sizes = new Map();
  for (const step of edits) {
    touched.add(step.file);
    const options = { ...where, file: step.file, from: step.from, to: step.to, expectSha: step.sha };
    const result = step.op === 'remove' ? removeLines(options) : replaceLines({ ...options, content: step.content });
    sizes.set(step.file, { before: sizes.get(step.file)?.before ?? result.linesBefore, after: result.linesAfter });
  }
  for (const [file, size] of sizes) parts.push(render.receiptPart('lines', { file: ctx.label(file), ...size }, ctx.o));
  if (args.answer === 'keep') parts.push(ctx.tr('ui.receipt.part.kept'));

  record({ applied: ctx.files.applied, id: shown.id, kind: finding.suggestion.kind, files: [...touched], created, backup: ctx.files.backup, home: ctx.home });
  state.decisions[shown.id] = { status: 'applied', answer: args.answer, n: shown.n, at: new Date().toISOString() };
  const out = createOutput();
  showNext(ctx, state, out, receiptOf(ctx, 'applied', shown.n, shown.total, parts), { afterAnswer: true });
  return out;
}

// An answer that applies nothing: skip this one, skip every one of its kind, stop the walk, or
// "done" for a card the person changed by hand.
function decide(args, io) {
  const ctx = openRun(args, io);
  const state = readState(ctx);
  const shown = requireCard(ctx, state, args);
  const item = state.queue.find((entry) => entry.id === shown.id);
  const at = new Date().toISOString();
  const skip = (entry, n) => {
    record({ applied: ctx.files.applied, id: entry.id, kind: entry.kind, status: 'skipped', home: ctx.home });
    state.decisions[entry.id] = { status: 'skipped', answer: args.answer, n, at };
  };
  const receipts = [];
  if (args.answer === 'skip') {
    skip(item, shown.n);
    receipts.push(...receiptOf(ctx, 'skipped', shown.n, shown.total, [item.title]));
  } else if (args.answer === 'skip-kind' || args.answer === 'skip-file') {
    // Every undecided change of this kind, or every undecided change of this file: skipped, never
    // applied. After "the rest of this file" the walk goes on with the next file.
    const list = walkList(state);
    const [key, status, part] = args.answer === 'skip-kind' ? ['check', 'skipped-kind', kindTitle(ctx, item)] : ['file', 'skipped-file', ctx.label(item.file)];
    const same = list.filter((entry) => entry[key] === item[key] && !state.decisions[entry.id]);
    for (const entry of same) skip(entry, list.indexOf(entry) + 1);
    receipts.push(...receiptOf(ctx, same.length > 1 ? status : 'skipped', shown.n, shown.total, [part], same.length - 1));
  } else if (args.answer === 'stop') {
    state.stopped = true;
    receipts.push(...receiptOf(ctx, 'stopped', shown.n, shown.total, []));
  } else if (args.answer === 'done') {
    if (shown.pending) throw new Error(`Card ${shown.n} has not been shown yet. Run: card --run ${ctx.stamp}`);
    if (!Array.isArray(shown.byHand)) throw new UsageError('"done" answers a card that is changed by hand');
    // "Done" is the person's word that the file was changed, so the file is looked at again.
    // What is recorded is what is seen: a finding that is gone was changed by hand, and one
    // that is still found is not recorded at all. Its card stays open and comes back.
    if (current(ctx).checks.findings.some((entry) => entry.id === shown.id)) {
      // One line; the card under it names the file.
      receipts.push(...receiptOf(ctx, 'still-there', shown.n, shown.total, []));
    } else {
      // The person changed the file; this tool did nothing to it but take a copy first. It is
      // recorded as that, so no summary and no report can say the tool applied the change.
      record({ applied: ctx.files.applied, id: shown.id, kind: item.kind, status: 'by-hand', files: shown.byHand, backup: shown.backup ? ctx.files.backup : null, home: ctx.home });
      state.decisions[shown.id] = { status: 'by-hand', answer: 'done', n: shown.n, at };
      receipts.push(...receiptOf(ctx, 'by-hand', shown.n, shown.total, shown.byHand.map((file) => ctx.label(file))));
    }
  } else {
    throw new UsageError(`"${args.answer}" is not a decision; use skip, skip-file, skip-kind, stop or done`);
  }
  const out = createOutput();
  showNext(ctx, state, out, receipts, { afterAnswer: true });
  return out;
}

function finish(args, io) {
  const ctx = openRun(args, io);
  const state = readState(ctx);
  const now = current(ctx, { judged: Boolean(state) });
  writeJson(ctx.files.scanAfter, now.scan);
  writeJson(ctx.files.checksAfter, now.checks);
  const applied = existsSync(ctx.files.applied) ? readJsonFile(ctx.files.applied, 'applied') : [];
  const flows = existsSync(ctx.files.flows) ? readJsonFile(ctx.files.flows, 'flows') : null;
  const view = buildView({ scan: now.scan, checks: now.checks, before: ctx.run.checks, applied, flows, lang: ctx.lang });
  const report = writeReport(renderAfterView(view), ctx.files.report2, ctx.home);
  const counts = state ? tally(state) : { applied: 0, byHand: 0, skipped: 0, resolved: 0, open: ctx.run.checks.findings.length };
  const out = createOutput();
  const { tr, o } = ctx;
  const info = runInfo(ctx.stamp, { name: path.basename(report.path), url: fileUrl(report.path), path: report.path });
  addBlock(out, render.summary(view, info, o, { counts, before: ctx.run.checks.metrics.findings, backup: applied.some((entry) => entry.backup) ? ctx.label(ctx.files.backup) : null }));
  out.open = opener(report.path, io.platform);
  addPicker(
    out,
    {
      header: tr('ui.pick.report2.header'),
      question: tr('ui.pick.report2.q'),
      options: [
        { label: tr('ui.pick.report.yes'), description: tr('ui.pick.report2.yes.d') },
        { label: tr('ui.pick.report.no'), description: tr('ui.pick.report.no.d') },
      ],
    },
    { [tr('ui.pick.report.yes')]: out.open ? '@open' : '', [tr('ui.pick.report.no')]: '' },
    o,
  );
  if (ctx.run.session.startedBy === 'launcher') out.say = tr('ui.summary.still');
  return out;
}

const COMMANDS = { banner, scope, check: startInSession, nested: includeNested, panels, resume, judged, card, apply, decide, flow, finish };
export const SUBCOMMANDS = Object.keys(COMMANDS);

// One call. io: { cwd, env, platform, home }. Returns { code, out, err } and prints nothing.
export async function ui(argv, io = {}) {
  const context = { cwd: io.cwd ?? process.cwd(), env: io.env ?? process.env, platform: io.platform ?? process.platform, home: io.home ?? null };
  try {
    const args = parseArgs(argv, OPTIONS);
    const [command, stamp] = args._;
    if (!(command in COMMANDS)) throw new UsageError(`ui.mjs needs a subcommand: ${Object.keys(COMMANDS).join(', ')}`);
    if (command === 'resume') {
      if (!stamp) throw new UsageError('resume needs the stamp of a run, like 20261001-131730');
      args.run = stamp;
    }
    if (args.run !== undefined && !isStamp(args.run)) throw new Error(`"${args.run}" is not the name of a run; a run is named like 20261001-131730`);
    if (args.run !== undefined) runFiles(resolveHome(args.home ?? context.home), args.run);
    const out = COMMANDS[command](args, context);
    const text = args.json ? envelope(out) : out.blocks.map((block) => block.lines.join('\n')).join('\n\n') + (out.blocks.length ? '\n' : '');
    return { code: 0, out: text, err: '' };
  } catch (error) {
    return { code: 1, out: '', err: `${error instanceof UsageError ? 'Usage error: ' : 'Error: '}${visible(error.message)}\n` };
  }
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const result = await ui(process.argv.slice(2));
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err);
  process.exitCode = result.code;
}
