#!/usr/bin/env node
// claude-health check: the half of the health check that needs no model.
//
// Banner, language, scope, scan, checks, the four panels of the report, report 1, and how to
// continue. It changes nothing in the setup: it does not import the module that writes. It
// starts no process and opens nothing: after the report it prints the link to report 1, the
// folder of this tool and the two lines that continue in Claude Code.
//
// Everything is printed once, one block under the other. A question is a numbered list answered
// by a number and Enter. The cursor is never moved and no single key is read, so no window is
// too small for it and nothing on screen has to be found again.
//
// What it knows about where it runs (a terminal or not, colour, Unicode, inside a Claude Code
// session or not) it asks of lib/surroundings.mjs. It reads no variable of the environment and
// no property of a stream itself.
//
// Right after the language it says what the tool changes and what it never changes
// (lib/promise.mjs): the same two lists the session shows and the README prints.
//
// Every question has a flag, so a run needs no keyboard:
//   claude-health check --lang en --projects <dir>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, parseArgs } from '../.claude/skills/claude-health/scripts/lib/cli.mjs';
import { absolute, displayPath, expandHome, toPosix } from '../.claude/skills/claude-health/scripts/lib/paths.mjs';
import { VERSION, nestedLeftOut, projectsIn, resolveHome, runInfo, scanAgain, scanSetup, startRun } from '../.claude/skills/claude-health/scripts/lib/pipeline.mjs';
import { createReader, readLine, selectNumbered } from '../.claude/skills/claude-health/scripts/lib/prompt.mjs';
import * as render from '../.claude/skills/claude-health/scripts/lib/render.mjs';
import { LANGS } from '../.claude/skills/claude-health/scripts/lib/strings.mjs';
import { localeLanguage, surroundings } from '../.claude/skills/claude-health/scripts/lib/surroundings.mjs';
import { canonical } from '../.claude/skills/claude-health/scripts/lib/targets.mjs';
import { visible } from '../.claude/skills/claude-health/scripts/lib/term.mjs';
import { DEFAULT_CAPS, isProject } from '../.claude/skills/claude-health/scripts/scan.mjs';
import { tokensCommand } from '../.claude/skills/claude-health/scripts/tokens.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every question has a flag here, so a run needs no keyboard.
export const OPTIONS = {
  lang: 'string',
  'user-only': 'boolean',
  projects: 'list',
  machine: 'boolean',
  nested: 'boolean',
  plain: 'boolean',
  ascii: 'boolean',
  color: 'boolean',
  home: 'string',
  'max-files': 'number',
  'max-dirs': 'number',
  'max-depth': 'number',
  help: 'boolean',
  version: 'boolean',
};

const defaultIo = () => ({ input: process.stdin, output: process.stdout, error: process.stderr, env: process.env, cwd: process.cwd(), platform: process.platform, home: null, locale: null });

