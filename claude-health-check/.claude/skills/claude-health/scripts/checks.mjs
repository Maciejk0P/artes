// Deterministic checks over a scan. The result keeps four things apart:
//   findings    what a program can prove from the files (a length, a missing file, an exact copy)
//   candidates  what the wording of a line suggests and nothing else does (a pair that may
//               contradict, a rule that may carry an exception, a numbered block that may be a
//               procedure, a line that may be a hook, a command or a permission rule). They have
//               no severity and are not counted with the findings; a reader confirms or dismisses
//               each one. A check is one or the other: add() and addCandidate() refuse the rest.
//   review      things to look at that propose no change (an MCP server without a permission rule)
//   notes       what would be a finding on a skill of your own and is only a remark on a
//               third-party one
// plus two measures: what loads at every session start, and what that costs in context.
//
// Every number used here comes from lib/facts.mjs, where each one carries its source.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CATALOGUE } from './lib/catalogue.mjs';
import { deliver, parseArgs, readJsonFile, requireOption, runCli } from './lib/cli.mjs';
import { FACTS, HOOK_EVENTS, LIMITS, SOURCES, STACK_MARKERS } from './lib/facts.mjs';
import { parseFrontMatter } from './lib/frontmatter.mjs';
import { globMatcher, starEnds } from './lib/glob.mjs';
import { resolveHookScript } from './lib/hooks.mjs';
import { MEMORY_KINDS, SEVERITIES, SUGGESTION_KINDS } from './lib/kinds.mjs';
import { commentMask, fenceMask, instructionLines, splitLines, stripListMarker } from './lib/markdown.mjs';
import { absolute, displayPath, isInside } from './lib/paths.mjs';
import { MASK } from './lib/secrets.mjs';
import { assertLang, t } from './lib/strings.mjs';
import { STOP_WORDS, isInstructionSentence, sentencesOf } from './lib/wording.mjs';

export { SUGGESTION_KINDS };

// Checks that produce findings: what a program can prove from the files.
export const CHECKS = [
  'memory-too-long',
  'memory-too-large',
  'always-loaded-total',
  'duplicate-within',
  'duplicate-across',
  'same-line-in-projects',
  'skill-no-description',
  'skill-name-mismatch',
  'skill-too-long',
  'skill-description-too-long',
  'skill-copies-differ',
  'skill-unreachable',
  'front-matter-unreadable',
  'command-no-description',
  'agent-no-description',
  'settings-invalid-json',
  'hook-missing-file',
  'hook-unknown-event',
  'import-unresolved',
  'import-too-deep',
];

// Checks whose only evidence is the wording of a line. Word lists cannot tell an instruction
// from a description, a list of steps from a list of principles, or what Claude may run from
// what a test may use, so none of these is ever a finding: each is a candidate, with no
// severity, until a reader confirms it with the exact text of its lines.
export const CANDIDATE_CHECKS = [
  'conflict-candidate',
  'exception',
  'procedure-in-memory',
  'repeated-request',
  'automation-in-memory',
  'permission-in-prose',
  'project-specific-in-user',
  'skill-no-when-cue',
];

// Things to review that propose no change.
export const REVIEW_CHECKS = ['mcp-no-permission-rule'];

// Findings about the text of a skill. On a third-party skill they become notes.
const SKILL_TEXT_CHECKS = [
  'skill-no-description',
  'skill-no-when-cue',
  'skill-name-mismatch',
  'skill-too-long',
  'skill-description-too-long',
  'skill-unreachable',
  'front-matter-unreadable',
];

const MIN_DUPLICATE_WORDS = 3;
const MAX_GLOB_CHARS = 500;

// --- wording patterns, English and Slovak -----------------------------------------------------

