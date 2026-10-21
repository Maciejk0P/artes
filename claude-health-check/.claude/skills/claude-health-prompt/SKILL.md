---
name: claude-health-prompt
description: Health check and set-up of a Claude Code setup done by reading (part 2 of claude-health-check; part 1 is the program `claude-health check`). Runs the same 29 checks with the same limits on the CLAUDE.md memory files, rule files, skills, commands, agents, hooks and settings, reads every candidate and says what it makes of it, reads the context size of the user's latest sessions, prints the report in the conversation, then proposes every change as an exact edit, a question before actions that cannot be undone (a push, a deletion, a write through an MCP server) among them, and applies the ones the user picks. Needs no program. Use when the user types /claude-health-prompt, or asks for the health check without Node, the prompt version of the health check, a check of their setup that needs no program, or to set up their Claude Code well.
argument-hint: "[--user-only | --projects <dir> ...] [--home <dir>] [--total-lines N] [--sessions N] [--report-only] [--json]"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(wc *)
  - Bash(cmp *)
  - Bash(ls -t *)
---

# Claude health check, by reading (part 2)

Arguments of this run: `$ARGUMENTS`

You run the checks that the program of part 1 runs, by reading the files yourself, and then set
the setup up with the user. The checks, their limits and their severities are in
[checks.md](checks.md), generated from the program, so both parts check the same things. Read
checks.md once, before step 2, and follow it exactly: the same ids, the same limits, the same
severities. Where a measure there and your own sense of the file disagree, the measure wins; say
what you would add under "What reading adds" (step 5).

The aim is a setup that works well, not a cheap run: read every file the checks need in full,
and take the time a good change needs. Answer in the language the user writes in. Use the Slovak
title of checks.md for Slovak.

## What you may do

- Steps 1 to 8 read and change nothing: Read, Glob and Grep, `wc`, `cmp` and `ls -t` through Bash.
  No other command, no network.
- Write only in step 9, only the changes the user picked in step 8, with Edit and Write. They are
  not allowed ahead of time on purpose: Claude Code asks before each write as well.
- Under `<home>/.claude/projects/` (session transcripts) do only what step 6 says: `ls -t` for
  the names, and Grep with `-o` and the exact patterns of step 6, which return numbers and no
  text. Never Read, Glob or Grep there otherwise. The one other exception is the size of
  `<home>/.claude/projects/<slug>/memory/MEMORY.md`, taken with `wc -c` by its full name, never read.
- Never print a value from a settings file, an `env` block, a permission rule other than the one a
  candidate wants or one that covers an action of the list at the end of step 3, a hook command beyond its program and script, or an `.mcp.json` beyond server
  names. Never Read an `.mcp.json`: Grep it with `-o` and the pattern `"[^"]+"\s*:\s*\{`, which
  returns keys and nothing after them, and take the keys inside `mcpServers` other than `env`,
  `headers` and `args` as the server names. Without `-o` a server written on one line brings its
  values along.
- Glob only the places listed in step 2, each from its own folder. Never Glob `<home>/**` or
  `<home>/.claude/**`: those patterns reach the transcripts. Never Glob `*` with the home folder
  as the path either (a pattern without `/` matches at any depth), never Grep or Glob with a `**`
  pattern from the home folder or a folder above it, and never list a folder recursively (`ls -R`).
  Grep a set of files by naming each file.
- Quote a line of a memory file only with its exact text, file and line number.

## Arguments

- `--home <dir>`: the home folder whose `.claude` is checked. Default: the user's home.
- `--user-only`: only `<home>/.claude`.
- `--projects <dir> ...`: also these projects. A folder is a project when it holds `CLAUDE.md`,
  `CLAUDE.local.md`, a `.claude` folder or `.mcp.json`; a folder that is none holds projects, and
  its direct subfolders that are projects are taken.
