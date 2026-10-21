# claude-health-check

A health check for your Claude Code setup: the memory files (`CLAUDE.md`), rule files, skills,
commands, agents, hooks and settings that decide what Claude knows before your first word.

## What it does

- **Measures** those files against the documented limits and shows what is loaded before your
  first word, as a report in the terminal and as one offline HTML page.
- **Finds** what a program can prove (a file too long, an exact copy of a line, an import that
  leads nowhere, a hook whose script is gone) and lets Claude read what a program can only
  suspect (a line that may belong in a hook, a skill, a command or a permission rule).
- **Suggests changes file by file**: your user memory file first, then your other user files,
  then each project. Each change is a card with the exact diff; you answer apply or skip.
- **Writes a second report** of what changed, per file, with the backup folder to undo from.

English or Slovak, your choice.

**Two parts, the same checks.** Part 1 is the program `claude-health check`: no model, no tokens,
an HTML report, then the walk of changes. Part 2 is the prompt `/claude-health-prompt` in Claude
Code: Claude reads the files, runs the same 29 checks, judges every candidate, then applies the
changes you pick. It needs no Node and costs tokens ([one catalogue](#two-parts-one-catalogue)).

**State, 5 October 2026.** The check and both reports are ready. The walk of changes (the cards,
applying them, report 2) is **experimental**: a model has run it from start to end, but met
defects and unclear steps on the way, and they are not fixed yet (`AUDIT.md`, classes 2 to 4).
Every change still waits for your yes and is backed up first. To be safe, run
`claude-health check`, read the report and make the changes yourself, or try the walk on a setup
you can restore.

## What it does not do

- It does not read source code. Only `claude-health tokens` and part 2 look into session transcripts, and they keep numbers only.
- Part 1 sends nothing anywhere: no network request, for any step. Part 2 reads the files, settings
  in full, into the conversation and so to the model; its report repeats no value.
- It does not judge git, secrets or how open your permissions are; it looks only at how well the setup works for the AI.
- It does not judge the quality of what a skill says, only its shape: size, description, steps.
- It does not count the tokens of a running session (`/context` does); its numbers are estimates from the files.
- It does not check whether a hook script works, only that the file is there.
- It changes nothing in your setup without your yes. What it can change, and what it never changes, is the list below.

### What it changes, and what it never changes

The tool shows these two lists before it reads anything; this is the same text.

```
  WHAT IT CHANGES       only after your yes to that one change, backup first
  · your memory files (CLAUDE.md, CLAUDE.local.md, rule files; user and
    project): the exact lines shown on the card are removed, shortened or
    moved
  · your own skills, commands and agents: front matter fixed, or the file
    shortened
  · new files: a skill, a command, a rule file, a hook script, or a
    CLAUDE.md where there is none
  · settings: a hook or a permission rule is added, nothing is removed
  · without asking: only its own folder, ~/.claude/health-check/ (run data,
    backups, the two reports)

  WHAT IT NEVER CHANGES
  · source code, or anything outside your Claude Code setup
  · anything you did not confirm: there is no "apply all"
  · settings entries and hooks that are already there
  · a file as a whole: none is deleted, none is overwritten
  · third-party skills
  · the MCP configuration files
  · session history and auto memory
  · git: it does not stage, commit or upload
```

Every line is held by a test. The long form is under [What it never does](#what-it-never-does).

## Run it

Open a terminal in this folder (the one that holds this README) and type the line for your shell:

```
cmd          claude-health check
PowerShell   .\claude-health check
sh           ./claude-health check
```

No install step, no PATH entry, no npm package. It needs Node.js 20 or newer and, for the
second half, Claude Code. If your checkout lost the executable bit: `sh claude-health check`.
If cmd answers that `claude-health` is not recognized (a shell that does not look for programs
in the current folder), type `.\claude-health check` there as well.

Part 2 needs no install step and no Node: start Claude Code in this folder and type
`/claude-health-prompt`, or `/claude-health-prompt --projects <dir>` to check projects too.

The first half runs as a plain program: no model, no tokens, no permission prompt. It opens
nothing and starts nothing: it ends with the link to its report and the two lines that continue
in Claude Code. Inside Claude Code the same run starts with `/claude-health check`.

## What it reads

| Where | What |
|---|---|
| `~/.claude/` | `CLAUDE.md`, settings, skills, commands, agents, rule files |
| each project you name | the same, plus `CLAUDE.local.md`, `AGENTS.md` and the server names in `.mcp.json` |
| imports | files a memory file pulls in with `@path`, when they are text inside that setup |
| the auto memory index of each project | its **size**, nothing else of it |

Nothing else is opened, and no link is followed. Values in settings, hook commands and MCP files
are never printed or stored. The details are under [What it reads, in full](#what-it-reads-in-full).

## What happens, step by step

1. **Language, the two lists, scope.** English or Slovak; then what the tool changes and what it
   never changes; then what to check: only your user files, every project under your home
   folder, or the folders you name. Each question is a numbered list: type a number and Enter.
2. **Scan and checks.** A fraction of a second for a normal setup. Every number is measured.
3. **The report, four panels**, printed one after another: overview, findings, context tax,
   skills. This is the first:

   ```
     [ Overview ]   Findings 18     Context     Skills 9

     30 files · 2 projects      ▲ 1 high   ■ 9 medium   ● 8 low   ○ 1 to review

     MEMORY FILES                      lines       under 200 lines │ over
     ~/.claude/CLAUDE.md                 238   ████████████████████│▓▓▓▓   119%
     alpha-service/CLAUDE.md              12   █░░░░░░░░░░░░░░░░░░░│         6%
     beta-tool/CLAUDE.md                   6   █░░░░░░░░░░░░░░░░░░░│         3%

     LOADED AT EVERY SESSION START     lines       under 400 lines │ over
     in alpha-service                    459   ████████████████████│▓▓▓    115%
     in beta-tool                        443   ████████████████████│▓▓     111%
     user files only                     437   ████████████████████│▓▓     109%

     200 lines per file is documented. 400 for the total is a default of this
     tool.
   ```

   The same content, with every quote and a diagram of each skill, is written as **report 1**:
   one offline HTML file in `~/.claude/health-check/`.
4. **The link, and how to continue.** The program prints the link to report 1 and stops. For
   the changes it prints two lines, each on a line of its own:

   ```
   claude
   /claude-health resume <stamp>
   ```

   Type the first in a terminal opened in this folder: it starts Claude Code. Type the second
   inside Claude Code. The program prints the path of this folder above the first line, because
   it may have been started from another one, and `/claude-health` exists only in a Claude Code
   that was started here. Stopping here costs nothing: the run waits in
   `~/.claude/health-check/`.
5. **In Claude Code: the reading.** Claude reads your memory files and judges the candidates,
   the things word matching only suspects (two lines that may contradict, a rule that may carry
   an exception, a line that may be a hook, a command or a permission rule). Each is confirmed
   with its exact quote, and only then becomes a change you are asked about, or it is dismissed
   with a reason.
6. **The changes, file by file, one card at a time.** Your user memory file first, then your
   other user files, then each project; inside a file from the top down. Entering a file prints
   a short header: the file, its lines against the recommendation, what is suggested in it. A
   card is a diff of exactly what will be written: new files in full, the settings entry in
   full, the lines that leave. You answer apply, skip, skip the rest of this file, or stop;
   "Other" lets you say what should be different.
7. **Summary and report 2**: before and after, where each line went, and per file what was
   applied, what you skipped and what is still open, with the backup folder to undo from.

Steps 1 to 4 need no model. From step 5 on it runs on your Claude plan.

## Use it in every project

To have `/claude-health` and `/claude-health-prompt` in every project, copy the two skill
folders into your personal skills folder. Run these from inside the `claude-health-check` folder. The commands create the target
folder first, because it does not exist on a machine that has no skills yet:

```sh
# macOS, Linux, Git Bash
mkdir -p ~/.claude/skills && cp -r .claude/skills/claude-health ~/.claude/skills/claude-health && cp -r .claude/skills/claude-health-prompt ~/.claude/skills/claude-health-prompt
```

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force $HOME\.claude\skills | Out-Null; Copy-Item -Recurse .claude\skills\claude-health $HOME\.claude\skills\claude-health; Copy-Item -Recurse .claude\skills\claude-health-prompt $HOME\.claude\skills\claude-health-prompt
```

Then type `/claude-health check` in any Claude Code session. The launcher (`claude-health
check` in a terminal) stays in this folder; it checks whatever projects you name, wherever they
are.

To update a copy, delete `~/.claude/skills/claude-health` (and `claude-health-prompt`) first and copy again; copying over an
existing folder nests the new copy inside the old one.

When you then check this repository itself, the tool lists the skill twice, once under your user
skills and once under this project, and says whether the two copies still have the same text.

## How this differs from what Claude Code has built in

Claude Code brings its own commands for instruction files. They overlap with this tool in
places, and where they do, use them: they know your version of Claude Code and this tool does not.

| Built in | What it does | Use it when |
|---|---|---|
| `/memory` | lists the memory files of the session | you want to see what is loaded right now |
| `/context` | lists the memory files that were loaded into the session | you want what this session really holds, not an estimate |
| `/doctor` | proposes trims of a checked-in `CLAUDE.md` | one file has grown and you want it shorter |
| `/doctor prompt-audit` (2.1.283 and later) | checks instruction files for outdated or conflicting content and proposes edits | you want a model to judge the wording of your instructions |

What this tool adds:

- **The whole setup at once, across projects**: user files, any number of projects, skills,
  commands, agents, rule files, hooks and settings, with what loads where and what a setting
  excludes.
- **Proof before judgement.** Every finding quotes its lines; a candidate from word matching is
  never shown as a finding; every documented number comes with its page, a number that was not
  read again on the date the report names says so, and every other number says it is a default
  of this tool. There is no score.
- **Placement, not only wording**: which line belongs in a skill, a command, a hook, a
  permission rule, a rule file, the project file or the user file.
- **A guided change with a way back**: one change at a time, shown as a diff, a backup before
  the first write, a hash of what you were shown, and a second report of what changed.
- **Reports you can keep and send**: one offline HTML file each, with a diagram per skill.
- **No model for the first half.** Scan, checks and report 1 are plain programs.

What it does not have: knowledge of your running session. The numbers here are computed from
the files; `/context` shows what was really loaded.

---

The rest is reference.

## The launcher

`claude-health check` asks at most three things. Each has an option, so a run needs no keyboard:

| Option | Answers |
|---|---|
| `--lang en\|sk` | the language (asked first; the preselected answer follows your system) |
| `--user-only` | scope: only `~/.claude` |
| `--projects <dir> ...` | scope: these projects, or folders that hold projects |
| `--machine` | scope: every project under your home folder (can be combined with `--projects` for folders elsewhere) |
| `--nested` | include repositories that sit inside a project (asked only when there are some) |
| `--plain` | no colour, and the two lists do not wait for Enter |
| `--ascii` | no Unicode glyphs |
| `--color` | colour even when the output is not a terminal |
| `--home <dir>` | check another home folder (the tests use it); such a run ends at its report |

```sh
./claude-health check --lang en --projects ~/work/my-project
```

Everything is printed once, one block under the other, in every terminal and in a window of
any size. A question is a numbered list: type a number and Enter, or Enter alone for the
default the prompt names. The four panels of the report follow one another. Every line is at
most 76 columns wide; the link and the path of this folder are never cut.

Between the language and the scope it shows the two lists, what it changes and what it never
changes. In a terminal the lists wait for Enter when a question follows. When the scope comes
from an option or the answers from a pipe, the lists are printed and the run goes on.

Where it runs decides three things, and nothing else:

- **A terminal**: colour, and the wait for Enter under the two lists. Where Git Bash gives Node
  pipes although there is a terminal (that depends on how Git for Windows is set up), the sh
  script tells the program so.
- **Not a terminal** (a pipe, a file, CI): no colour; answers are read from standard input, and
  when the input ends the default is taken and said. An answer is written back after its prompt
  as text: a character a terminal would act on is shown as a mark. When only the output goes to
  a file and the keyboard is a terminal, nothing is asked, because the questions would land in
  the file; the defaults are taken.
- **Inside Claude Code, started by an agent**: nothing is asked, and nothing is said about
  tokens, because what is printed there is paid for from your plan. The last line is the
  command to type.

Colour is off with `NO_COLOR`, with `TERM=dumb` and without a terminal; `FORCE_COLOR=1` turns it
on. Unicode is replaced by ASCII with `CLAUDE_HEALTH_ASCII=1`, in the legacy Windows console, on
the Linux virtual console and under a Chinese, Japanese or Korean locale. One module,
`lib/surroundings.mjs`, reads all of this; no other file reads the environment or asks a stream
what is on its other end.

**After the report.** The launcher opens no browser and does not start Claude Code. It prints
the link to report 1 and how to continue, as two lines that each stand alone: `claude`, typed
in a terminal opened in this folder, and `/claude-health resume <stamp>`, typed inside Claude
Code. The path of this folder stands above the first, on a line of its own: it is a place to
go to, not an argument of a command. The two are never printed as one command line. A shell may rewrite an argument that begins
with a slash (Git Bash turns it into a Windows path), and which shell a printed line ends up in
cannot be known; a program name with nothing after it leaves a shell nothing to rewrite. A
setup with nothing to change ends with the link, and so does a run on another home folder.

**The launcher scripts.** No JavaScript file in this package starts a program or opens a
connection; a test holds it to that. The two launcher scripts, `claude-health` and
`claude-health.cmd`, start one program, Node with the check, and end with its exit code. To
find it each uses one tool of its shell (`dirname`, `where`). cmd looks for a program in the
working folder before the PATH; the cmd script switches that off while it runs, so a `node.cmd`
or a `where.cmd` in a repository you start it from is never run. Run without a script
(`node bin/claude-health.mjs check`), the program does the same.

## Inside Claude Code

The skill lives in `.claude/skills/claude-health/` of this repository, so `/claude-health` is
there as soon as Claude Code is started here.

- `/claude-health check`: the whole run in the session. Language and scope are pickers; once
  the language is known the session prints the two lists, what it changes and what it never
  changes; the report is printed as four blocks.
- `/claude-health resume <stamp>`: what the launcher tells you to type. Language, scope and the
  report are done; the session begins at the reading.
- `/claude-health-prompt [--user-only | --projects <dir> ...]`: part 2, the same checks done by
  reading, with no script. After the report it lists every change as an exact edit, waits for
  the numbers you pick, applies them and checks again. Its front matter allows Read, Glob, Grep,
  `wc`, `cmp` and `ls -t` ahead of time and no write, so Claude Code asks before each write too.
  `--report-only` stops at the list, `--sessions N` reads N latest sessions (default 5), `--json`
  adds the result as JSON.

The walk of changes that follows the reading is experimental; see the state at the top of this
file.

The wizard calls one script, `scripts/ui.mjs`, and repeats the blocks it prints. It writes two
kinds of file itself, both into the run folder: its judgement of the candidates, and the draft
of a change that needs wording (the front matter of a new skill, a hook command you gave it, a
shorter line). The card is drawn from that draft and applied from that draft.

**Permission prompts.** The skill's front matter allows two things ahead of time: reading the
files of a run (`Read(~/.claude/health-check/**)`) and `AskUserQuestion`. Nothing that runs a
command is allowed ahead of time. Claude Code therefore asks before the first call of the
script, and you can allow that exact command for the session; it asks again before a change is
applied, before a memory file outside this folder is read, before a draft is written and before
a report is opened. That is on purpose: a rule that allowed the script by a pattern would also
allow another program whose path ends the same way, and the call that writes. No settings file
is shipped in this repository.

## What it reads, in full

Only these, and only to measure and check them:

| Where | What |
|---|---|
| `~/.claude/` | `CLAUDE.md`, `settings.json`, `settings.local.json`, `skills/*/SKILL.md`, `commands/**/*.md`, `agents/*.md`, `rules/**/*.md` |
| each project | `CLAUDE.md`, `CLAUDE.local.md`, `CLAUDE.md` in subfolders, `AGENTS.md`, `.claude/CLAUDE.md`, `.claude/AGENTS.md`, `.claude/settings*.json`, `.claude/skills`, `.claude/commands`, `.claude/agents`, `.claude/rules`, `.mcp.json` |
| imports | files that a memory file pulls in with `@path`, under the three conditions below |
| `~/.claude/projects/<project>/memory/MEMORY.md` | **its size, nothing else** (see "The context tax") |

An import is opened only when all three hold:

- **it lies where its importing file may reach**: a file of a project imports from that project
  and from `~/.claude`; a file under `~/.claude` imports from `~/.claude`. A memory file in a
  cloned repository therefore cannot make the tool open a file elsewhere in your home folder or
  in another project;
- **it is a text file**: `.md`, `.mdc` or `.txt`. An import of source code, a `.env` or a
  manifest is counted by name and never opened;
- **no part of its path is a link.**

An import that fails one of these is listed under "Scan notes" in the report, unread.

From `.mcp.json` it takes the server names and nothing else. From settings it takes the names of
keys, the `claudeMdExcludes` patterns, and of the permission rules how many each list holds
and which of them name an MCP server (`mcp__<server>`, a shape that leaves no room for anything
else). The text of every other permission rule is not kept at all: a rule can hold a credential
and no pattern recognises every one. Where a check has to know whether a command is covered by
a rule, it reads the settings file again, answers yes or no, and keeps nothing. From a hook it
takes the event, the matcher, and two words of the command: the program, and the script an
interpreter is given. Every other argument of a hook command is replaced by `***`, because an
argument can be a password and nothing can tell. In a
skill folder it looks at the names of the entries, to see a licence file or a repository marker,
and opens `SKILL.md` only. It checks whether a handful of well-known manifest files exist at a
project root (`package.json`, `Cargo.toml`, ...) to tell stacks apart, without opening them.

**Repositories inside a project.** A folder below a project that has its own `.git` (a folder in
a clone, a file in a worktree or a submodule) is a separate project. The scan names it and does
not enter it. Ask for them (`--nested`, or the matching answer when the launcher or the wizard
asks) and each becomes a project of its own: its own group in every list, its own totals, never
counted into the project around it. The same holds for a folder you name next to a folder
around it (`--projects mono mono/packages/web`): both are projects.

**What stands above a project.** Claude Code loads the memory files of the folders above the one
it is started in. For a repository inside a project, and for a project named inside another,
the tool counts the memory files it has scanned in the folders between that project and the
outermost scanned project around it (`CLAUDE.md` and `CLAUDE.local.md` in any of those folders,
`.claude/CLAUDE.md` at a project root), and by the same list it says whether an `AGENTS.md`
there is read. Folders above a scanned root are not looked at: a `CLAUDE.md` in a folder of
repositories is counted only when that folder itself is scanned.

**The home-folder search** (the scope "every project under my home folder", `--machine`) walks
your home folder, not the whole machine, looking only for folders that contain `CLAUDE.md` or
`.claude`. It does not enter hidden, dependency, cache or system folders. Names that mean build
output inside a project (`build`, `dist`, `out`, `target`, `vendor`, `env`, ...) are entered in
the first two levels below the home folder, where they are as likely a folder of projects
(`~/work/build/...`), and skipped deeper down. It stops at a cap on folders (20,000) and depth
(6 levels below the home folder), and says so in the result when a cap stopped it. Projects
outside the home folder (another drive, a work folder elsewhere) are not found by the search:
name those folders yourself. Inside a project, the search for `CLAUDE.md` in subfolders is
bounded by the same cap on folders.

## What it never does

The long form of the short list at the top: each line, and what holds the tool to it.

**Reading**

- Source code: the scan opens only the files listed under "What it reads, in full". An import
  of source code, a `.env` or a manifest is counted by name and never opened.
- Session transcripts: the check asks of the per-project folders under `~/.claude/projects/`
  for the size of one file, the auto memory index, by its full name, and opens nothing there. It
  never reads `~/.claude.json`. `claude-health tokens` is the one command that reads transcripts
  ([Tokens](#tokens)): it keeps numbers, tool names, model ids and skill names, and no text, no
  tool input and no path of a transcript leaves it. `tokens.mjs` is the only module that may
  name that folder; a test holds it. Part 2 lists the latest transcripts by name and greps them
  with `-o` for one pattern that matches the three input numbers of a reply and nothing else; a
  test runs that pattern over a transcript with text in every place.
- Links: it never follows a symbolic link or a junction, neither in a folder walk nor in the
  path of an import. Links are listed as skipped, so you know; a linked skill folder is listed
  by its name as "linked, not read".
- Secrets: values in settings, hook commands and MCP files are never printed or stored (see
  "Secrets" under "Things to know"). A quoted line of a memory file and a step of a skill are
  shown as written: a credential that you wrote into one is on the card and in the report.
- Terminal control: a name or a line of a scanned file never reaches the screen with a
  character the terminal would act on (an escape sequence, a character that reorders text); such
  a character is shown as a mark. The same holds for an answer the launcher reads from a pipe
  and writes back after its prompt. The launcher itself sends a terminal text and colour codes,
  nothing else.
- The network: it never makes a request. The reports are single HTML files with inline CSS and
  inline SVG, no JavaScript and no external resource.
- Other programs: no JavaScript file of it starts one; the two launcher scripts start Node, with
  the check, and nothing else: no browser and no `claude` (see "The launcher scripts"). Nothing
  runs git.
- Instructions in what it reads: the text of a scanned file is data. A line in a memory file
  that addresses the wizard is reported as a finding.

**Changing**

The two lists of the short part come from two tables in the code. `lib/targets.mjs` says which
kinds of file exist for a write and what each write may touch; `lib/promise.mjs` holds one entry
per line of the lists. A test compares them, so a new kind of write cannot appear without a line
in the list, and a second set of tests tries every line of "never" through the scripts and sees
it refused.

- Outside the setup: a write accepts only memory files, skills, commands, agents, rule files,
  hook scripts and settings files, under `~/.claude` or under a project root it is given by
  name; anything else is refused, whatever asked for it. That leaves out source code, imported
  documents, `.mcp.json`, `~/.claude.json` and everything under `~/.claude/projects/`, also
  when a folder in there is named as a project root. The launcher cannot write to the setup at
  all: it does not load the module that does.
- Without your yes: one subcommand carries out a change, and it takes the number of the card on
  screen. An answer for another card, an answer said twice, or a card whose file or draft
  changed after it was shown is refused. There is no answer that applies more than one card;
  "skip the rest of this file" and "skip all of this kind" only skip.
- Without a backup: every file is copied before its first change, and a change needs the hash
  of the lines you were shown. An edit is written to a new file with a random name next to its
  target and moved into place; a file or a link that already sits at such a name is never
  written through. A file addressed in two spellings (letter case, a short name) is
  one file with one backup, and a backup copy is never replaced by a later one.
- What is already in a settings file: a merge only adds, and what it adds is a hook entry or a
  permission rule (`allow`, `ask`, `deny`). A patch with any other key, or one that would change
  or remove an entry, is refused before its card is shown. A settings file is written again as JSON, so its
  values, their order, the indentation and the line endings stay; a list that was written on
  one line may come back one entry per line. A hook script that exists is never written to.
- A file as a whole: no write deletes a file and none replaces one. Lines are edited in place;
  line endings, a missing final newline and permission bits stay as they were. A file that is
  not UTF-8 is refused, not converted. A result file (`--out`) replaces a file only inside
  `~/.claude/health-check/`.
- Third-party skills: what the reports mark "third-party · do not edit" (see "Skills") is
  refused by the write itself, for an edit of a line and for a new file in that folder.
- A hook you have not read: the card prints the command in full, and the yes is yours.

## Where things go

Everything a run produces lives outside any repository, in `~/.claude/health-check/`:

| Path | What |
|---|---|
| `run-<stamp>/` | `session.json`, `scan.json`, `checks.json` from the first half; then `reading.json`, `judgement.json`, `state.json`, `applied.json`, `drafts/` |
| `backup-<stamp>/` | a copy of every file taken before its first change, and `manifest.json` |
| `state-<stamp>.html` | report 1 |
| `after-<stamp>.html` | report 2 |

Three things to know about that folder:

- **A backup is a copy.** The backup of a settings file holds everything the file holds, secrets
  included, a second time. A card that is changed by hand takes that copy when it is shown,
  before you have decided anything.
- **Nothing in it is cleaned up.** Every run leaves its run folder and its reports; delete old
  ones when you no longer need them.
- **Look before you pass a report on.** Both reports show full paths (your user name is in
  them) and quote lines of your memory files.

## How to undo

Open `backup-<stamp>/manifest.json`. Each entry holds the original path and, under `copy`,
where its copy sits inside the backup folder. Copy the file back to undo the changes to it. An
entry with `"existed": false` is a file the wizard created; delete it to undo.

A settings file you edit by hand at the wizard's request is copied there first as well. The one
thing without a copy is a file outside the setup that you edit by hand (an imported document,
for example); the card says so before you edit, and report 2 says so afterwards.

## What it reports

The result keeps four things apart, and only the first is counted.

**Findings** are what a program can prove from the files: a length against a documented limit, a
file that is missing, an exact copy of a line, front matter without a description. Each has a
severity and a suggested change.

**Candidates** are what the wording of a line suggests and nothing else does: two lines that may
contradict each other, a rule that may carry an exception, a numbered block that may be a
procedure, a line that may describe a hook, a command, a permission rule or one project, a
skill description that may not say when to use the skill. Word lists cannot tell an instruction
from a description ("Export jobs cover all customers except in one region"), steps from
principles ("1. Think before coding."), or what Claude may run from what a test may use. So a
candidate has no severity, is not counted, and is never a card by itself. The wizard reads every
one: it confirms a candidate with the exact text of every line it names, and then it is a
finding with a severity; or it dismisses it with a one-line reason, and the report lists it with
that reason. Until then the console shows them as one sentence, "Candidates found by words
only: N", and the report holds them in one closed section.

Pairs of lines that may contradict each other grow with the square of the lines, and every
listed pair has to be read. The list is therefore bounded: a line is part of at most 3 listed
pairs, and one place (your user files, or one project) lists at most 30. Pairs over the bound
are counted, and the sentence says how many were left out.

**To review** are things worth a look that propose no change. There is one kind: an MCP server
named in a project's `.mcp.json` that no permission rule in effect names.

**Notes** are what would be a finding on a skill of your own and is only a remark on a
third-party one.

| Check | Result | Suggests |
|---|---|---|
| a memory file over the recommended size, with its largest sections | finding | shorten |
| a memory file over 4 MiB (it is not loaded at all) | finding | shorten |
| too much loaded at every session start (memory, imports, rule files without `paths`) | finding | move into rule files |
| the same instruction twice in one file, or in files that load together | finding | delete the duplicate |
| the same instruction in several project files | finding | move to the user file |
| skills: no description, name differs from folder, too long, description over the cap, can never be invoked | finding, or a note on a third-party skill | fix or shorten |
| copies of one skill, in your user folder and in a project, whose texts differ | finding | make them equal or keep one |
| commands and agents without a description | finding | fix the front matter |
| a settings file that is not valid JSON | finding | change settings by hand |
| a hook whose script is missing | finding | change settings by hand |
| a hook on an event name outside the list this tool knows | finding (low) | check the name |
| an import that does not resolve, an import chain over the documented depth | finding | fix the import |
| a line that asks for something another line forbids, in another section or file | candidate | review the conflict |
| a line written like an instruction that holds an exception word (except, unless, only when; okrem, iba ak, len keď, ...) | candidate | review the exception |
| a numbered block of four or more items | candidate | turn into a skill |
| "when I say X, do Y" | candidate | turn into a command |
| an imperative to run a tool on an event: "run the tests after each edit" | candidate | turn into a hook |
| "never run `<command>`" | candidate | add a `permissions.deny` rule |
| "never run `<command>` without asking" | candidate | add a `permissions.ask` rule |
| a user-file line that holds the name of one project, a path or a stack word only it has | candidate | move to the project file |
| a skill description without "use when" wording (not asked of a skill with `disable-model-invocation: true`) | candidate, or a note on a third-party skill | fix the front matter |
| an MCP server of a project with no `mcp__<server>` rule in allow, ask or deny | to review | nothing |

The wizard adds findings of its own from reading the files (vague instructions, stale
references). Those too are accepted only with the exact text of the lines they point at: the
script refuses an entry whose quote does not match the file.

### How a change is made

Every change is a plan: a short list of steps (create a file, add to a settings file, remove or
replace lines). For changes that need no wording the script makes the plan itself: a duplicate
to delete and, once the wizard has confirmed the candidate, a permission rule the line already
names and a line to move to its project. Where
wording is needed the wizard writes a draft, and the script holds it to the setup: a target
outside it, a file that exists already, or lines that are not there are refused before a card
is shown. Lines of yours that move are moved by the script, unchanged, never retyped by a model.

The card shows the plan as a diff. Your answer names the card. `apply` checks that the files
and the draft are still what the card showed, creates first and removes second, and leaves one
line: what was applied and how the line counts moved. A card whose line is gone, because an
earlier change took it, says "resolved by an earlier change" and is not asked about.

Some changes are yours to make: a settings file that does not parse, a hook whose script is
gone, two copies of a skill that differ, a line in a file this tool does not write. Their card
says what to change and takes a copy first where it may. Answered "Done", the file is looked at
again. When the finding is gone, the change is recorded as changed by you, by hand: the summary
and report 2 count it apart from what the tool applied, and say of it nothing the tool did not
do. When the finding is still found, one line says so, nothing is recorded, and the card comes
back: a change that did not happen is never written down.

**The order is by file.** Your user memory file comes first, then your other user files, then
each project in turn; inside a place the memory files, then skills, commands, agents, rule files
and settings; inside a file from the top down, with what concerns the whole file first. A change
that names two files belongs to the file its finding sits in. One function makes that order
(`lib/order.mjs`), and the walk, the list in the console, report 1 and report 2 all take it from
there. When the walk enters a file it prints a header: which file of how many, its lines against
the recommendation, and what is suggested in it by kind. A card says "File 2/14 · change 17/32".
Besides apply, skip and stop a card offers "Skip the rest of this file (N)", which moves on to
the next file, and, where a slot is left, "Skip all N of this kind". The question that opens the
walk has three answers: all of them, the high and medium ones only, or not now.

### The context tax

For your user files alone and for each project, the report shows what is in context before your
first word:

- the memory files that load at launch (user, project, local) and everything they import,
- rule files without a `paths` pattern, at user level and in the project,
- minus every file a `claudeMdExcludes` setting switches off there, listed as "excluded by
  setting" (a memory file in a subfolder that is switched off is left out of the checks as well),
- minus the lines of block-level HTML comments in those memory files: Claude Code strips them
  before the file is injected, so they are not counted as loaded lines, cost no tokens here, and
  are not read as instructions. A comment inside a line, and one that never closes, stay text,
- an `AGENTS.md` where it stands in for a missing memory file,
- the auto memory index of the project (`~/.claude/projects/<project>/memory/MEMORY.md`): the
  first 200 lines or 25 KB load. Only its size is read, so the size cap is what is applied. The
  name of the per-project folder is observed, not documented; when the file is not where that
  rule puts it, the report says "not found" and nothing else is tried,
- the listing of skills and commands: name, description and `when_to_use`, at most 1,536
  characters of text for each. A skill with `disable-model-invocation: true` adds nothing.

Tokens are bytes divided by four: an estimate, labelled as one. Descriptions of agents are not
counted, and the report says so. The largest contributors are listed first.

### Skills

Skills are grouped: your user skills first, then one group per project, headed by the project's
full path. A project with none says so; a nested repository is a group of its own.

In the report each skill is a closed row. Opening it shows its lines against the
recommendation, its notes, and **a diagram of its steps**: boxes for steps, a diamond for a
decision, arrows. The steps are read from the skill's own numbered list or its "Step N" headings
by a program; a branch is drawn only where the text begins with if / when / unless / otherwise
(ak, keď, inak). A skill with no recognisable steps gets no diagram and says so. The Mermaid
text of every diagram is folded under it for copying. For a skill the run has just created, or
one you ask about, the wizard can add a branch it read in the prose; each needs the exact text
of its line, and report 2 draws it.

A skill is marked **third-party · do not edit** when its front matter has `license`, `author`,
`upstream` or `source` (at the top level or under `metadata`), when its folder holds a licence
file or is a repository of its own, or when the folder is a link. What would be a suggestion on
it is a note.

## Tokens

```sh
claude-health tokens [--days 7] [--lang en|sk] [--json] [--home <dir>] [--projects <dir> ...]
```

Where the tokens of your own sessions went in the last days, and how much of them each of the
usual savers could touch. It reads the transcripts of your sessions and their agents, changes
nothing, sends nothing, and prints numbers only. Part 2 does not run it: it needs no Node, and
reads only the context of the first and the last call of your latest sessions.

- `--days N`: how many days back, 1 to 90, default 7.
- `--lang en|sk`, `--json`: the language of the text, or the result as JSON.
- `--home <dir>`, `--projects <dir> ...`: whose transcripts, and whose skills and settings count
  for the list of unused skills and for what is already installed; without `--projects`, the
  current folder when it is a project.

Every share is of your own usage, weighted like a usage limit (cache read 0.1, cache write 1.25
or 2, input 1, output 5): an estimate, not a bill. No percentage of a vendor or a study enters a
number, because what a saver would save is not known, only what it could touch.

- **Built into Claude Code**, sorted by share: a new session for each task (the context above the
  start of a session, and calls over 400k tokens of context), loading less at session start, a
  lower effort, a cheaper model for agents (and how much of it were agents that only read and
  searched), shorter hook output.
- **Third-party tools are not offered**: RTK, context-mode, Headroom, claude-mem, Caveman,
  Serena and ccusage each get the share they could touch, one line of independent evidence and
  their address, and "found in your setup" when a hook, a plugin or an MCP server shows them.
- **Skills that did not run** in those days, with what each costs in the listing at every
  session start.

How big a piece of context is comes from the usage, not from its text: what the context grew by
between two calls is shared among what arrived between them, the model's own output exactly and
the rest by length. A piece costs once when written and again on every later call until a
compaction. A response written as several rows counts once.

## Numbers and where they come from

| Number | Value | Source |
|---|---|---|
| recommended size of a `CLAUDE.md` | under 200 lines | https://code.claude.com/docs/en/memory.md |
| largest `CLAUDE.md` that is loaded | 4 MiB | https://code.claude.com/docs/en/memory.md |
| maximum import depth | 4 hops | https://code.claude.com/docs/en/memory.md |
| auto memory index that loads | first 200 lines or 25 KB | https://code.claude.com/docs/en/memory.md |
| recommended size of a `SKILL.md` | under 500 lines | https://code.claude.com/docs/en/skills.md (carried over from the first version, not read again on that date; the report says so) |
| cap on `description` + `when_to_use` | 1,536 characters | https://code.claude.com/docs/en/skills.md |
| budget of the skill listing | 1% of the context window | https://code.claude.com/docs/en/skills.md |
| hook events | 33 names | https://code.claude.com/docs/en/hooks-guide.md |
| total loaded at session start | 400 lines | **no documented value**; a default of this tool, change it with `--total-lines` |
| steps that make a procedure | 4 | **no documented value**; a default of this tool |
| listed pairs of lines that may contradict | 3 for one line, 30 for one place | **no documented value**; a default of this tool |
| tokens | bytes / 4 | **no documented value**; a rough estimate for display |
| nodes drawn in one diagram | 40 | **no documented value**; a default of this tool |
| longest label in a diagram | 60 characters | **no documented value**; a default of this tool |
| longest line parsed as structure | 2,000 characters | **no documented value**; a default of this tool |
| width and height of a console screen | 76 columns, 24 lines | **no documented value**; a default of this tool |

Every documented fact lives in one file, `.claude/skills/claude-health/scripts/lib/facts.mjs`,
next to its page and the sentence it was read from, with the date the pages were read
(`FACTS.checkedOn`). When Claude Code changes, that is the one file to check again. The
500-line recommendation for a `SKILL.md` was carried over from the first version with its page
and was not among the answers checked again on that date: it is marked `verified: false` there,
and the report shows it as carried over, not as documented on that date.

Things to know before you trust a finding:

- **Hook event names.** The list is the one of the hooks guide on the day it was read. An event
  outside it is reported as "not in the list this tool knows", low, never as wrong: a newer
  Claude Code may know more.
- **Permission rules.** A rule has the form `Tool` or `Tool(specifier)`, with `*` for any text;
  the tool reads and suggests rules in that form. The older spelling of a prefix,
  `Bash(git push:*)`, is still found in settings files and is read as `Bash(git push *)`, so that
  a rule which is there is not reported as missing.
- **Prohibitions.** A command is taken from inline code right after the verb (``never run
  `rm -rf` ``), or, without inline code, only when the phrase starts with a command the tool
  knows (`never run git push --force on main` gives `git push --force`). "Never run migrations"
  names no command and is not asked about. Whether the line is about what Claude may run is for
  the wizard to say: "tests must not use `curl`" reads the same to a program. A line is settled
  by a rule that covers that command, in settings that apply to the file: your user settings, or
  the settings of the same project. A rule cannot carry a condition ("on a shared branch"); the
  card says so.
- **Instructions and prose.** A line with an exception word becomes a candidate only when the
  sentence is written like an instruction: it opens with a word of the verb lists in
  `lib/wording.mjs`, or it holds must / never / always / do not (nikdy, vždy, nesmie, musí).
  The lists err both ways. Many of the English verbs are nouns as well, so "Export jobs cover
  all customers except in one region" passes; a verb that is missing lets a rule through
  unseen. That is why the result is a candidate that the wizard reads, never a finding.
- **Excluded files.** `claudeMdExcludes` patterns are matched as globs against absolute paths,
  from your user settings and from the settings of the project, shared and local, added
  together. Managed policy settings are not read.
- **AGENTS.md.** It is read by Claude Code only where no `CLAUDE.md`, `.claude/CLAUDE.md` or
  `CLAUDE.local.md` is beside or above it (2.1.277 and later). The tool looks at the project
  root and at the scanned folders above it, up to the outermost scanned project around it (see
  "What stands above a project"); it does not look above a scanned root.
- **Missing hook scripts.** Only the first word of a hook command and the word right after an
  interpreter (`bash`, `node`, `python3`, ...) are taken for the script. A script behind `&&`,
  inside `bash -c "..."` or after a wrapper is not checked.
- **Secrets.** Nothing here depends on recognising one. Values of settings are not read (only
  the names of keys), the text of a permission rule is not kept, of a hook command only the
  program and the script are kept, and of an MCP file only the server names. Front matter is
  masked by shape (flags and names such as `--token`, `password=`, long keys), which catches
  what it catches. A memory file and a skill are your own text and are quoted as written.
- **Front matter.** The reader covers the YAML that skills, commands and agents use in practice.
  What it cannot read is reported as "could not be read by this tool", not as invalid.
- **Stacks.** "Only this project uses npm" means among the projects you scanned, so it is
  asked as a candidate, never stated.
- **Languages.** The wording patterns cover English and Slovak.
- **The picker previews.** Each answer of a card carries a preview of what it does to the files.
  A Claude Code that does not show previews still shows the card, which has the same content.

## Two parts, one catalogue

Part 2 is told the checks through `.claude/skills/claude-health-prompt/checks.md`, and that file is
generated: the ids and their order from `checks.mjs`, the limits from `lib/facts.mjs`, the titles
and reasons from `lib/strings.mjs`, and how each check measures and how severe it is from
`lib/catalogue.mjs`. `checks.mjs` refuses to report a severity the catalogue does not allow, and a
test fails when `checks.md` is not what the generator makes. So a new check, a changed limit or a
changed severity reaches both parts or stops the tests:

```sh
node .claude/skills/claude-health/scripts/prompt-catalogue.mjs --write   # after changing any of the four
node .claude/skills/claude-health/scripts/prompt-catalogue.mjs --check   # exit 1 when checks.md is stale
```

Part 2 reads the settings files in full, because a model cannot tell valid JSON otherwise: a
value in an `env` block or in a hook command is then in the conversation and in its transcript,
though the report never repeats it. Part 1 keeps no such value. `.mcp.json` is the exception:
part 2 greps its keys with `-o` and never reads its values.

Part 2 opens with a short view: a TL;DR of at most three sentences and a plan of at most seven
changes, one plain line each; `report` prints the full report and `details <n>` the exact old and
new lines of a change. It points a repository without a CLAUDE.md to `/init`. It changes the
setup only after that plan, then it waits. It applies only the numbers you pick, reads each file again
right before the change and skips an item whose lines moved, edits a settings file one key at a
time and never rewrites or copies it, and never touches a third-party skill. It keeps no backup;
the old lines are in the plan, and a file under git shows its change in `git diff`.

One part of that plan is about safety, not the AI: part 2 lists the actions that cannot be
undone (a push, a deletion, discarded uncommitted work, a merge or a publish, a write through an
MCP server) that no ask or deny rule covers yet, and proposes `permissions.ask` rules for them in
the user settings. An ask rule makes Claude Code ask in every permission mode, auto mode included,
and wins over any allow rule; it matches the command as written, so it is a seat belt, not a lock.
Part 1 does not have this list.

What a test cannot hold is whether a model follows `checks.md` well. That is measured by running
both parts on the same setup and comparing what they found, check by check:

```sh
S=.claude/skills/claude-health/scripts
node $S/scan.mjs --home <home> --projects <dir> --out scan.json
node $S/checks.mjs --scan scan.json --out checks.json
claude -p "Run the claude-health-prompt skill with: --home <home> --projects <dir> --json" --add-dir <home> --add-dir <dir> --allowedTools Skill --output-format json > part2.json
node $S/prompt-parity.mjs --checks checks.json --part2 part2.json   # exit 1 when a finding differs
```

Measured on the `main` fixture, 16 October 2026, two runs of part 2 with Claude Opus: 18 of 18
findings with the same severities as part 1, 13 and 14 of 15 candidates (the rest at a
neighbouring line), the context of each place within 4 tokens of part 1's 6,900 to 7,100. One run
took 51 to 53 turns and about 9 minutes; weighted like the usage limit (cache reads 0.1, cache
writes 2, output 5), about 0.6 million input-token units.

The prompt does not start with `/` on purpose: Git Bash rewrites such an argument into a Windows
path (`C:/Program Files/Git/...`), and the skill then gets no arguments it can use.

## The scripts

Each script is a command-line tool that prints its result to standard output, errors to
standard error with a non-zero exit code, and exports its functions.

```sh
S=.claude/skills/claude-health/scripts

node bin/claude-health.mjs check [options]            # the launcher, without its shell script
node bin/claude-health.mjs tokens [options]           # the tokens of your own sessions; see Tokens

node $S/scan.mjs --home <dir> [--projects <dir> ...] [--machine] [--nested] [--max-files N] [--max-dirs N] [--max-depth N] [--out <file>]
node $S/checks.mjs --scan <scan.json> [--lang en|sk] [--total-lines N] [--judgement <file>] [--out <file>]
node $S/report.mjs state --scan <scan.json> --checks <checks.json> [--lang en|sk] [--out <file.html>]
node $S/report.mjs after --before <checks-before.json> --scan <scan-after.json> --checks <checks-after.json> [--applied <applied.json>] [--lang en|sk] [--out <file.html>]

node $S/ui.mjs banner | scope --lang L | check --lang L [scope options]
node $S/ui.mjs resume <stamp> | nested --run <stamp>
node $S/ui.mjs panels --run <stamp> [--panel overview|findings|context|skills|changes]
node $S/ui.mjs judged --run <stamp> | card --run <stamp> [--walk all|urgent]
node $S/ui.mjs apply --run <stamp> --card N --answer apply|keep|choice-1|choice-2
node $S/ui.mjs decide --run <stamp> --card N --answer skip|skip-file|skip-kind|stop|done
node $S/ui.mjs flow --run <stamp> | finish --run <stamp>

node $S/tokens.mjs [--days N] [--lang en|sk] [--json] [--home <dir>] [--projects <dir> ...]

node $S/apply.mjs sha --file F [--from L --to M]
node $S/apply.mjs backup --files F ... --home <dir> [--project <root> ...] [--out <dir>]
node $S/apply.mjs remove-lines --file F --from L --to M --expect-sha SHA --backup <dir> --home <dir> [--project <root> ...]
node $S/apply.mjs replace-lines --file F --from L --to M --expect-sha SHA --backup <dir> --home <dir> [--project <root> ...] (--content-file <file> | < content)
node $S/apply.mjs append-lines --file F --expect-sha SHA_OF_WHOLE_FILE --backup <dir> --home <dir> [--project <root> ...] (--content-file <file> | < content)
node $S/apply.mjs write-new --file F --backup <dir> --home <dir> [--project <root> ...] (--content-file <file> | < content)
node $S/apply.mjs merge-settings --file settings.json --backup <dir> --home <dir> [--project <root> ...] (--patch <json> | --patch-file <file> | < patch)
node $S/apply.mjs record --applied <applied.json> --home <dir> --id ID --kind KIND [--status applied|by-hand|skipped] [--files F ...] [--created type=path ...] [--backup <dir>] [--note text]
```

`scan.mjs`, `checks.mjs`, `report.mjs` and `apply.mjs` print JSON and take `--home` explicitly;
`--out <file>` writes the full result to a file and prints a short summary instead, and refuses
to replace an existing file anywhere but in `<home>/.claude/health-check/`. The launcher and
`ui.mjs` use your home folder unless `--home` names another.

`ui.mjs` prints the block a person reads. With `--json` it prints an envelope for the wizard:
each block between two lines that carry a random mark (so a quoted line of a scanned file
cannot pass for the end of a block), then the pickers as one line of JSON, then the arguments
of the call each answer leads to.

For `apply.mjs` the home folder is also the boundary. The table is `WRITES` in
`lib/targets.mjs`; the list of what the tool changes is checked against it.

| Subcommand | May touch |
|---|---|
| `remove-lines`, `replace-lines`, `append-lines` | `CLAUDE.md`, `skills/**/*.md`, `commands/**/*.md`, `agents/*.md`, `rules/**/*.md` under `<home>/.claude`; the same under `<project>/.claude`, plus `CLAUDE.md` and `CLAUDE.local.md` anywhere in a project |
| `write-new` | a file that does not exist yet: a memory file, a skill file, a command or a rule file in those places, or a script directly in `.claude/hooks/` |
| `merge-settings` | `settings.json` and `settings.local.json` directly in a `.claude` folder; it adds hook entries and permission rules (`allow`, `ask`, `deny`), no other key, and changes none |
| any of the five | never a file in the folder of a third-party skill |
| `backup` | any of the above |
| `--backup`, `--content-file`, `--patch-file` | inside `<home>/.claude/health-check/` only |
| `record --applied` | inside `<home>/.claude/health-check/`, or a file that does not exist yet |

A project counts only when its root is passed with `--project`; `ui.mjs` passes the projects of
the scan. The reports go to `<home>/.claude/health-check/`.

**One view for every screen.** `lib/view.mjs` exports `buildView({ scan, checks, before, applied,
flows, lang })`. It turns a scan and its checks (and, after the changes, the earlier checks and
the applied record) into one plain object: the counts, the file table with limits, what loads
per place, the context tax with its contributors, findings grouped by severity and kind,
candidates, review items, skills by group with the graph of each, the suggested changes file by
file, and the diagrams. Both HTML reports and every console screen are drawn from that object,
so their numbers cannot disagree. `lib/render.mjs` holds every console screen as a function
from that object to lines.

## Tests

```sh
npm test          # or: node --test tests/
```

The tests use fixtures only and never touch your real home folder: every script takes `--home`,
each test works on a copy of a fixture in the operating-system temp folder, and a child process
is given that copy as its home folder as well.

In `tests/fixtures/` the special names are stored with a leading underscore (`_claude`,
`_CLAUDE.md`, `_AGENTS.md`, `_mcp.json`, `_git`, ...). That is deliberate: under their real
names, an agent working in this repository would load fixture content as real memory, skills and
settings, and a fixture repository would be a repository. The helper
`tests/helpers/fixtures.mjs` restores the real names in the temp copy.

- `fixtures/main` is a home folder and two projects that trigger every check.
- `fixtures/clean` is a small setup that triggers none.
- `fixtures/field` reproduces what the first version got wrong on a real setup: repositories
  nested in a project, prose with the word "except", a ranked list, an excluded import, rule
  files without paths, third-party skills, an `AGENTS.md`.
- `fixtures/flows` holds skills whose steps are drawn.

What the console tests hold the tool to:

- **The screen budget.** Every screen, for every fixture, in both languages, with Unicode, with
  ASCII and with colour: at most 76 columns and 24 lines, no line that ends in a space, no
  escape byte without colour, no glyph outside ASCII in the ASCII skin.
- **Golden screens.** `tests/golden/` holds every launcher screen of the main fixture and the
  blocks of a short session, in both languages, and whole runs of the launcher on two fixtures
  (`run.*.txt`: the opening block, the questions, the progress lines and the four panels). After
  a deliberate change run `UPDATE_GOLDEN=1 npm test` and read the difference before keeping it.
- **Questions.** The questions are driven by fake streams, typed and piped: a number and Enter,
  Enter alone, an answer that is no number of the list, the end of the input, an answer that
  carries control characters.
- **The launcher from end to end**, with flags, with piped answers and with a terminal on both
  ends: what it prints, what it writes (the run folder and report 1, nothing else), that no
  run, in any mode and in a window of any size, sends a terminal anything but text and colour,
  that the same answers give the same text in every window, and that it ends by itself while
  the keyboard stays open.
- **The two launcher scripts**, each where its shell exists, with stand-ins for `claude` and
  for everything that opens a browser first on the PATH: none of them is started. The code of
  each script is pinned line by line, so a line that is added fails a test.
- **The surroundings** (`surroundings.test.mjs`, `audit.test.mjs`): one module reads the
  environment and the streams, and no other file does.
- **`ui.mjs` from end to end**: resume, the reading, a card for each kind of change, apply, a
  card whose line is gone, finish.
- **One order.** The walk, the list in the console, report 1 and report 2 give the changes in
  the same order, and a second run of the same setup gives it again.
- **The two lists.** Every write the code can make has its line in "what it changes", and every
  line of "what it never changes" is tried through the scripts and refused.
- **Candidates stay candidates** (`candidates.test.mjs`): prose that only reads like a rule, a
  procedure, a prohibition, a line about one project or a skill without a trigger is never a
  finding; the list of pairs is bounded and says what it left out.
- **Places** (`places.test.mjs`): repositories inside a project, a project named inside
  another, two projects with one folder name, a memory file a setting switches off, and a
  comment block in a memory file.
- **Hostile input** (`hostile.test.mjs`): names and lines with terminal control characters and
  a credential in a permission rule, on every screen, in both reports and in every file a run
  writes.

The fixtures are stored with LF line endings (`.gitattributes` says so, and keeps CRLF for
`claude-health.cmd`); the tests that prove the tool works on a CRLF checkout build their CRLF
files at run time.

A few tests depend on the platform and skip themselves, with the reason, where they cannot run:
permission bits (not on Windows), one file in two spellings (only on a file system that ignores
letter case), Git Bash drive paths (only on Windows), the link tests (where the platform
refuses to create a link), and each launcher script where its shell is missing. The two copy
commands above are run by a test as well, each where its shell exists, with a temp folder in
place of the home folder.

To try the launcher on a fixture by hand:

```sh
node --input-type=module -e "import('./tests/helpers/fixtures.mjs').then((m) => console.log(m.materialise('main').root))"
./claude-health check --home <printed folder>/home --projects <printed folder>/projects
```

## Layout

```
claude-health, claude-health.cmd          the launcher scripts: the only place a program is started (node)
bin/claude-health.mjs                     the launcher: banner, questions, scan, report, how to continue
.claude/skills/claude-health/SKILL.md     the wizard: the prompt Claude follows
.claude/skills/claude-health/recipes.md   how the wizard drafts each kind of change
.claude/skills/claude-health-prompt/      part 2: SKILL.md, and checks.md generated from the catalogue
.claude/skills/claude-health/scripts/
  ui.mjs                                  what the wizard calls: blocks, pickers, cards, apply, finish
  scan.mjs                                inventory
  checks.mjs                              findings, candidates, review items, the context tax
  report.mjs                              the two HTML reports
  apply.mjs                               backup and the mechanical part of a confirmed change
  lib/pipeline.mjs                        the run folder, scan, checks, report 1: shared by launcher and wizard
  lib/render.mjs                          every console screen, as a function from the view to lines
  lib/prompt.mjs                          the questions of the launcher: a numbered list, a typed line
  lib/surroundings.mjs                    where it runs: terminal, colour, Unicode, session; the one reader of the environment
  lib/term.mjs                            glyph tables, colours, widths
  lib/view.mjs                            the view model every screen and report is drawn from
  lib/order.mjs                           the one order of suggested changes: file by file
  lib/promise.mjs                         what it changes and what it never changes, as data
  lib/facts.mjs                           documented facts, each with its page
  lib/catalogue.mjs                       how each check measures and how severe it is, for both parts
  prompt-catalogue.mjs                    writes checks.md of part 2 from the catalogue
  prompt-parity.mjs                       compares what part 1 and part 2 found on one setup
  tokens.mjs                              the tokens of the person's own sessions; the one reader of transcripts
  lib/strings.mjs                         every user-facing string, English and Slovak
  lib/flow.mjs, lib/flow-svg.mjs          the steps of a skill as a graph, as Mermaid text, as inline SVG
  lib/wording.mjs                         the word lists that pick the lines a reader is asked about
  lib/glob.mjs                            the patterns of claudeMdExcludes
  lib/automemory.mjs                      the size of the auto memory index, and nothing else from there
  lib/targets.mjs                         where the scripts may write: kinds of file, the table of writes
  lib/hooks.mjs                           what is kept of a hook command
  lib/secrets.mjs                         masking of credentials
  lib/*.mjs                               paths, front matter, markdown, arguments
tests/                                    node --test, fixtures only
tests/golden/                             the launcher screens and session blocks of the main fixture
```
