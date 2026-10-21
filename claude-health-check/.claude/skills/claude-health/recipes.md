# Recipes: the draft of a change, by kind

Reference for the wizard of `SKILL.md`. Read the section `@@need` names under `kind`, and the
first section always. Nothing here is run: a draft is a file, and `ui.mjs` does the rest.

## What a draft is

A draft is one JSON file, written to the path `@@need` gives as `draft`. It lists the steps of
one change. `ui.mjs card` draws the card from it, and `ui.mjs apply` carries out exactly those
steps, so the user approves what will be written.

```json
{
  "steps": [
    { "op": "write-new", "file": "<full path>", "content": "<the text you wrote>", "moves": true },
    { "op": "remove" }
  ],
  "note": "<optional: one caution the user should read on the card>"
}
```

The steps:

| Step (`op`) | What it does | Fields |
|---|---|---|
| `write-new` | creates a file that does not exist yet: a skill, a command, a rule file, a hook script, or a memory file that is missing | `file`, `content`; `moves: true` puts the removed lines after `content`, unchanged |
| `append` | adds lines to the end of an existing file | `file`, `content` and/or `moves: true` |
| `merge-settings` | adds hook entries (`hooks`) and permission rules (`permissions.allow`, `.ask`, `.deny`) to a settings file; a patch with another key, or one that would change or remove what is there, is refused | `file`, `patch` (a JSON object) |
| `remove` | removes lines | nothing: the lines the finding quotes. Or `from` and `to` (and `file` when it is another file) |
| `replace` | replaces lines with new text | `content`; the lines as for `remove` |
| `by-hand` | the user edits a file this tool does not write | `file`, `text`: what to change, in the user's language |

Rules for every draft:

- **Paths are copied, never built.** `@@need` gives `file` (where the finding is), `settings`
  (the settings file that goes with it) and `draft`. A new file goes under the `.claude` folder
  next to that settings file: `.../skills/<name>/SKILL.md`, `.../rules/<topic>.md`,
  `.../hooks/<name>.sh`. The script refuses a target outside the Claude Code setup; do not look
  for another way.
- **Lines you did not write are moved, not retyped.** Use `remove` together with `moves: true`
  on the step that receives them. Write only what is new: front matter, a heading, a reworded
  line. The card then says "moved unchanged" for the user's own lines and shows yours in full.
- **`from` and `to` are today's line numbers.** Earlier changes move lines. `@@need.line` and
  `@@need.endLine` are current; read the file again before you use any other number.
- **Keep it short.** What you write is shown on the card in full. A card is one screen.
- **One scope per change.** A step that touches a second project or the user files is shown on
  the card by its path; add one only when the change needs it.
- **Text for Claude is English.** Skills, commands, rule files and hook scripts you draft are in
  English. `note` and the `text` of a by-hand step are in the user's language.
- **A change you cannot draft** without a fact only the user has: ask for the fact. Do not guess.
- **No step deletes a file, replaces one, or writes into a third-party skill.** There is no
  such step, and the script refuses a target in the folder of a skill the reports mark
  "third-party". A draft is one change of one card: never put a second finding into it.

When the user answers "Other" on a card, rewrite the same draft file and run `card` again.

## make-skill

A numbered procedure, or a long reference section, leaves the memory file and becomes a skill:
its content then loads only when the skill is used.

```json
{ "steps": [
  { "op": "write-new", "file": "<.claude folder of the finding>/skills/release-procedure/SKILL.md",
    "content": "---\nname: release-procedure\ndescription: Releases a new version step by step. Use when the user asks to release, cut a version or ship it.\n---\n\n",
    "moves": true },
  { "op": "remove", "from": 27, "to": 34 }
] }
```

- `name` equals the folder name. `description` says what the skill does and when to use it
  ("Use when ..."); together with `when_to_use` it stays under 1,536 characters. A `SKILL.md`
  stays under 500 lines.
- Take the heading of the block and the blank line after it along: give `from` and `to` so that
  the heading above the quoted lines moves with them.

## make-command

A command is a skill invoked as `/name`. Draft it like `make-skill`, with a short name. When
the user wants it to run only when they type it, add `disable-model-invocation: true` to the
front matter. Remove the line that described the request.

## make-hook

A line that says a fixed command has to run on an event becomes a hook: an entry under `hooks`
in the settings file. This is its shape:

```json
{ "steps": [
  { "op": "merge-settings", "file": "<@@need.settings>",
    "patch": { "hooks": { "PostToolUse": [ { "matcher": "Write|Edit",
      "hooks": [ { "type": "command", "command": "npx prettier --write ." } ] } ] } } },
  { "op": "remove" }
] }
```