- Neither: the user files, and the current working directory when it is a project.
- `--total-lines N`: the limit of always-loaded-total instead of the default in checks.md.
- `--sessions N`: how many of the latest sessions step 6 reads; default 5.
- `--report-only`: print the plan of changes (step 8) and stop; apply nothing.
- `--json`: after the report, one ```json block, the shape in step 7.

Before anything else, make sure the home folder and every folder named with `--projects` exist
with `ls -t -d <folder>` (an error means it is not there). When one does not, stop: say which argument, the value as it arrived,
and that nothing was checked. A path that a shell rewrote on its way in (Git Bash turns an
argument that starts with `/` into `C:/Program Files/Git/...`) is such a value; do not guess the
folder that was meant.

## Step 1. Say what this run does

Two or three lines, before anything is read: the scope (home folder, projects); that the files it
reads come into this conversation, settings files in full, so their values are here too though
the report never repeats them; that from session transcripts it takes usage numbers only; and
that nothing changes before the user picks from the plan. Then go on without waiting.

## Step 2. Find the files

In `<home>/.claude` (scope user) and in each project root (scope project):

| kind | where |
|---|---|
| memory | `CLAUDE.md` in the project root and `.claude/CLAUDE.md`; `<home>/.claude/CLAUDE.md` for the user |
| memory-local | `CLAUDE.local.md` in the project root |
| memory-nested | `CLAUDE.md` and `CLAUDE.local.md` in subfolders of a project; loads on demand. Skip folders that start with a dot, `node_modules`, `vendor`, `dist`, `build`, `out`, `target`, `coverage`, `venv`, `env`, `__pycache__`; a subfolder with its own `.git` is another repository: name it, do not enter it |
| agents-md | `AGENTS.md` or `.claude/AGENTS.md` in the project root; loads only when that project has no memory file |
| rule | `.claude/rules/**/*.md`; with a `paths` field in its front matter it loads on demand, without one at launch |
| skill | `.claude/skills/<name>/SKILL.md`; a linked skill folder is listed by name and not read |
| command | `.claude/commands/**/*.md` |
| agent | `.claude/agents/*.md` |
| settings | `.claude/settings.json`, `.claude/settings.local.json`, and `.mcp.json` in the project root |
| import | a file a memory file pulls in with `@path`, outside code spans and fenced blocks; only from the same project or from `<home>/.claude`, otherwise it is not read |

A skill is third-party when its front matter has `license`, `author`, `upstream` or `source`
(also under `metadata`), or its folder holds a licence file or `.git`. What a skill check finds on
a third-party skill is a note, not a finding.

A `claudeMdExcludes` list in any settings that apply switches off the memory files whose absolute
path matches one of its globs; such a file does not load in that place and is not checked there.

Then measure in as few calls as possible: `wc -l -c <files...>` on every memory, rule, skill,
command and agent file, and `wc -c` on each project's `MEMORY.md` (step 4). Block-level HTML
comments (`<!-- ... -->` that start a line and close at the end of a line) are stripped before a
memory file loads: Grep `^\s{0,3}<!--` in the memory files, each by its full path, and for a file that has them, leave
their lines and bytes out of what loads.

## Step 3. Run the checks

Read every memory file, every imported file and every rule file that loads at launch, once and
in full. Read the front matter of every skill, command, agent and rule file: Grep
`^(name|description|when_to_use|disable-model-invocation|user-invocable|paths):` over them, and
Read the first lines of a file whose value runs over several lines (`|`, `>`, or nothing after the
colon). Read settings files to see their hook events, hook commands, permission lists and
`claudeMdExcludes`, and say none of their values.

Then go through checks.md from top to bottom, check by check, place by place (the user files
alone, then each project with the user files it loads). A place is what Claude Code has loaded
when it starts there.

- An instruction line is a line that is not blank, not a heading, not a table row, not a rule
  (`---`), not inside a fenced block or an HTML comment, and not front matter.
- For a duplicate, compare as checks.md says; when unsure whether two lines are equal, Grep the
  exact line with a fixed string.
- A finding states what you measured, with the number and the limit. A candidate says what the
  words suggest, with the exact line.
- Do not stop at the first finding of a check; go through every file the check applies to.

### Then: a question before what cannot be undone

This list is not in checks.md and part 1 does not have it. It is the one question of safety this
check asks: which actions that cannot be undone Claude may run without asking first. An `ask`
rule under `permissions` makes Claude Code ask before a matching call in every permission mode,
auto mode and `bypassPermissions` included, and it wins over any allow rule
(https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/permission-modes).
So no allow rule needs to change and no hook script is needed.

| group | rules | proposed |
|---|---|---|
| push | `Bash(git push *)` | always |
| delete files | `Bash(rm *)`, `Bash(git clean *)`; with a PowerShell tool also `PowerShell(Remove-Item *)` | always |
| discard uncommitted work | `Bash(git reset --hard *)`, `Bash(git checkout -- *)`, `Bash(git restore *)`, `Bash(git stash drop *)`, `Bash(git stash clear *)`, `Bash(git branch -D *)` | always |
| merge and publish | `Bash(gh pr merge *)`, `Bash(glab mr merge *)`, `Bash(npm publish *)`, `Bash(docker push *)` | each rule when the setup names its command |
| infrastructure | `Bash(kubectl delete *)`, `Bash(helm uninstall *)`, `Bash(terraform apply *)`, `Bash(terraform destroy *)` | each rule when the setup names its command |
| writes through an MCP server | one group per server, see below | for each server with a write tool |

"The setup names the command" means that a permission rule, a hook `if` or a line of a file read
in this step names it. "With a PowerShell tool" means that you have a tool named PowerShell in
this conversation.

The MCP servers and their tools are the ones you have in this conversation, deferred tools
included, and the server names of a project's `.mcp.json`; never read `~/.claude.json` to find
more. A write tool is one whose name holds one of these words, with camelCase and `_` split:
create, add, edit, update, delete, remove, trash, move, transition, send, post, reply, forward,
share, merge, publish, deploy. Its rule is `mcp__<server>__<tool>`, exactly as named; when one
of these words begins five or more write tools of one server, one rule `mcp__<server>__<word>*`
stands for them. An MCP rule never has parentheses. A server of a project's `.mcp.json` whose
tools you do not have gets one line: it is not connected here, so its tools are not known.

A rule is covered when an `ask` or `deny` rule of a settings file that applies matches it as well
or wider: the same tool with no command (`Bash`), `Bash(*)`, or a command that ends in ` *` and
begins the rule's command (`Bash(git *)` covers `Bash(git push *)`); for MCP, `mcp__*`,
`mcp__<server>__*` or a glob that matches the tool. A PreToolUse hook whose `if` names the
command covers it too. A PreToolUse hook on that tool without `if` may ask already, but what its
program does is not yours to judge: propose the rule anyway and name the hook.

An ask rule matches the command as written, also inside `&&`, `;` and `|`, and past `timeout`,
`nohup` or a leading `VAR=value`; it does not catch `git -C . push`, `sudo rm`, `env A=1 git
push` or a script that pushes. It is a seat belt, not a lock: say so once in the report.

## Step 4. Measure the context

Per place, what is in context before the first word, in tokens as bytes divided by
`bytesPerToken` of checks.md, rounded up:

- each file that loads at launch there (memory, imports, rule files without `paths`, AGENTS.md
  where it is read), without its stripped comments;
- for a project, `<home>/.claude/projects/<slug>/memory/MEMORY.md`, where `<slug>` is the absolute
  path of the project with every character that is not a letter or a digit replaced by `-`:
  its bytes up to `autoMemoryBytes` (only `wc -c`, never read);
- the skill listing: for each user skill and each skill of that project without
  `disable-model-invocation: true`, the bytes of `<name> <description> <when_to_use>`, the
  described part cut at `skillDescriptionChars`; the same for commands (name = file name without
  `.md`).

Agent descriptions are not counted; say so.

## Step 5. Read the candidates

Here this part does what the program cannot. For each candidate, read its lines in their place
and decide: **confirmed** (it is what its words suggest; say the change in one line) or
**dismissed** (one line why: a description, not an instruction; a ranking, not steps). A
conflict pair is confirmed only when the two lines really ask opposite things in the same
situation.

Under **What reading adds**, at most five things you saw while reading that no check in checks.md
names: two instructions that disagree in other words, an instruction that names a file or a tool
that is not there, a rule that the setup already enforces elsewhere, a line about one project in a
user file, the same procedure in a memory file and a skill. Each with the exact lines. When
projects of the run are worktrees or clones of one repository, or a memory file is shared
through git with a team, say that a line found in several of them is one line of one repository,
not a reason to move it into the user file. Nothing about git, secrets or how open the
permissions are: this check is about how well the setup works for the AI, and its one question
of safety is the list at the end of step 3.

**Tips**, each only when its condition holds, each a plan item:

- **A memory for a repository.** The current working directory or a direct subfolder of a
  `--projects` folder is a git repository (`ls -t -d <folder>/.git` finds it) with no `CLAUDE.md`,
  `.claude/CLAUDE.md` or `AGENTS.md`, so Claude starts there knowing nothing of the project. The
  item: run `/init` in that folder, which writes a CLAUDE.md from the code; you do not write it.
- **A tidy memory index.** A project's `MEMORY.md` is over half of `autoMemoryBytes` and loads in
  every session there. The item: in that project, ask Claude to keep one short line per memory in
  `MEMORY.md` and the content in the memory files.
- **A new session per topic.** A session of step 6 ended above three times its first call or was
  compacted: one of the three sentences of the TL;DR, not a plan item.

## Step 6. Read the size of the latest sessions

Take the transcripts with `ls -t <home>/.claude/projects/<slug>/*.jsonl` for each project of the
run (`<slug>` as in step 4), or `ls -t <home>/.claude/projects/*/*.jsonl` with `--user-only` or
no project; the first `--sessions` names are the latest. For each of them, with Grep:

- `-o` and the pattern
  `"usage":\{"input_tokens":\d+,"cache_creation_input_tokens":\d+,"cache_read_input_tokens":\d+`,
  the first match (head limit 1) and, after a count of the matches, the last one (offset count
  less one). The context of a call is the sum of its three numbers.
- a count of `"subtype":"compact_boundary"`: how many times the session was compacted.

When the pattern finds nothing in any transcript, the transcripts are in a format this skill does
not know: say so in one line and leave the section out. Never fall back to reading a transcript.

## Step 7. Report

The reader wants to know fast how the setup stands and what will be done about it. By default
print only this short view, in plain words and without tables:

1. A title with the date and, under it, the icons as one line:
   `🔴 high · 🟠 medium · 🟡 low · 🔵 your call · ⚪ note · 🟢 fine`.
2. **TL;DR**, at most three sentences and no list: how the setup stands, the one or two changes that help
   most, and anything urgent. What is fine takes one clause; never list it item by item.
3. **What I would do**: the plan of step 8.
4. One line: `report` prints the full report, `details <n>` the exact change of item n.

Start every finding, candidate, item to review, note and plan item with one icon, at the start of
its line or table cell; print this legend once, under the title, so that the weight of each line
shows at a glance:

| icon | meaning |
|---|---|
| 🔴 | high: fix it first |
| 🟠 | medium: worth fixing |
| 🟡 | low: minor |
| 🔵 | a candidate, an item to review, what reading adds, or an action that cannot be undone and runs without a question: no check measured it, your judgement decides |
| ⚪ | a note: for information, nothing to change |
| 🟢 | a section where nothing was found, or an action that already asks |

A plan item carries the icon of the finding it comes from, and 🔵 when it comes from a confirmed
candidate, from what reading adds or from the list at the end of step 3:
never give those a severity of your own.

**The full report**, only on `report`: as Markdown, in this order.

1. **Overview**: files by kind, memory files and their lines, skills, commands, agents, rules,
   hooks; findings by severity; candidates confirmed, dismissed; items to review; notes.
2. **Findings**, high first, then medium, low: the title, `file:line`, what was measured against
   which limit, and what it suggests. Paths as `~/.claude/...` for the user and
   `<project>/...` for a project.
3. **Context**, per place: the total in tokens and the contributors in loading order (user memory,
   project memory, imports and rules, MEMORY.md, skill listing, command listing), each with its
   tokens and share. Say that tokens are bytes divided by 4, an estimate.
4. **Skills**, per group (user, each project): name, lines against `skillLines`, and what was found
   on it; third-party skills marked "do not edit".
5. **Candidates**, with your verdict and its reason.
6. **What reading adds** (step 5), when there is anything.
7. **Asks before what cannot be undone** (end of step 3): per group its rules, 🟢 with the rule or
   hook that covers it, 🔵 when nothing does; and once, that an ask rule is a seat belt, not a lock.
8. **To review** and **Notes**, when there is anything.
9. **Sessions** (step 6): per session its project, the context of its first call, of its last
   call, the number of calls (rows with usage; a reply written in several rows counts more than
   once) and of compactions. Then at most three lines of what follows, from these numbers only:
   the first call against the context of step 4 for that place (the rest is Claude Code's own
   prompt and the tools and MCP servers it offers); sessions whose last call is far above their
   first, or above 400,000 tokens, or compacted, are where a new session would have started
   cheaper. Name no saving in percent: what a change would save is not measured.

With `--json`, add one ```json block after the short view, with absolute paths written with `/`:

```json
{
  "part": 2,
  "findings": [{ "check": "memory-too-long", "severity": "medium", "file": "C:/x/CLAUDE.md", "line": 12 }],
  "candidates": [{ "check": "exception", "file": "C:/x/CLAUDE.md", "line": 30, "verdict": "dismissed" }],
  "review": [{ "check": "mcp-no-permission-rule", "file": "C:/x/.mcp.json", "servers": ["db"] }],
  "notes": [{ "check": "skill-too-long", "file": "C:/home/.claude/skills/x/SKILL.md" }],
  "contextTokens": { "user": 1234, "C:/x": 2345 }
}
```

`line` is null for a finding about a whole file. `contextTokens` has the key `user` for the user
files alone and the project path for each project.

## Step 8. The plan of changes

One numbered list, the most useful change first, at most seven items; when there are more, an
eighth line says how many smaller ones `more` lists. One item per finding, per confirmed
candidate, per item of "What reading adds" you are sure of, per group at the end of step 3 that
nothing covers, and per tip of step 5. Nothing on a third-party skill, a linked skill folder, a
file outside the scope, `~/.claude.json` or a transcript. Each item is one line that a person
understands without the report:

`<icon> <n>. <what will be done, in plain words> — <what the user gets> (<file>)`

as in `🟠 2. Shorten the user CLAUDE.md from 230 to 180 lines — fewer tokens in every session
(~/.claude/CLAUDE.md)` or `🔵 3. Ask before git push and rm — Claude no longer pushes or deletes
without asking (~/.claude/settings.json)`.

Keep for `details <n>`: the file and line, the check id and what was measured, the exact change
(the old lines and the new lines, a new file with its whole content, or for settings the key and
the value to add or change, without printing any other value), and what it does to the context
of step 4, in tokens.

How each kind of suggestion becomes a change (the `Suggests:` line of checks.md):

- `shorten`: rewrite the lines shorter so that every instruction stays; move a long procedure
  into a skill or a rule file with `paths` instead of cutting it.
- `make-rule-file`: a new `.claude/rules/<name>.md` with a `paths` field for the files it is
  about, and the lines removed from the memory file.
- `make-skill`, `make-command`: a new skill or command with a name and a description that says
  when to use it, and the procedure removed from the memory file.
- `make-hook`, `make-setting`: the exact settings entry. A hook command you propose is marked
  "check the command before you say yes"; never write a script for it.
- `move-to-project`, `move-to-user`: the lines removed in one file and added in the other.
- `delete-duplicate`: the later copy removed, the other kept as it is.
- `fix-front-matter`: the corrected field.
- `review-exception`, `review-conflict`: one wording that says which rule wins and when.

A group from the end of step 3: its rules added to the `ask` list under `permissions` in
`<home>/.claude/settings.json`, so that they hold in every project, and never in a project's
settings, which a team may share through git. Create the list, the `permissions` key or the file
when it is missing. Change no allow or deny rule.

Then ask which items to apply: all, some numbers, or none. Stop and wait for the answer. With
`--report-only`, end here and say that nothing was changed.

## Step 9. Apply

Apply the picked items in their order, one file at a time, each after one line that says which
item and which file. A tip that the user carries out (`/init`) is not applied here; repeat it as
the last line.

- Read the file again right before you change it; when the old lines are no longer there, skip
  the item and say why. Never guess another place.
- Edit with the exact old lines. Write only a file that does not exist yet.
- A settings file: Edit one key at a time and keep the JSON valid; never Write it whole, never
  copy it anywhere. Read it after the edit and make sure it still parses. The picked groups of
  step 3's list go into the `ask` list in one Edit.
- Never apply an item the user did not pick, and never add a change that was not in the plan.

## Step 10. Check again

Measure the changed files again with `wc` and run again the checks that had a finding on them,
and the list at the end of step 3 when a group of it was applied.
Then one line per item: applied, skipped (why) or failed, and whether its finding is gone; one
line with the context of each changed place, before and after; and one line on how to undo:
`details <n>` holds the old lines, and a file under git shows its change in `git diff`.