const NEGATIVE = [
  /\b(never|do not|don't|dont|must not|should not|shouldn't|avoid)\b/i,
  /(?<![\p{L}])(nikdy|nesmieš|nesmie|vyhni sa|vyhýbaj sa|nepouž\p{L}*|nerob\p{L}*|nespúšťaj\p{L}*)(?![\p{L}])/iu,
];
const POSITIVE = [
  /\b(always|must|use|prefer|should)\b/i,
  /(?<![\p{L}])(vždy|musí\p{L}*|použi\p{L}*|používaj\p{L}*|preferuj\p{L}*)(?![\p{L}])/iu,
];
const EXCEPTION = [
  /\b(except(?: for| when| in| if)?|unless|but not|only when|only if|with the exception of)\b/i,
  /(?<![\p{L}])(s výnimkou|okrem|pokiaľ nie|iba ak|len ak|iba keď|len keď|výnimka|výnimkou)(?![\p{L}])/iu,
];
// A hook candidate is a clause that (1) says when: a trigger, and (2) tells Claude to run a tool:
// an action verb in the imperative, with a command or a tool as its object. A trigger next to a
// verb is not enough: "always format dates as ISO 8601" and "ask before you run a migration" are
// instructions to follow, not something a hook could run.
const AUTOMATION = {
  en: {
    trigger: /\b(always|after|before|every time|each time|whenever|on save|on commit|on every|on each)\b/i,
    verb: /\b(run|rerun|execute|lint|format|test|typecheck|type-check|build|rebuild|compile)\b/gi,
    // English verbs double as nouns ("the test", "a build"), so the verb has to stand where an
    // imperative stands: at the start of the clause, or right after "always", "then", "and" or a comma.
    imperative: /(?:^\s*(?:(?:please|then|also)\s+)?|,\s*|\b(?:always|then|and|also)\s+)$/i,
    runs: /^(run|rerun|execute)$/i,
    tool: /^(?:(?:the|all|your|our|every)\s+)?(?:(?:full|whole|entire|unit|integration)\s+)?(?:tests?|test suite|linter|lint|formatter|prettier|eslint|build|type ?checker?|typecheck|checks?)\b/i,
    neutral:
      /^(?:$|[.,!]|(?:and|or)\b|(?:it|them|everything)\b|(?:the|all|every|each|your|any)\s+(?:(?:changed|edited|modified|touched|new)\s+)?(?:files?|code|changes?|project|sources?)\b)/i,
  },
  sk: {
    trigger:
      /(?<![\p{L}])(vždy|po každ\p{L}*|pred každ\p{L}*|pri každ\p{L}*|zakaždým|kedykoľvek|po úprave|po zmene|pri uložení)(?![\p{L}])/iu,
    // These forms are imperatives by their ending, so their position in the clause proves nothing more.
    verb: /(?<![\p{L}])(spusti|spúšťaj|pusti|naformátuj|formátuj|zlintuj|lintuj|otestuj|testuj|zostav)(?![\p{L}])/giu,
    imperative: null,
    runs: /^(spusti|spúšťaj|pusti)$/iu,
    tool: /^(?:(?:všetky|celé|celú|jednotkové)\s+)?(?:testy|test|linter|lint|formátovač|prettier|eslint|build|kontroly|kontrolu)(?![\p{L}])/iu,
    neutral: /^(?:$|[.,!]|(?:a|alebo|ho|ju|ich|to|súbor|súbory|kód|zmeny)(?![\p{L}]))/iu,
  },
};
const REPEATED_REQUEST = [
  /\b(when|whenever|if|every time|each time|any time)\s+i\s+(say|type|write|ask|tell|send|mention)\b/i,
  /(?<![\p{L}])(keď|ak|kedykoľvek|zakaždým keď|vždy keď)\s+(ti\s+)?(poviem|napíšem|zadám|pošlem)(?![\p{L}])/iu,
];
const PROHIBITION_EN = /\b(never|do not|don't|must not)\s+(run|execute|use|call|invoke)\b/i;
const PROHIBITION_SK = /(?<![\p{L}])(nespúšťaj|nepúšťaj|nepoužívaj|nevolaj)(?![\p{L}])/iu;
// "Never run X without asking" does not forbid X; it asks for a confirmation first.
const ASK_FIRST = [
  /\bwithout\s+(?:first\s+)?(?:my\s+)?(?:asking|confirmation|confirming|permission|approval)\b/i,
  /(?<![\p{L}])bez\s+(?:môjho\s+)?(?:opýtania|súhlasu|potvrdenia|povolenia)(?![\p{L}])/iu,
];
// Words that end the command in "never run git push --force on main".
const COMMAND_STOP = new Set(
  (
    'on in at to for from with without unless until when while if before after against and or but because during ' +
    'inside outside by as anywhere here there directly manually automatically yourself ever again please globally locally ' +
    'na v vo bez pri do z zo ak keď kým pokiaľ okrem pred po a alebo ale'
  ).split(' '),
);
const COMMAND_WORD = /^[\w@./:=~+-]+$/;
// The tools whose permission rules name a shell command.
const SHELL_TOOLS = ['Bash', 'PowerShell'];
const SKILL_CUE = [
  /\b(use (this |it )?(when|for|if|whenever|after|before|proactively)|when (the user|you|asked|a|an|the)|trigger|invoke (when|for)|should be used)\b/i,
  /(?<![\p{L}])(použi|použiť|keď)(?![\p{L}])/iu,
];

// "never use X" is a prohibition of a command only when X is one; `any` or `var` are not.
const KNOWN_COMMANDS = new Set(
  (
    'rm sudo curl wget git npm npx pnpm yarn docker kubectl pip pip3 ssh scp chmod chown kill dd mv cp sed awk make ' +
    'terraform aws gcloud az psql mysql brew apt apt-get yum powershell pwsh bash sh zsh eval node python python3 ' +
    'pytest cargo go mvn gradle deno bun'
  ).split(' '),
);

const matchesAny = (patterns, text) => patterns.some((pattern) => pattern.test(text));
const isNegative = (text) => matchesAny(NEGATIVE, text);

export function matchException(text) {
  for (const pattern of EXCEPTION) {
    const match = pattern.exec(text);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

// true when the line is written as an instruction. When the line carries an exception marker,
// the sentence that holds the marker is the one that has to be an instruction.
export function isInstruction(text) {
  const sentences = sentencesOf(text);
  const marked = sentences.filter((sentence) => matchException(sentence));
  return (marked.length ? marked : sentences).some(isInstructionSentence);
}

export function matchRepeatedRequest(text) {
  return matchesAny(REPEATED_REQUEST, text);
}

function automationIn(clause, rules) {
  if (!rules.trigger.test(clause)) return null;
  // Verbs are looked for outside inline code, so the words of a quoted command are not candidates.
  const visible = clause.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
  for (const match of visible.matchAll(rules.verb)) {
    if (rules.imperative && !rules.imperative.test(visible.slice(0, match.index))) continue;
    const after = clause.slice(match.index + match[0].length).trimStart();
    const span = /^`([^`]+)`/.exec(after);
    if (span) return { command: span[1].trim() };
    if (rules.tool.test(after)) return { command: null };
    // "lint", "format" or "test" need no object, or a neutral one ("it", "the changed files").
    const trigger = rules.trigger.exec(after);
    if (!rules.runs.test(match[1]) && (rules.neutral.test(after) || trigger?.index === 0)) return { command: null };
  }
  return null;
}

// { command } when the line may describe something to run on every event: the command it
// quotes, or null when it only names a tool. null when the line is not such a candidate.
export function matchAutomation(text) {
  for (const clause of stripListMarker(text).split(/;|\.\s+/)) {
    if (isNegative(clause) || matchRepeatedRequest(clause)) continue;
    for (const rules of Object.values(AUTOMATION)) {
      const found = automationIn(clause, rules);
      if (found) return found;
    }
  }
  return null;
}

// The command at the start of a phrase, up to the first word that cannot belong to it:
// "git push --force on main" gives "git push --force". null when the first word is not a command.
function commandPhrase(rest) {
  const phrase = [];
  for (const word of rest.trim().split(/\s+/).slice(0, 8)) {
    const bare = word.replace(/[.,;:!?]+$/, '');
    if (phrase.length === 0) {
      if (!KNOWN_COMMANDS.has(bare)) return null;
    } else if (COMMAND_STOP.has(bare.toLowerCase()) || !COMMAND_WORD.test(bare)) break;
    phrase.push(bare);
    if (bare !== word) break;
  }
  return phrase.length ? phrase.join(' ') : null;
}

// { command, list } when the line restricts running a command: list is 'deny' for a prohibition
// and 'ask' when the line only wants to be asked first. null for anything else.
// The command is taken from inline code right after the verb, or, without inline code, only
// when the phrase starts with a known command; "never run migrations" names no command.
export function matchPermission(text) {
  const list = matchesAny(ASK_FIRST, text) ? 'ask' : 'deny';
  for (const pattern of [PROHIBITION_EN, PROHIBITION_SK]) {
    const match = pattern.exec(text);
    if (!match) continue;
    const verb = (pattern === PROHIBITION_EN ? match[2] : match[1]).toLowerCase();
    const runs = ['run', 'execute', 'nespúšťaj', 'nepúšťaj'].includes(verb);
    const rest = text.slice(match.index + match[0].length);
    const span = /^\s*(?:the\s+)?(?:command\s+)?`([^`]+)`/i.exec(rest);
    if (span) {
      const command = span[1].trim();
      if (runs || KNOWN_COMMANDS.has(command.split(/\s+/)[0])) return { command, list };
      continue;
    }
    if (!runs) continue;
    const command = commandPhrase(rest);
    if (command) return { command, list };
  }
  return null;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A permission rule for a shell command in the documented format, Tool(specifier), where "*"
// stands for any text (FACTS.permissionRules).
export function permissionRule(command) {
  return `Bash(${command} *)`;
}

// true when a permission rule for the shell covers the command: `Bash(git push *)` covers
// "git push --force", `Bash(terraform destroy *)` does not cover "rm", a bare `Bash` covers both.
// The rule is read in the documented format: `Tool` or `Tool(specifier)`, "*" for any text. The
// older spelling of a prefix, `Bash(git push:*)`, is still found in settings files and is read as
// `Bash(git push *)`, so that a rule which is there is not reported as missing.
export function ruleCoversCommand(rule, command) {
  const call = /^([A-Za-z_]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!call || !SHELL_TOOLS.includes(call[1])) return false;
  if (call[2] === undefined) return true;
  let specifier = call[2].trim();
  if (specifier.endsWith(':*')) specifier = `${specifier.slice(0, -2)} *`;
  if (specifier === '' || specifier === '*') return true;
  // A closing " *" matches the command with arguments and the command alone.
  const open = specifier.endsWith(' *');
  // A rule is a line of a settings file, so it is compared, never made into a regular expression:
  // one with a dozen stars would be searched for minutes (lib/glob.mjs).
  const ends = starEnds((open ? specifier.slice(0, -2) : specifier).split('*'), command);
  return open ? ends.some((end, at) => end && (at === command.length || command[at] === ' ')) : ends[command.length];
}

// true when a permission rule names the MCP server: the whole server, or one of its tools.
export function ruleNamesServer(rule, server) {
  const text = rule.trim();
  return text === `mcp__${server}` || text.startsWith(`mcp__${server}__`);
}

function clausesOf(text) {
  return stripListMarker(text)
    .split(/;|\.\s+|\s[—–]\s|,\s+but\s+/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function polarityOf(clause) {
  if (isNegative(clause)) return 'neg';
  return matchesAny(POSITIVE, clause) ? 'pos' : null;
}

function termsOf(clause) {
  const terms = new Set();
  for (const match of clause.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    let word = match[0];
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
    if (!STOP_WORDS.has(word)) terms.add(word);
  }
  return terms;
}

const STEP_LINE = /^\s{0,3}(?:\d+[.)]\s+\S|(?:[-*+]\s+)?(?:\*\*)?(?:step|krok)\s+\d+\b)/i;

// Blocks of numbered or "Step N" lines, each from its first step to the last line that belongs
// to a step. A step keeps what hangs under it: indented lines, a code block (indented, or
// directly under the step), and an unindented line right after it. The block ends at a heading,
// at another list, and at a paragraph that follows a blank line.
// Each block: { start, end, steps }.
function findProcedures(lines, mask) {
  const blocks = [];
  let block = null;
  const close = () => {
    if (block && block.steps >= LIMITS.procedureSteps.value) blocks.push(block);
    block = null;
  };
  const extend = (index) => {
    block.end = index;
    block.gap = false;
  };
  lines.forEach((line, index) => {
    const indented = /^(?: {2,}|\t)\s*\S/.test(line);
    if (mask[index]) {
      if (!block) return;
      // The first line of a code block decides for all of it. One that follows a blank line
      // without being indented may be an example after the list: the block stays open for a
      // further step, and its range does not grow to take the example with it.
      if (index === 0 || !mask[index - 1]) block.codeInside = indented || !block.gap;
      if (block.codeInside) extend(index);
      else block.gap = true;
      return;
    }
    if (STEP_LINE.test(line)) {
      block ??= { start: index, end: index, steps: 0, gap: false };
      block.steps += 1;
      extend(index);
      return;
    }
    if (!block) return;
    if (line.trim() === '') block.gap = true;
    else if (indented) extend(index);
    else if (block.gap || /^#{1,6}\s/.test(line) || /^[-*+]\s+\S/.test(line)) close();
    else extend(index);
  });
  close();
  return blocks;
}

// For every line, the line number of the heading it sits under (0 before the first heading).
function sectionsByLine(lines, mask) {
  const out = new Array(lines.length).fill(0);
  let current = 0;
  lines.forEach((line, index) => {
    if (!mask[index] && /^#{1,6}[ \t]/.test(line)) current = index + 1;
    out[index] = current;
  });
  return out;
}

const wholeWord = (word) => new RegExp(`(?<![\\w-])${escapeRegExp(word)}(?![\\w-])`, 'i');
const hash = (algorithm, text) => createHash(algorithm).update(text).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

export function runChecks(scan, options = {}) {
  const lang = assertLang(options.lang ?? 'en');
  const totalLimit = options.totalLines ?? LIMITS.alwaysLoadedLines.value;
  const home = scan.home;
  const projects = scan.projects ?? [];
  const projectPaths = projects.map((project) => project.path);
  const label = (file) => displayPath(file, home, projectPaths);
  const byPath = new Map(scan.files.map((file) => [file.path, file]));
  const isOversize = (file) => file.bytes > LIMITS.memoryFileBytes.value;
  const tokensOf = (bytes) => Math.ceil(bytes / LIMITS.bytesPerToken.value);

  const sourceParams = {
    memorySource: SOURCES.memory,
    skillsSource: SOURCES.skills,
    hooksSource: SOURCES.hooks,
    permissionsSource: SOURCES.permissions,
    settingsSource: SOURCES.settings,
    mcpSource: SOURCES.mcp,
    checkedOn: FACTS.checkedOn,
  };

  const bodies = new Map();
  function linesOf(file) {
    if (!bodies.has(file.path)) {
      let content;
      try {
        content = readFileSync(file.path, 'utf8');
      } catch (error) {
        throw new Error(`Cannot read ${file.path}, which the scan lists (${error.code}). Run scan.mjs again.`);
      }
      const lines = splitLines(content);
      if (lines.length !== file.lines) {
        throw new Error(`${file.path} changed since the scan (${file.lines} lines then, ${lines.length} now). Run scan.mjs again.`);
      }
      bodies.set(file.path, lines);
    }
    return bodies.get(file.path);
  }

  // What loads of a file: its lines and bytes without the block-level comments Claude Code
  // strips before it injects a memory file (the scan counts them; FACTS.comments).
  const loadedLines = (file) => file.lines - (file.commentLines ?? 0);
  const loadedBytes = (file) => file.bytes - (file.commentBytes ?? 0);

  // The lines of a file as loaded text. A memory file can import a rule, skill, command or agent
  // file; that file is then loaded text too, minus its front matter, which is not an instruction.
  // Lines of code and lines of a block-level comment are masked: neither is an instruction.
  const docCache = new Map();
  function docFor(file) {
    if (!docCache.has(file.path)) {
      const lines = linesOf(file);
      const fences = fenceMask(lines);
      const comments = commentMask(lines, fences);
      const mask = fences.map((masked, index) => masked || comments[index]);
      if (!MEMORY_KINDS.includes(file.kind)) mask.fill(true, 0, parseFrontMatter(lines.join('\n')).endLine);
      docCache.set(file.path, { file, lines, mask, instructions: instructionLines(lines, mask), sections: sectionsByLine(lines, mask) });
    }
    return docCache.get(file.path);
  }

  const findings = [];
  const candidates = [];
  const notes = [];
  const review = [];
  const ids = new Set();

  // The id the next entry with these parts gets: the same parts give the same id on every run.
  function nextId(check, parts) {
    let id;
    for (let occurrence = 0; id === undefined || ids.has(id); occurrence += 1) {
      id = `${check}-${hash('sha1', [check, ...parts, occurrence].join('\n')).slice(0, 10)}`;
    }
    return id;
  }
  function newId(check, parts) {
    const id = nextId(check, parts);
    ids.add(id);
    return id;
  }
  // What names an entry: its file, as it is labelled, and its text.
  const idParts = (where, extra) => [label(where.file), String(extra.key ?? where.quote ?? '').replace(/\s+/g, ' ').trim()];

  // What a finding and a candidate share. `strings` is "check" or "candidate": the two word the
  // same observation differently, one as a fact and one as a question.
  function entry(strings, check, kind, where, params, extra) {
    const all = { ...sourceParams, ...params };
    const quote = where.quote ?? null;
    return {
      id: newId(check, idParts(where, extra)),
      check,
      file: where.file,
      line: where.line ?? null,
      endLine: where.endLine ?? where.line ?? null,
      quote,
      quoteSha: quote === null ? null : hash('sha256', quote),
      message: t(lang, `${strings}.${check}.message`, all),
      why: t(lang, `${strings}.${check}.why`, all),
      suggestion: { kind, detail: t(lang, `${strings}.${check}.detail`, all) },
      ...(extra.related ? { related: extra.related } : {}),
      ...(extra.data ? { data: extra.data } : {}),
    };
  }

  // A third-party skill is not the user's to edit: what is seen there stays, as a note.
  function noted(strings, check, where, params) {
    const file = byPath.get(where.file);
    if (!(file?.kind === 'skill' && file.thirdParty && SKILL_TEXT_CHECKS.includes(check))) return false;
    notes.push({
      check,
      file: where.file,
      line: where.line ?? null,
      message: t(lang, `${strings}.${check}.message`, { ...sourceParams, ...params }),
      thirdParty: file.thirdParty,
    });
    return true;
  }

  // The two ways out of a check. Which one a check takes is decided by the two lists at the top
  // of this file and nowhere else: a check found by wording cannot be given a severity here.
  function add(check, severity, kind, where, params = {}, extra = {}) {
    if (!CHECKS.includes(check)) throw new Error(`"${check}" is not a check that produces findings`);
    // The prompt of part 2 is told the severities of lib/catalogue.mjs; the program may use no other.
    const allowed = CATALOGUE[check]?.severity ?? [];
    if (!allowed.includes(severity)) {
      throw new Error(`"${check}" is reported as ${severity}, and lib/catalogue.mjs allows ${allowed.join(' or ') || 'none'}`);
    }
    if (noted('check', check, where, params)) return;
    const { id, check: name, ...rest } = entry('check', check, kind, where, params, extra);
    findings.push({ id, check: name, severity, ...rest });
  }

  function addCandidate(check, kind, where, params = {}, extra = {}) {
    if (!CANDIDATE_CHECKS.includes(check)) throw new Error(`"${check}" is not a check that produces candidates`);
    if (noted('candidate', check, where, params)) return;
    candidates.push({ ...entry('candidate', check, kind, where, params, extra), status: 'open' });
  }

  const at = (doc, line, endLine = line) => ({
    file: doc.file.path,
    line,
    endLine,
    quote: doc.lines.slice(line - 1, endLine).join('\n'),
  });
  const relatedLine = (doc, line) => ({ file: doc.file.path, line, quote: doc.lines[line - 1] });

  // --- what loads together ------------------------------------------------------------------
  // One group per place Claude Code can be started in: the user files alone, and each project.
  // A group holds the files that load at session start there, in loading order, each with the
  // role it loads in, and the files a claudeMdExcludes setting switches off for that place.

  const settingsIn = (project) =>
    scan.settings.filter((item) => item.kind !== 'mcp' && item.valid && (item.scope === 'user' || (project !== null && item.project === project)));

  function excludesIn(project) {
    const out = [];
    for (const item of settingsIn(project)) {
      for (const pattern of item.claudeMdExcludes ?? []) {
        if (pattern.length > MAX_GLOB_CHARS) continue;
        out.push({ pattern, setting: item.path, matches: globMatcher(pattern) });
      }
    }
    return out;
  }

  function makeGroup(key, project, name) {
    return { key, project, label: name, parts: [], excluded: [], seen: new Set(), excludes: excludesIn(project) };
  }

  function loadInto(group, file, role) {
    if (!file || group.seen.has(file.path) || isOversize(file)) return;
    group.seen.add(file.path);
    const hit = group.excludes.find((exclude) => exclude.matches(file.path));
    if (hit) {
      group.excluded.push({ file, pattern: hit.pattern, setting: hit.setting });
      return;
    }
    group.parts.push({ file, role });
    for (const item of file.imports) {
      if (item.exists && !item.tooDeep && !item.outside) loadInto(group, byPath.get(item.resolved), 'import');
    }
  }

  const inScope = (scope, project) => (file) => file.scope === scope && file.project === project;
  function loadScope(group, scope, project) {
    const own = scan.files.filter(inScope(scope, project));
    for (const file of own.filter((item) => item.kind === 'memory')) loadInto(group, file, 'memory');
    // Rule files without a paths pattern load at launch, like the memory file next to them.
    for (const file of own.filter((item) => item.kind === 'rule' && item.loads === 'launch')) loadInto(group, file, 'rule');
    for (const file of own.filter((item) => item.kind === 'memory-local')) loadInto(group, file, 'memory');
    // AGENTS.md stands in for a missing memory file. It is counted, and its lines are not checked.
    for (const file of own.filter((item) => item.kind === 'agents-md' && item.loads === 'launch')) loadInto(group, file, 'agents-md');
  }

  const groups = [makeGroup('user', null, t(lang, 'scope.user-only'))];
  loadScope(groups[0], 'user', null);
  // The memory files of subfolders that load on demand: those their project does not switch off.
  const onDemand = new Set();
  for (const project of projects) {
    // Two projects whose folders share a name are told apart by their label.
    const group = makeGroup(project.path, project.path, label(project.path));
    loadScope(group, 'user', null);
    // The memory files that stand above the project load there before its own. The scan says
    // which they are (memoryAbove), and says by the same list whether an AGENTS.md is read.
    for (const file of project.memoryAbove ?? []) loadInto(group, byPath.get(file), 'memory');
    loadScope(group, 'project', project.path);
    for (const file of scan.files.filter((item) => item.kind === 'memory-nested' && item.project === project.path && !group.seen.has(item.path))) {
      const hit = group.excludes.find((exclude) => exclude.matches(file.path));
      if (hit) group.excluded.push({ file, pattern: hit.pattern, setting: hit.setting });
      else onDemand.add(file.path);
    }
    groups.push(group);
  }
  for (const group of groups) {
    group.lines = group.parts.reduce((sum, part) => sum + loadedLines(part.file), 0);
    group.own = group.parts.filter((part) => part.file.project === group.project);
  }
  const isText = (part) => part.role !== 'agents-md';
  // The places in the order they are gone through: the user files, then every project before
  // the projects inside it, otherwise in the order of the scan. A file is gone through in the
  // first place that loads it, and two files are compared in the first place that loads both; a
  // later place adds only what it is the first to load, or the first to load together.
  const around = (group) => (group.project === null ? -1 : groups.filter((other) => other.project !== null && other.project !== group.project && isInside(group.project, other.project)).length);
  const places = [...groups].sort((a, b) => around(a) - around(b));
  const textFiles = (group) => group.parts.filter(isText).map((part) => part.file);
  const userLoaded = groups[0].parts.filter(isText).map((part) => part.file);

  // Every file whose lines are checked: what loads at launch somewhere, and the memory files that
  // load on demand. A file over the documented size limit is not loaded, so its lines are not
  // checked either; nor are those of a file that a setting switches off wherever it would load.
  const loadedSomewhere = new Set(groups.flatMap((group) => group.parts.map((part) => part.file.path)));
  const excludedSomewhere = new Set(groups.flatMap((group) => group.excluded.map((item) => item.file.path)));
  const switchedOff = (file) => excludedSomewhere.has(file.path) && !loadedSomewhere.has(file.path) && !onDemand.has(file.path);
  const checked = new Map();
  for (const file of scan.files) {
    if (!MEMORY_KINDS.includes(file.kind) || isOversize(file) || switchedOff(file)) continue;
    checked.set(file.path, file);
  }
  for (const group of groups) for (const part of group.parts.filter(isText)) checked.set(part.file.path, part.file);
  const docs = [...checked.values()].map(docFor);

  // --- length -------------------------------------------------------------------------------

  function largestSections(file) {
    const levels = [...new Set(file.sections.map((section) => section.level))].sort((a, b) => a - b);
    const level = levels.find((candidate) => file.sections.filter((section) => section.level === candidate).length >= 2);
    const pool = level === undefined ? file.sections : file.sections.filter((section) => section.level === level);
    return [...pool].sort((a, b) => b.lines - a.lines).slice(0, 3);
  }
  const sectionList = (sections) =>
    sections.map((section) => t(lang, 'list.section', { heading: section.heading, lines: section.lines })).join(', ');

  const fileLimit = LIMITS.memoryFileLines.value;
  for (const file of scan.files.filter((item) => MEMORY_KINDS.includes(item.kind) && item.kind !== 'import' && !switchedOff(item))) {
    if (isOversize(file)) {
      add('memory-too-large', 'high', 'shorten', { file: file.path }, { bytes: file.bytes, limit: LIMITS.memoryFileBytes.value });
      continue;
    }
    if (file.lines <= fileLimit) continue;
    const largest = largestSections(file);
    const where = largest.length ? at(docFor(file), largest[0].line) : { file: file.path };
    add(
      'memory-too-long',
      file.lines >= 2 * fileLimit ? 'high' : 'medium',
      'shorten',
      where,
      { lines: file.lines, limit: fileLimit, sections: sectionList(largest) || '-' },
      { key: 'length' },
    );
  }

  // This finding is about a sum, so it points at a file and at no line.
  const userOver = groups[0].lines > totalLimit;
  for (const group of groups) {
    if (group.lines <= totalLimit || group.own.length === 0) continue;
    if (group.project !== null && userOver) continue;
    const contributors = [...group.parts]
      .sort((a, b) => loadedLines(b.file) - loadedLines(a.file))
      .slice(0, 3)
      .map((part) => t(lang, 'list.file', { file: label(part.file.path), lines: loadedLines(part.file) }))
      .join(', ');
    add(
      'always-loaded-total',
      'medium',
      'make-rule-file',
      { file: group.own[0].file.path },
      { lines: group.lines, group: group.label, limit: totalLimit, fileLimit, files: contributors },
      { key: `total ${group.key === 'user' ? 'user' : label(group.key)}` },
    );
  }

  // --- duplicates ---------------------------------------------------------------------------

  const countsAsInstruction = (item) => item.norm.split(' ').length >= MIN_DUPLICATE_WORDS && item.norm.length >= 12;

  for (const doc of docs) {
    const first = new Map();
    for (const item of doc.instructions.filter(countsAsInstruction)) {
      if (!first.has(item.norm)) {
        first.set(item.norm, item.line);
        continue;
      }
      add('duplicate-within', 'low', 'delete-duplicate', at(doc, item.line), { otherLine: first.get(item.norm) }, {
        related: [relatedLine(doc, first.get(item.norm))],
      });
    }
  }

  const userNorms = new Map();
  for (const file of userLoaded) {
    const doc = docFor(file);
    for (const item of doc.instructions.filter(countsAsInstruction)) {
      if (!userNorms.has(item.norm)) userNorms.set(item.norm, { doc, line: item.line });
    }
  }
  const reported = new Set();
  const projectNorms = new Map();
  // The user files hold the originals, so none of them is ever the copy.
  const goneThrough = new Set(userLoaded.map((file) => file.path));
  for (const group of places.filter((item) => item.project !== null)) {
    const loadedHere = new Set(group.parts.map((part) => part.file.path));
    const added = textFiles(group).filter((item) => !goneThrough.has(item.path));
    for (const item of textFiles(group)) goneThrough.add(item.path);
    for (const file of added) {
      const doc = docFor(file);
      for (const item of doc.instructions.filter(countsAsInstruction)) {
        // A user file that this project excludes does not load together with the project file.
        const found = userNorms.get(item.norm);
        const original = found && loadedHere.has(found.doc.file.path) ? found : undefined;
        const spot = `${file.path}:${item.line}`;
        if (original && !reported.has(spot)) {
          reported.add(spot);
          add(
            'duplicate-across',
            'low',
            'delete-duplicate',
            at(doc, item.line),
            { otherFile: label(original.doc.file.path), otherLine: original.line },
            { related: [relatedLine(original.doc, original.line)] },
          );
        }
        if (!original) {
          const places = projectNorms.get(item.norm) ?? [];
          if (!places.some((place) => place.project === group.project)) {
            places.push({ project: group.project, doc, line: item.line });
          }
          projectNorms.set(item.norm, places);
        }
      }
    }
  }
  for (const places of projectNorms.values()) {
    if (places.length < 2) continue;
    const [first, ...others] = places;
    add(
      'same-line-in-projects',
      'low',
      'move-to-user',
      at(first.doc, first.line),
      { count: places.length, others: others.map((place) => `${label(place.doc.file.path)}:${place.line}`).join(', ') },
      { related: others.map((place) => relatedLine(place.doc, place.line)) },
    );
  }

  // --- conflict candidates ------------------------------------------------------------------
  // Two lines that load together, one asking and one forbidding, with two terms in common. That is
  // word matching and nothing more, so each pair is a candidate. Lines of one section are written
  // together and refine each other; they are not paired.
  //
  // Every listed pair has to be read, and their number grows with the square of the lines. So
  // the list is bounded: a line is part of at most a few pairs, a place lists at most so many
  // (both are defaults of this tool, in lib/facts.mjs). A pair over the bound is counted, not
  // listed, and the count is said wherever the pairs are.
  //
  // The bound decides which pairs wait for a reader. It never decides whether a pair that has
  // been read is still there: a pair with a verdict is listed whenever its two lines still
  // oppose each other. Otherwise a change that adds an opposing line elsewhere would push a
  // confirmed contradiction off the list, and it would pass for resolved while both of its lines
  // still stand. So each place lists the pairs that were read first, and the room that is left
  // goes to the pairs that wait.
  //
  // options.read holds the pairs that were read, as an earlier run listed them ({ id, file,
  // quote, related }); a confirmed entry of options.judgement names its pair the same way. Their
  // lines are looked up first, so the id of a pair is worked out for those few lines only.

  const readIds = new Set();
  const readLines = new Set();
  for (const item of [...(options.read ?? []), ...(options.judgement ?? [])]) {
    const id = item?.id ?? item?.candidate;
    if (typeof id !== 'string' || !Array.isArray(item.related)) continue;
    readIds.add(id);
    for (const line of [item, ...item.related]) readLines.add(`${absolute(String(line?.file ?? ''))}\n${line?.quote}`);
  }
  const pairsPerLine = LIMITS.conflictPairsPerLine.value;
  const pairsPerPlace = LIMITS.conflictPairsPerPlace.value;
  const pairsOfLine = new Map();
  let pairsLeftOut = 0;
  // The terms two lines share when one asks for what the other forbids, or null.
  const opposed = (asks, forbids) => {
    for (const positive of asks.pos) {
      for (const negative of forbids.neg) {
        const shared = [...positive].filter((term) => negative.has(term));
        if (shared.length >= 2) return shared;
      }
    }
    return null;
  };
  const rank = (entryOf) => [entryOf.doc.file.scope === 'project' ? 1 : 0, label(entryOf.doc.file.path), entryOf.line];
  // For every file, the places gone through so far that load it.
  const loadedIn = new Map();
  const comparedBefore = (a, b) => {
    const [first, second] = [loadedIn.get(a) ?? [], loadedIn.get(b) ?? []];
    return first.some((place) => second.includes(place));
  };
  // The terms that make two lines a pair, or null: lines of one section are not paired, and two
  // lines whose files load together in a place gone through before were compared there.
  const pairOf = (first, second) => {
    if (first.doc === second.doc && first.doc.sections[first.line - 1] === second.doc.sections[second.line - 1]) return null;
    const shared = opposed(first, second) ?? opposed(second, first);
    return shared && !comparedBefore(first.doc.file.path, second.doc.file.path) ? shared : null;
  };
  // A pair as it is listed: which of its lines the candidate sits at, and what names it.
  const listing = (first, second, shared) => {
    const [other, primary] = [first, second].sort((x, y) => {
      const [rx, ry] = [rank(x), rank(y)];
      return rx[0] - ry[0] || (rx[1] < ry[1] ? -1 : rx[1] > ry[1] ? 1 : 0) || rx[2] - ry[2];
    });
    return {
      where: at(primary.doc, primary.line),
      params: { otherFile: label(other.doc.file.path), otherLine: other.line, terms: shared.join(', ') },
      extra: {
        key: `${primary.doc.lines[primary.line - 1]} | ${label(other.doc.file.path)} | ${other.doc.lines[other.line - 1]}`,
        related: [relatedLine(other.doc, other.line)],
      },
    };
  };
  for (const [place, group] of places.entries()) {
    // One entry per line that asks or forbids, with the terms of each of its clauses.
    const entries = [];
    for (const file of textFiles(group)) {
      const doc = docFor(file);
      for (const item of doc.instructions) {
        const entryOf = { doc, line: item.line, key: `${file.path}:${item.line}`, text: `${file.path}\n${doc.lines[item.line - 1]}`, pos: [], neg: [] };
        for (const clause of clausesOf(item.text)) {
          const polarity = polarityOf(clause);
          if (polarity) entryOf[polarity].push(termsOf(clause));
        }
        if (entryOf.pos.length || entryOf.neg.length) entries.push(entryOf);
      }
    }
    let listed = 0;
    const take = (first, second, pair) => {
      listed += 1;
      for (const entryOf of [first, second]) pairsOfLine.set(entryOf.key, (pairsOfLine.get(entryOf.key) ?? 0) + 1);
      addCandidate('conflict-candidate', 'review-conflict', pair.where, pair.params, pair.extra);
    };
    // The pairs that were read, whatever the bound says.
    const taken = new Set();
    const known = entries.filter((entryOf) => readLines.has(entryOf.text));
    for (let a = 0; a < known.length; a += 1) {
      for (let b = a + 1; b < known.length; b += 1) {
        const shared = pairOf(known[a], known[b]);
        if (!shared) continue;
        const pair = listing(known[a], known[b], shared);
        if (!readIds.has(nextId('conflict-candidate', idParts(pair.where, pair.extra)))) continue;
        taken.add(`${known[a].key}\n${known[b].key}`);
        take(known[a], known[b], pair);
      }
    }
    // The pairs that wait for a reader, as far as the bound has room.
    for (let a = 0; a < entries.length; a += 1) {
      for (let b = a + 1; b < entries.length; b += 1) {
        const [first, second] = [entries[a], entries[b]];
        const shared = pairOf(first, second);
        if (!shared || (taken.size && taken.has(`${first.key}\n${second.key}`))) continue;
        if (listed >= pairsPerPlace || [first, second].some((entryOf) => (pairsOfLine.get(entryOf.key) ?? 0) >= pairsPerLine)) {
          pairsLeftOut += 1;
          continue;
        }
        take(first, second, listing(first, second, shared));
      }
    }
    for (const item of textFiles(group)) loadedIn.set(item.path, [...(loadedIn.get(item.path) ?? []), place]);
  }

  // --- line shapes --------------------------------------------------------------------------

  // The permission rules of a settings file. A rule can hold a credential, and no pattern
  // recognises every one, so the scan keeps none of their text: the file is read here when a
  // line asks whether a command is covered, and what was read is never part of the result.
  const rulesRead = new Map();
  function rulesOf(item) {
    if (!rulesRead.has(item.path)) {
      let json;
      try {
        json = JSON.parse(readFileSync(item.path, 'utf8'));
      } catch (error) {
        throw new Error(`Cannot read ${item.path}, which the scan lists as valid settings (${error.code ?? 'not valid JSON'}). Run scan.mjs again.`);
      }
      const lists = isObject(json) && isObject(json.permissions) ? json.permissions : {};
      const rules = (list) => (Array.isArray(lists[list]) ? lists[list].filter((rule) => typeof rule === 'string') : []);
      rulesRead.set(item.path, { ask: rules('ask'), deny: rules('deny') });
    }
    return rulesRead.get(item.path);
  }

  // A restriction that a rule already enforces is no longer "in prose only". Only the settings
  // that apply to the file count: the user settings everywhere, a project's settings in that
  // project. A deny rule also settles a line that only wants to be asked first.
  const enforced = (file, { command, list }) =>
    scan.settings
      .filter((item) => item.permissions && item.permissions.ask + item.permissions.deny > 0 && (item.scope === 'user' || item.project === file.project))
      .flatMap((item) => (list === 'ask' ? [...rulesOf(item).ask, ...rulesOf(item).deny] : rulesOf(item).deny))
      .some((rule) => ruleCoversCommand(rule, command));

  // Everything in this section is found by the wording of a line, so everything in it is a
  // candidate: a reader says whether the line is what its words suggest.
  for (const doc of docs) {
    doc.instructions.forEach((item, position) => {
      // Only a line written as an instruction is asked about: "the export covers all customers
      // except in one region" describes software. The word lists that decide this are short of
      // certain (an English verb is often a noun too), which is why the result is a candidate.
      const marker = matchException(item.text);
      if (marker) {
        const previous = doc.instructions[position - 1];
        const opensWithMarker = stripListMarker(item.text).trim().toLowerCase().startsWith(marker);
        if (opensWithMarker) {
          // "- Unless the file is a lockfile." has no rule of its own; it limits the line before it.
          if (previous && isInstruction(previous.text)) addCandidate('exception', 'review-exception', at(doc, previous.line, item.line), { marker });
        } else if (isInstruction(item.text)) {
          addCandidate('exception', 'review-exception', at(doc, item.line), { marker });
        }
      }
      if (matchRepeatedRequest(item.text)) {
        addCandidate('repeated-request', 'make-command', at(doc, item.line));
      } else {
        // Whether a line is hook material is for a reader to judge; the command it quotes, if any, is kept.
        const automation = matchAutomation(item.text);
        if (automation) {
          const data = automation.command ? { command: automation.command } : undefined;
          addCandidate('automation-in-memory', 'make-hook', at(doc, item.line), {}, { data });
        }
      }
      const permission = matchPermission(item.text);
      if (permission && !enforced(doc.file, permission)) {
        // The rule is kept on the candidate: once a reader confirms the line, a card can add it.
        const what = t(lang, `permission.${permission.list}`);
        const rule = permissionRule(permission.command);
        addCandidate('permission-in-prose', 'make-setting', at(doc, item.line), { ...permission, what, rule }, { data: { ...permission, rule } });
      }
    });
    // A numbered list is how steps are written, and also rankings, options and principles. Whether
    // its items open with a verb does not tell them apart ("1. Think before coding.").
    for (const block of findProcedures(doc.lines, doc.mask)) {
      addCandidate('procedure-in-memory', 'make-skill', at(doc, block.start + 1, block.end + 1), { steps: block.steps });
    }
    for (const item of doc.file.imports) {
      if (item.exists === false) {
        add('import-unresolved', 'medium', 'shorten', at(doc, item.line), { raw: item.raw, resolved: label(item.resolved) }, {
          key: `unresolved ${item.raw}`,
        });
      } else if (item.tooDeep) {
        add(
          'import-too-deep',
          'medium',
          'shorten',
          at(doc, item.line),
          { raw: item.raw, hop: item.hop, limit: LIMITS.importHops.value },
          { key: `deep ${item.raw}` },
        );
      }
    }
  }

  // --- project-specific lines in the user file ----------------------------------------------

  const stackOwners = new Map();
  for (const project of projects) {
    for (const marker of project.markers ?? []) {
      for (const keyword of STACK_MARKERS[marker] ?? []) {
        if (!stackOwners.has(keyword)) stackOwners.set(keyword, new Set());
        stackOwners.get(keyword).add(project);
      }
    }
  }
  const pathTokens = (line) =>
    [...[...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]), ...line.split(/\s+/)]
      .map((token) => token.replace(/^[`"'(]+|[`"').,;:]+$/g, ''))
      .filter((token) => /^[\w.-]+(\/[\w.-]+)+\/?$/.test(token) && !token.includes('..'));

  for (const file of userLoaded) {
    const doc = docFor(file);
    for (const item of doc.instructions) {
      const named = projects.filter((project) => project.name.length >= 4 && wholeWord(project.name).test(item.text));
      let hit = named.length === 1 ? { project: named[0], reason: 'name', term: named[0].name } : null;
      if (!hit && projects.length >= 2) {
        for (const token of pathTokens(item.text)) {
          const owners = projects.filter((project) => existsSync(path.join(project.path, token)));
          if (owners.length === 1) {
            hit = { project: owners[0], reason: 'path', term: token };
            break;
          }
        }
        for (const [keyword, owners] of stackOwners) {
          if (hit) break;
          if (owners.size === 1 && wholeWord(keyword).test(item.text)) {
            hit = { project: [...owners][0], reason: 'stack', term: keyword };
          }
        }
      }
      if (!hit) continue;
      // A common word that is also a folder name, or a tool that one of the scanned projects
      // happens to have, does not make a line about that project: a reader decides.
      addCandidate(
        'project-specific-in-user',
        'move-to-project',
        at(doc, item.line),
        { project: label(hit.project.path), reason: t(lang, `reason.${hit.reason}`, { term: hit.term }) },
        { data: { project: hit.project.name, projectPath: hit.project.path, reason: hit.reason, term: hit.term } },
      );
    }
  }

  // --- skills, commands, agents -------------------------------------------------------------

  function frontMatterLine(file, field) {
    const lines = linesOf(file);
    const index = lines.findIndex((line, position) => position > 0 && line.startsWith(`${field}:`));
    return index === -1 ? { file: file.path } : { file: file.path, line: index + 1, endLine: index + 1, quote: lines[index] };
  }

  const userSkills = new Map(
    scan.files.filter((file) => file.kind === 'skill' && file.scope === 'user').map((file) => [file.name, file]),
  );
  for (const file of scan.files.filter((item) => ['skill', 'command', 'agent', 'rule'].includes(item.kind))) {
    const matter = file.frontMatter;
    if (matter.present && !matter.valid) {
      add('front-matter-unreadable', 'low', 'fix-front-matter', { file: file.path }, {}, { data: { error: matter.error } });
      continue;
    }
    const description = text(matter.data.description);
    if (file.kind === 'command' && !description) {
      add('command-no-description', 'low', 'fix-front-matter', { file: file.path });
    }
    if (file.kind === 'agent' && !description) {
      add('agent-no-description', 'low', 'fix-front-matter', { file: file.path });
    }
    if (file.kind !== 'skill') continue;

    const whenToUse = text(matter.data.when_to_use);
    if (!description) {
      add('skill-no-description', 'medium', 'fix-front-matter', { file: file.path });
    } else if (!whenToUse && !matchesAny(SKILL_CUE, description) && matter.data['disable-model-invocation'] !== true) {
      // A description can say when in other words than "use when", so this is asked, not stated.
      // A skill the model never picks needs no such sentence. No line to quote, no candidate.
      const where = frontMatterLine(file, 'description');
      if (where.quote !== undefined) addCandidate('skill-no-when-cue', 'fix-front-matter', where, {}, { key: 'cue', data: { description } });
    }
    const name = text(matter.data.name);
    if (name && name !== file.name) {
      add('skill-name-mismatch', 'low', 'fix-front-matter', frontMatterLine(file, 'name'), { name, folder: file.name }, {
        key: 'name',
      });
    }
    if (file.lines > LIMITS.skillLines.value) {
      add('skill-too-long', 'medium', 'shorten', { file: file.path }, { lines: file.lines, limit: LIMITS.skillLines.value });
    }
    const chars = description.length + whenToUse.length;
    if (chars > LIMITS.skillDescriptionChars.value) {
      add(
        'skill-description-too-long',
        'medium',
        'fix-front-matter',
        frontMatterLine(file, 'description'),
        { chars, limit: LIMITS.skillDescriptionChars.value },
        { key: 'description length' },
      );
    }
    if (matter.data['disable-model-invocation'] === true && matter.data['user-invocable'] === false) {
      add('skill-unreachable', 'medium', 'fix-front-matter', frontMatterLine(file, 'disable-model-invocation'), {}, {
        key: 'unreachable',
      });
    }
    // The same skill in the user folder and in a project is one text kept twice. Copies that are
    // still equal are listed with the skills; only copies that have drifted apart are a finding.
    const twin = file.scope === 'project' ? userSkills.get(file.name) : null;
    if (twin && twin.contentSha !== file.contentSha) {
      add('skill-copies-differ', 'low', 'delete-duplicate', { file: file.path }, { name: file.name, otherFile: label(twin.path) }, {
        related: [{ file: twin.path, line: null, quote: null }],
      });
    }
  }

  // --- settings and hooks -------------------------------------------------------------------

  // A broken hook is repaired in the settings file by hand, so these two findings are
  // "change settings", not "turn a line into a hook".
  const knownEvents = new Set(HOOK_EVENTS);

  for (const item of scan.settings) {
    if (!item.valid) {
      add('settings-invalid-json', 'high', 'make-setting', { file: item.path }, {}, { data: { error: item.error } });
      continue;
    }
    if (item.kind === 'mcp') continue;
    // The list is the one of the hooks guide on the day it was read. A newer Claude Code may know
    // more events, so a name outside it is "not in the list this tool knows", never "wrong".
    for (const event of item.hookEvents.filter((name) => !knownEvents.has(name))) {
      add('hook-unknown-event', 'low', 'make-setting', { file: item.path }, { event, count: HOOK_EVENTS.length }, { key: event, data: { event } });
    }
    for (const hook of item.hooks.filter((entryOf) => entryOf.command)) {
      // The scanner names the script words of the command (lib/hooks.mjs); arguments, addresses
      // and options are never taken for the script.
      for (const token of hook.scripts ?? []) {
        if (token.includes(MASK) || /[*?]/.test(token)) continue;
        const script = resolveHookScript(token, { home, project: item.project });
        if (script === null || existsSync(script)) continue;
        add(
          'hook-missing-file',
          'medium',
          'make-setting',
          { file: item.path, quote: hook.command },
          { event: hook.event, file: label(script) },
          { key: `${hook.event} ${token}`, data: { event: hook.event, file: script } },
        );
      }
    }
  }

  // --- to review: MCP servers of a project that no permission rule names ----------------------
  // Not a finding and not a suggestion. Only the server names of the project's .mcp.json are
  // known; the user-level file that can also configure servers is never read.

  for (const item of scan.settings.filter((entryOf) => entryOf.kind === 'mcp' && entryOf.valid && entryOf.servers.length)) {
    // Of the permission rules the scan keeps those that name an MCP server, from all three lists.
    const rules = settingsIn(item.project).flatMap((settings) => settings.permissions.mcp);
    const servers = item.servers.filter((server) => !rules.some((rule) => ruleNamesServer(rule, server)));
    if (servers.length === 0) continue;
    const params = { ...sourceParams, servers: servers.join(', '), count: servers.length, project: label(item.project) };
    review.push({
      id: newId('mcp-no-permission-rule', [label(item.path), servers.join(' ')]),
      check: 'mcp-no-permission-rule',
      file: item.path,
      project: item.project,
      servers,
      message: t(lang, 'review.mcp-no-permission-rule.message', params),
      why: t(lang, 'review.mcp-no-permission-rule.why', params),
    });
  }

  // --- the context tax ----------------------------------------------------------------------
  // What is in context before the first word, per place: the files that load at launch, the
  // auto memory index, and the listing of skills and commands. Tokens are bytes divided by a
  // tool default (LIMITS.bytesPerToken), an estimate. Descriptions of agents are not counted.

  const cap = LIMITS.skillDescriptionChars.value;
  function listingOf(kind, project) {
    let bytes = 0;
    let count = 0;
    let hidden = 0;
    for (const file of scan.files.filter((item) => item.kind === kind && (item.scope === 'user' || item.project === project))) {
      const data = file.frontMatter?.data ?? {};
      // A skill that only the user can invoke is not offered to the model, so it is not listed.
      if (data['disable-model-invocation'] === true) {
        hidden += 1;
        continue;
      }
      const name = kind === 'skill' ? file.name : path.basename(file.path, path.extname(file.path));
      const described = [text(data.description), text(data.when_to_use)].filter(Boolean).join(' ').slice(0, cap);
      bytes += Buffer.byteLength(`${name} ${described}`.trim());
      count += 1;
    }
    return { bytes, count, hidden };
  }

  const contextTax = groups.map((group) => {
    const parts = group.parts.map((part) => ({
      type: part.role,
      path: part.file.path,
      label: label(part.file.path),
      bytes: loadedBytes(part.file),
      tokens: tokensOf(loadedBytes(part.file)),
    }));
    const index = group.project === null ? null : ((scan.autoMemory ?? []).find((item) => item.project === group.project) ?? null);
    const autoMemory = index === null ? null : { path: index.path, found: index.found, bytes: index.bytes, counted: 0 };
    if (autoMemory?.found) {
      // Only the size is known. The first 200 lines or 25 KB load; the size cap is what can be applied.
      autoMemory.counted = Math.min(autoMemory.bytes, LIMITS.autoMemoryBytes.value);
      parts.push({ type: 'auto-memory', path: autoMemory.path, label: label(autoMemory.path), bytes: autoMemory.counted, tokens: tokensOf(autoMemory.counted) });
    }
    for (const [type, kind] of [
      ['skill-listing', 'skill'],
      ['command-listing', 'command'],
    ]) {
      const listing = listingOf(kind, group.project);
      if (listing.count > 0) parts.push({ type, count: listing.count, hidden: listing.hidden, bytes: listing.bytes, tokens: tokensOf(listing.bytes) });
    }
    return {
      key: group.key,
      project: group.project,
      label: group.label,
      tokens: parts.reduce((sum, part) => sum + part.tokens, 0),
      bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
      parts,
      autoMemory,
      notCounted: ['agent-descriptions'],
    };
  });

  // --- judgement: what a reader made of the candidates, and findings of its own ----------------
  // These come from a reader, not from a rule, so the one thing a program can hold them to is
  // enforced here: every quote must be the exact text of the lines it points at.

  function exactQuote(name, item) {
    const file = byPath.get(absolute(String(item.file ?? '')));
    if (!file) throw new Error(`${name}: ${item.file} is not a file the scan lists`);
    const lines = linesOf(file);
    const [line, endLine] = [item.line, item.endLine ?? item.line];
    const inRange = Number.isInteger(line) && Number.isInteger(endLine) && line >= 1 && endLine >= line && endLine <= lines.length;
    const actual = inRange ? lines.slice(line - 1, endLine).join('\n') : null;
    if (actual === null || item.quote !== actual) {
      throw new Error(
        `${name}: the quote is not the exact text of ${file.path}:${line}${endLine === line ? '' : `-${endLine}`}. ` +
          'Read the lines again; no quote, no finding.',
      );
    }
    return { file, line, endLine, quote: actual };
  }

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  (options.judgement ?? []).forEach((item, index) => {
    const name = `Judgement finding ${index + 1}`;
    if (!isObject(item)) throw new Error(`${name}: must be an object`);
    let candidate = null;
    if (item.candidate !== undefined) {
      candidate = candidateById.get(item.candidate);
      if (!candidate) throw new Error(`${name}: "${item.candidate}" is not the id of a candidate of this run`);
      if (candidate.status !== 'open') throw new Error(`${name}: the candidate ${item.candidate} is judged twice`);
    }
    if (item.dismissed === true) {
      if (!candidate) throw new Error(`${name}: a dismissal names the candidate it dismisses ("candidate": "<id>")`);
      if (text(item.reason) === '') throw new Error(`${name}: a dismissed candidate needs a one-line reason`);
      candidate.status = 'dismissed';
      candidate.reason = text(item.reason);
      return;
    }
    // The file is looked up before the other fields, so a wrong path is named as what it is.
    if (!byPath.get(absolute(String(item.file ?? '')))) throw new Error(`${name}: ${item.file} is not a file the scan lists`);
    if (!SEVERITIES.includes(item.severity)) throw new Error(`${name}: severity must be one of ${SEVERITIES.join(', ')}`);
    if (!SUGGESTION_KINDS.includes(item.kind)) {
      throw new Error(`${name}: Unknown kind "${item.kind}"; use one of: ${SUGGESTION_KINDS.join(', ')}`);
    }
    for (const field of ['title', 'message', 'why', 'detail']) {
      if (typeof item[field] !== 'string' || item[field].trim() === '') throw new Error(`${name}: ${field} is missing`);
    }
    const own = exactQuote(name, item);
    if (item.related !== undefined && !Array.isArray(item.related)) throw new Error(`${name}: related must be a list of quoted lines`);
    // A finding that names a second line (the other half of a conflict) quotes that one too.
    const related = (item.related ?? []).map((other) => {
      const found = exactQuote(name, other);
      return { file: found.file.path, line: found.line, endLine: found.endLine, quote: found.quote };
    });
    const id = newId('judgement', [label(own.file.path), item.title, own.quote]);
    findings.push({
      id,
      check: 'judgement',
      title: item.title,
      severity: item.severity,
      file: own.file.path,
      line: own.line,
      endLine: own.endLine,
      quote: own.quote,
      quoteSha: hash('sha256', own.quote),
      message: item.message,
      why: item.why,
      suggestion: { kind: item.kind, detail: item.detail },
      ...(related.length ? { related } : {}),
      // A confirmed candidate keeps the check that found it and what that check knew (the rule a
      // prohibition would become, the project a line may belong to), so its card can be made.
      ...(candidate ? { candidate: candidate.id, origin: candidate.check, ...(candidate.data ? { data: candidate.data } : {}) } : {}),
    });
    if (candidate) {
      candidate.status = 'confirmed';
      candidate.finding = id;
    }
  });

  // --- result -------------------------------------------------------------------------------

  const byPlace = (a, b) => {
    const [la, lb] = [label(a.file), label(b.file)];
    return (la < lb ? -1 : la > lb ? 1 : 0) || (a.line ?? 0) - (b.line ?? 0);
  };
  findings.sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || byPlace(a, b) || CHECKS.indexOf(a.check) - CHECKS.indexOf(b.check),
  );
  candidates.sort((a, b) => CANDIDATE_CHECKS.indexOf(a.check) - CANDIDATE_CHECKS.indexOf(b.check) || byPlace(a, b));
  notes.sort(byPlace);

  const count = (kind) => scan.files.filter((file) => file.kind === kind).length;
  const memoryFiles = scan.files.filter((file) => MEMORY_KINDS.includes(file.kind));
  const limitFor = (file) =>
    file.kind === 'skill' ? LIMITS.skillLines.value : MEMORY_KINDS.includes(file.kind) && file.kind !== 'import' ? fileLimit : null;
  const withStatus = (status) => candidates.filter((candidate) => candidate.status === status).length;
  const pairs = candidates.filter((candidate) => candidate.check === 'conflict-candidate');

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    scannedAt: scan.scannedAt,
    lang,
    home,
    factsCheckedOn: FACTS.checkedOn,
    limits: { ...LIMITS, alwaysLoadedLines: { ...LIMITS.alwaysLoadedLines, value: totalLimit } },
    files: scan.files.map((file) => ({
      path: file.path,
      label: label(file.path),
      kind: file.kind,
      scope: file.scope,
      project: file.project,
      lines: file.lines,
      bytes: file.bytes,
      approxTokens: file.approxTokens,
      limit: limitFor(file),
      largestSections: MEMORY_KINDS.includes(file.kind) ? largestSections(file).map(({ heading, lines }) => ({ heading, lines })) : [],
    })),
    alwaysLoaded: groups.map((group) => ({
      project: group.project,
      label: group.label,
      lines: group.lines,
      limit: totalLimit,
      files: group.parts.map((part) => ({
        path: part.file.path,
        label: label(part.file.path),
        lines: loadedLines(part.file),
        role: part.role,
        project: part.file.project,
      })),
      excluded: group.excluded.map((item) => ({
        path: item.file.path,
        label: label(item.file.path),
        lines: loadedLines(item.file),
        pattern: item.pattern,
        setting: item.setting,
      })),
    })),
    contextTax,
    findings,
    candidates,
    review,
    notes,
    metrics: {
      // How many different checks were run: findings, candidates and review items together.
      checks: new Set([...CHECKS, ...CANDIDATE_CHECKS, ...REVIEW_CHECKS]).size,
      files: scan.files.length,
      memoryFiles: memoryFiles.length,
      totalLines: memoryFiles.reduce((sum, file) => sum + file.lines, 0),
      alwaysLoadedLines: Object.fromEntries(groups.map((group) => [group.key, group.lines])),
      contextTokens: Object.fromEntries(contextTax.map((place) => [place.key, place.tokens])),
      skills: count('skill'),
      commands: count('command'),
      agents: count('agent'),
      rules: count('rule'),
      hooks: scan.settings.reduce((sum, item) => sum + (item.hooks?.length ?? 0), 0),
      findings: {
        high: findings.filter((finding) => finding.severity === 'high').length,
        medium: findings.filter((finding) => finding.severity === 'medium').length,
        low: findings.filter((finding) => finding.severity === 'low').length,
      },
      suggestions: findings.length,
      candidates: { total: candidates.length, open: withStatus('open'), confirmed: withStatus('confirmed'), dismissed: withStatus('dismissed') },
      // Pairs listed for reading, how many of them a reader has compared and confirmed, and how
      // many more share words but are over the bound of the list (LIMITS.conflictPairsPerLine,
      // LIMITS.conflictPairsPerPlace).
      conflictPairs: {
        found: pairs.length,
        compared: pairs.filter((candidate) => candidate.status !== 'open').length,
        confirmed: pairs.filter((candidate) => candidate.status === 'confirmed').length,
        leftOut: pairsLeftOut,
      },
      review: review.length,
      notes: notes.length,
    },
  };
}

runCli(import.meta.url, (argv) => {
  const args = parseArgs(argv, {
    scan: 'string',
    lang: 'string',
    'total-lines': 'number',
    judgement: 'string',
    out: 'string',
  });
  const scan = readJsonFile(requireOption(args, 'scan'), 'scan');
  const judgement = args.judgement ? readJsonFile(args.judgement, 'judgement') : [];
  if (!Array.isArray(judgement)) throw new Error('The judgement file must hold a JSON array');
  const result = runChecks(scan, { lang: args.lang, totalLines: args['total-lines'], judgement });
  return deliver(
    result,
    args.out,
    { findings: result.findings.length, candidates: result.candidates.length, review: result.review.length, metrics: result.metrics },
    scan.home,
  );
});