- **Event and matcher.** "After editing / after each change / on save" is `PostToolUse` with
  the matcher `Write|Edit`. "Before a command / before committing" is `PreToolUse` with the
  matcher `Bash`; it then runs before every shell command, so the command has to be cheap or
  check for its own case. "At the start of a session" is `SessionStart`, with no matcher. For
  anything else, tell the user that the line cannot be mapped to an event, point to the hooks
  guide (https://code.claude.com/docs/en/hooks-guide.md) and skip. Never write a `PreToolUse`
  or `PostToolUse` hook without a matcher.
- **The command.** When `@@need.data.command` is there, the line quoted it: use that. When it
  is not, ask the user for the exact command; do not make one up.
- **A helper script**, only when the command does not fit on one line: one more step,
  `write-new` of `<.claude folder>/hooks/<name>.sh`, called from the command
  (`sh ~/.claude/hooks/<name>.sh`, or `sh "$CLAUDE_PROJECT_DIR"/.claude/hooks/<name>.sh` in a
  project). A `PreToolUse` hook blocks the action by ending with exit code 2.
- The card names a hook that already sits on the same event and matcher, and offers to keep
  the line as a reminder. The command is on the card in full; the yes is the user's.

## make-setting

"Never run `<command>`" becomes a permission rule. When the line is a `permission-in-prose`
candidate that you confirmed with this kind, the script drafts the change itself from the rule
the candidate carried; you write a draft only when the user wants it different, or for a finding
of your own.

```json
{ "steps": [
  { "op": "merge-settings", "file": "<@@need.settings>", "patch": { "permissions": { "deny": [ "Bash(git push --force *)" ] } } },
  { "op": "remove" }
] }
```

A rule is `Tool` or `Tool(specifier)`; a Bash rule matches the whole command text, with `*` for
any text. `deny` blocks, `ask` asks every time; deny wins over ask, ask over allow. The rule
names the command the line names, no less: a rule for `git` alone would block every git command.

## make-rule-file

Text that only matters for some files moves into a rule file with a `paths` list, so it loads
only when matching files are read.

```json
{ "steps": [
  { "op": "write-new", "file": "<.claude folder of the finding>/rules/api.md",
    "content": "---\npaths:\n  - \"src/api/**\"\n---\n\n", "moves": true },
  { "op": "remove", "from": 40, "to": 58 }
] }
```

Ask the user which paths the text is about when the text does not say. For the finding "too
much loaded at every session start", propose the largest section that is about one part of the
code; if there is none, say so and skip.

## shorten

Two shapes:

- **A shorter wording** of the quoted lines: `{ "steps": [ { "op": "replace", "content": "- Use two-space indentation." } ] }`.
  Agree on the wording with the user first when the meaning could change.
- **A file over the recommended size**: move its largest section out, as a skill (reference
  material, a procedure) or a rule file (text about some paths). `@@need.quote` is the heading
  of the largest section. Draft it like `make-skill` or `make-rule-file`.

For an import that does not resolve, or a chain of imports that is too deep: `replace` the
line with the corrected import, or `remove` it; ask the user which.

## move-to-project and move-to-user

The script drafts these itself: the line is added to the memory file of the project (or of the
user) and removed where it was. For `move-to-project` it does so when the line is a
`project-specific-in-user` candidate that you confirmed with this kind: the candidate names the
project. Write a draft when the user wants another target, or for a finding of your own.

## delete-duplicate

The script drafts the removal of a repeated line itself. For copies of one skill that differ,
it shows a by-hand card: this tool deletes no file and does not say which copy Claude Code uses.

## fix-front-matter

`replace` on the front matter lines, or on the one line the finding quotes.

```json
{ "steps": [ { "op": "replace", "from": 1, "to": 3,
  "content": "---\nname: tidy-notes\ndescription: Tidies meeting notes into decisions and actions. Use when the user pastes notes.\n---" } ] }
```

A skill, command or agent without a description: write one from what its body does, and say
on the card (`note`) that you inferred it. Read that one file to do it.

## review-exception

The script shows the rule and asks whether its exception still holds; nothing is drafted. When
the user says it does not, draft the rule without it:

```json
{ "steps": [ { "op": "replace", "content": "- Use British spelling in documentation." } ] }
```

## review-conflict

The script drafts this one: both lines in full, and one answer per line to keep. Write a draft
only when the user wants a wording that scopes both lines; then `replace` one of them.

## by-hand

For a file this tool does not write (an imported document outside the setup, a settings file
that needs something removed), tell the user what to change:

```json
{ "steps": [ { "op": "by-hand", "file": "<full path>", "text": "<what to change, from the finding alone>" } ] }
```

Do not open a settings file to write that text: say what the finding says (the event, the
script, the position of the error).

## flow

Branches for the diagram of one skill. Only for a skill this run created, or one the user asks
about. Write `flow.json` into the drafts folder:

```json
{ "skill": "<full path of its SKILL.md>",
  "branches": [
    { "at": "s2", "question": "Is a required column missing", "yes": "List the missing columns and stop",
      "no": "Check the date format", "quote": "<the exact text of the line the branch was read from>", "line": 21 }
  ] }
```

- Run `flow` once with `"branches": []`: `@@flow` lists the steps a program read, each with its
  `id` and `line`. `at` is the id of the step the question follows.
- `quote` is the exact text of `line` (to `endLine` for several lines). No quote, no branch.
- `no` may be left out: "no" then leads straight on.
- The file holds the whole list for that skill; a later run replaces the earlier one.
- A skill with no numbered list and no step headings has no diagram. Say so; do not invent steps.