// Returns the exit code. io carries the streams and the environment, so a test can stand in for both.
export async function main(argv, io = defaultIo()) {
  const { output } = io;
  const guess = localeLanguage(io.env, io.locale);
  const fail = (code, lines) => {
    io.error.write(`${lines.map((line) => visible(line)).join('\n')}\n`);
    return code;
  };
  const wording = (lang) => render.text({ lang, unicode: false });

  // The tokens of the person's own sessions: a report of its own, with options of its own.
  if (argv[0] === 'tokens') {
    try {
      output.write(tokensCommand(argv.slice(1), { cwd: io.cwd, home: resolveHome(io.home), lang: guess }));
      return 0;
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      return fail(2, [error.message]);
    }
  }

  let args;
  try {
    args = parseArgs(argv, OPTIONS);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return fail(2, [error.message, wording(guess)('ui.error.usage')]);
  }
  if (args.lang !== undefined && !LANGS.includes(args.lang)) return fail(2, [wording(guess)('ui.error.lang', { value: args.lang }), wording(guess)('ui.error.usage')]);
  const startLang = args.lang ?? guess;
  const usage = wording(startLang);
  if (args.help) {
    output.write(`${usage('ui.help')}\n`);
    return 0;
  }
  if (args.version) {
    output.write(`${VERSION}\n`);
    return 0;
  }
  const [command = 'check', ...extra] = args._;
  if (command !== 'check' || extra.length) return fail(2, [usage('ui.error.command', { value: command === 'check' ? extra[0] : command }), usage('ui.error.usage')]);
  if (args['user-only'] && (args.machine || args.projects.length)) return fail(2, [usage('ui.error.scope'), usage('ui.error.usage')]);

  // Every fact about where this runs, asked once.
  const around = surroundings({ env: io.env, platform: io.platform, input: io.input, output, flags: { plain: args.plain, color: args.color, ascii: args.ascii } });
  const reader = createReader(io.input);
  const home = resolveHome(args.home ?? io.home);
  // One folder in two spellings (letter case, a short name) is one folder.
  const samePath = (a, b) => canonical(a) === canonical(b);
  // --home names a home folder other than the person's own. The wizard looks for a run in the
  // person's own, so such a run ends at its report.
  const foreign = args.home !== undefined && !samePath(home, resolveHome(io.home));
  const write = (text) => output.write(text);

  let o = { lang: startLang, colour: around.colour, unicode: around.unicode, width: around.width };
  let tr = render.text(o);

  // What is printed, as blocks: each is printed once, under the one before, a blank line between.
  let lastBlank = true;
  const print = (lines) => {
    if (!lines.length) return;
    write(`${lines.join('\n')}\n`);
    lastBlank = lines[lines.length - 1] === '';
  };
  const gap = () => {
    if (!lastBlank) print(['']);
  };
  const block = (lines) => {
    gap();
    print(lines);
  };
  const answers = [];
  const answerLines = () => answers.map(([key, value]) => render.answered(key, value, o));

  // One question: a numbered list answered by a number and Enter, or the default when nobody
  // can answer. Returns the chosen option.
  async function ask(q) {
    const def = q.focused ?? 0;
    if (around.unattended) return q.options[def];
    const lines = render.numbered({ ...q, def }, o);
    const { index, defaulted } = await selectNumbered({ reader, output: { write }, lines, count: q.options.length, def, invalid: `  ${tr('ui.select.invalid', { n: q.options.length })}`, echo: around.echo });
    lastBlank = false;
    if (defaulted) print([`  ${tr('ui.select.eof', { def: def + 1 })}`]);
    return q.options[index];
  }

  // Folders typed one per line. Each is confirmed or refused at once, so a typing slip shows
  // before the scan and not as an empty report after it.
  async function askFolders(text) {
    const folders = [];
    print(render.inputAsk(text, o));
    for (;;) {
      const line = await readLine({ reader, output: { write }, prompt: render.inputMark(o), echo: around.echo });
      lastBlank = false;
      if (line === null || line.trim() === '') break;
      const typed = line.trim().replace(/^"(.*)"$/, '$1');
      const folder = path.resolve(io.cwd, expandHome(typed, resolveHome(io.home)));
      const found = projectsIn(home, folder);
      print(
        found.ok
          ? render.inputResult(true, tr('ui.scope.folder.found', { count: found.projects.length, names: found.projects.map((project) => path.basename(project)).join(', ') }), o)
          : render.inputResult(false, tr(`ui.scope.folder.${found.reason}`, { path: typed }), o),
      );
      if (found.ok) folders.push(folder);
    }
    return folders;
  }

  try {
    // Inside a Claude Code session the banner says nothing of tokens: what is printed there is
    // paid for from the person's plan.
    print(render.banner({ version: VERSION, session: around.session }, o));

    // 1. Language
    if (args.lang === undefined && !around.unattended) {
      block([render.rail(0, o), '']);
      const chosen = await ask({ question: tr('ui.lang.question'), options: LANGS.map((value) => ({ value, label: tr(`ui.lang.${value}`) })), focused: LANGS.indexOf(startLang) });
      o = { ...o, lang: chosen.value };
      tr = render.text(o);
    }
    answers.push(['language', tr('ui.language.name')]);

    // What it changes and what it never changes: the first thing said once the language is
    // known. With a terminal, and a question to follow, the two lists wait for Enter, so they are
    // read before the question pushes them up. Answers that come from a pipe (the ones this
    // program has to echo) are never held up, whatever the output is: nobody can press Enter
    // there, and the line taken for it would be the answer to the next question.
    const scope = { projects: args.projects, machine: args.machine, nested: args.nested };
    const scopeAsked = !(args['user-only'] || args.machine || args.projects.length) && !around.unattended;
    block(render.promise(o));
    if (around.watched && !around.echo && scopeAsked) {
      gap();
      await readLine({ reader, output: { write }, prompt: `  ${tr('ui.promise.enter')} `, echo: around.echo });
      lastBlank = false;
    }

    // 2. Scope
    if (scopeAsked) {
      // A terminal often opens in the home folder, which holds a .claude folder and is no project.
      const cwd = absolute(io.cwd);
      const here = isProject(cwd) && !samePath(cwd, PACKAGE_ROOT) && !samePath(cwd, home) ? cwd : null;
      block([render.rail(1, o), '', ...answerLines(), '']);
      const chosen = await ask(render.scopeQuestion({ here }, o));
      if (chosen.value === 'here') scope.projects = [here];
      if (chosen.value === 'machine') {
        scope.machine = true;
        gap();
        print(render.machineFacts({ maxDirs: args['max-dirs'] ?? DEFAULT_CAPS.maxDirs, maxDepth: args['max-depth'] ?? DEFAULT_CAPS.maxDepth }, o));
        scope.projects = await askFolders(tr('ui.scope.folder.outside'));
      }
      if (chosen.value === 'named') {
        gap();
        scope.projects = await askFolders(tr('ui.scope.folder.ask'));
      }
    }

    // 3. Scan
    let scanned = scanSetup({ home, scope, caps: { maxFiles: args['max-files'], maxDirs: args['max-dirs'], maxDepth: args['max-depth'] } });
    // A project is named by its label, as on every later screen: two folders of one name stay apart.
    const labelOf = (project) => displayPath(project.path, home, scanned.scan.projects.map((entry) => entry.path));
    const topLevel = () => ({ scope: { projects: scanned.scan.projects.filter((project) => !project.nestedIn).map((project) => ({ name: labelOf(project) })), machine: scope.machine } });
    answers.push(['scope', render.scopeText(topLevel(), o)]);
    // Repositories inside a project are projects of their own, read only when asked for.
    const leftOut = nestedLeftOut(scanned.scan);
    if (leftOut > 0 && scopeAsked) {
      block([render.rail(1, o), '', ...answerLines(), '']);
      const chosen = await ask(render.nestedQuestion(leftOut, o));
      if (chosen.value) scanned = { ...scanAgain({ home, scan: scanned.scan, nested: true }), scanMs: scanned.scanMs };
      answers.push(['nested', tr(chosen.value ? 'ui.nested.value.yes' : 'ui.nested.value.no', { count: leftOut })]);
    }

    const started = startRun({ home, scan: scanned.scan, scanMs: scanned.scanMs, lang: o.lang, startedBy: 'launcher' });
    const { view } = started;
    const run = runInfo(started.stamp, started.report);
    block(render.compose.scan(answers, view, { reportName: started.report.name, timings: started.timings, capped: started.scan.capped.hit, session: around.session }, o));

    // 4. The report: the four panels, one after another.
    block([render.rail(3, o), '', ...render.PANELS.flatMap((key, index) => [...(index ? [''] : []), ...render.panel(key, view, o, { rail: false })])]);

    // 5. The link to report 1, and how to continue. Nothing is opened and nothing is started.
    block(render.reportLink(run, o));
    const hasWork = view.counts.findings.total + view.counts.candidates.total > 0;
    if (foreign) block([...(hasWork ? [] : render.cleanLine(view, o)), ...render.foreignHome(o)]);
    else if (!hasWork) block(render.cleanLine(view, o));
    else block(render.wayOn(run, o, { agent: around.session && around.unattended, folder: toPosix(PACKAGE_ROOT) }));
    return 0;
  } catch (error) {
    return fail(1, [wording(o.lang)('ui.error.failed', { message: error.message })]);
  } finally {
    reader.close();
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
  process.exitCode = await main(process.argv.slice(2));
}
