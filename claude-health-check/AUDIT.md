# Audit by classes of bugs — 2 October 2026

Why: two rounds of independent review and repair kept finding the same thing. A repair fitted the
reported example, and the next reviewer produced the same failure one module further. Of 19
blocking findings, 4 came back under a variation; of 6 new problems, 3 were introduced by the
repair itself. That is a property of how the code is built, not of single lines, so this audit
looks for shapes and asks of each: is there a test that closes the class?

Input: the two review rounds, the verification, the first end-to-end run of the wizard by a model
(41 findings and 19 places where the prompt left the model guessing), and the code as of commit
`bc7c3e2` (11,900 lines of code, 11,100 lines of tests, 404 tests).

Nothing was refactored. The contracts added are in `tests/audit.test.mjs`; each was seen failing
on an injected fault.

## Classes that are closed

| class | what closes it | where |
|---|---|---|
| text from a scanned file reaches a terminal, a picker or a path | one function makes it printable, and a fixture with a hostile value in every place a file can put one is run through every screen | `tests/hostile.test.mjs` |
| text from a scanned file reaches the HTML report | the report is checked structurally: allowed tags and attributes only, no address, no handler | `tests/helpers/html.mjs`, `tests/report.test.mjs` |
| two files get the same label | the property itself is tested over a thousand made-up folder layouts | `tests/places.test.mjs` |
| a word match is reported as a fact | findings and candidates are two disjoint lists; the function that adds one throws for the other | `tests/checks.test.mjs`, `tests/package.test.mjs` |
| "what it changes" drifts from what the code can write | the list is generated from the table the writer uses, and every "never" is tried through the entry points | `tests/promise.test.mjs` |
| a number shown as documented that nobody read | a number carries its source or says it is a tool default | `tests/package.test.mjs` |
| a message that guesses | hedged wording exists only in candidate strings; findings state what was measured | by the two lists above |
| a limit that nothing applies | all 13 limits are used outside the module that defines them | checked by hand, no test |
| a fact about the surroundings is read on the spot (class 1 below) | one module reads the environment and the streams, and the launcher and `ui.mjs` ask it; the two features that needed the most facts are cut | `tests/audit.test.mjs`, `tests/surroundings.test.mjs`, `tests/launcher.test.mjs` |

## Classes that are open

Class 1 is closed since the first step of the refactor; its description stays, because it says
what the contract is there to prevent.

### 1. Facts about the surroundings were read on the spot — 8 findings — closed

Is this a terminal, is the window big enough, is this Git Bash, is this a session. The launcher
decides each inline (`bin/claude-health.mjs`, five decisions in fifteen lines) from nine
variables, next to the twelve that `lib/term.mjs` reads. Three variables are read in two modules
and answer two different questions: `MSYSTEM` means "there is a terminal" in one and "this is Git
Bash" in the other, and a cmd window started from Git Bash carries it too.

Findings of this class: the repaint in a window that cannot hold a page, its variation with a long
typed line, the regression after a resize; the hand-typed command under Git Bash and its two
variations; "no tokens" said inside a session, and its variation.

How it was closed: `lib/surroundings.mjs` is the only reader of the environment and of what a
stream says about its other end, and answers every question once (somebody is looking, colour,
Unicode, the width, inside a session, the language of the system, how a command is shown so
that it can be pasted). Two of the four questions are no longer asked at all, because the
features that asked them are cut: the size of the window (nothing is repainted) and which shell
this is (no command is printed with an argument). Contract: the table of who reads which
variable is exact (`the environment is read only where this table says`), and one reader per
fact is an ordinary test (`a fact about the surroundings has one reader`), which also covers
the properties of the streams.

### 2. The walk keeps values longer than they are true — 6 findings

`ui.mjs` (1,279 lines) keeps seven keys between calls. The queue is computed when the reading is
merged and shown many cards later: the count on "skip the rest of this file" and the line numbers
in its preview are from then. The digest of a shown card covers the lines of its step, not the
file, so an answer is accepted after the file changed elsewhere, and not at all for a settings
merge. A by-hand card recorded "done" without looking whether anything changed.

Contract now: every key the walk keeps has a stated lifetime (`every key the walk keeps between
calls has a stated lifetime`). What it does not close: whether a value is shown after it stopped
being true. That needs the walk to recompute what it shows from the files at each call, which is
the refactor.

### 3. A refusal is the end of the run — 4 findings, 23 places

The prompt tells the wizard: if the script fails, show the message and stop. 23 of the 32 refusals
in `ui.mjs` do not say what to run next. The first end-to-end run met four of them.

Contract now: a ceiling of 23 that may only go down (`the refusals … do not grow`).

### 4. The prompt and the script describe the same procedure twice — 19 places

`SKILL.md` (335 lines) and `recipes.md` (229 lines) tell the wizard what to run; the script prints
what to run. Where they disagreed, the model had to guess: 19 places in one run. The existing test
checks that every picker option has a next command, not that the prose agrees with it.

Cannot be closed by a test over the source. It closes when the script decides everything a program
can decide and prints the next command in every answer, so the prompt carries only what needs
reading and judgement — and gets shorter.

### 5. Code that has only ever run on one machine

Every run of the suite so far: Windows 11, Node 24, Git Bash. The package says Node 20 and newer
and ships a shim for sh. Never run: Node 20 and 22 (`tests/index.js` exists for exactly that),
macOS and Linux (two tests are skipped here because this file system has no permission bits, and
the first commit recorded the sh shim as not executable — the package's own test caught it).

Cannot be closed on this machine. It closes with a matrix run (three systems, three Node
versions) the day the repository has somewhere to run one.

## What to cut rather than repair

Counted by the findings each feature produced:

| feature | findings | what is lost without it |
|---|---|---|
| the shims start the browser and Claude Code | 5 (quoting under cmd, path conversion under Git Bash in three forms, programs of the scanned repository run by the cmd shim) | the person types the two printed lines instead: `claude` in the folder of the tool, the slash command inside it |
| in-place repaint, single-key answers, the tab viewer | 4 (three window sizes and a resize) | panels are printed one after another and questions are answered by a number; colour, bars and panels stay |
| the settings merge | 2 (the file is rewritten, a credential is copied into the backup) | a hook or a permission rule becomes a card the person applies by hand, with the exact text to paste |

The first two remove class 1 almost whole. Both are cut: the shims start node and nothing else,
and the launcher prints every block once, asks by number and ends with the link to report 1 and
the two lines that continue in Claude Code. The third is not cut yet.

## Order for the refactor (size M, step 1 done)

1. Done. One module answers every question about the surroundings; the launcher asks it. The
   `todo` contract is an ordinary test.
2. The walk recomputes what it shows from the files at every call; the digest covers the file.
3. Every refusal ends with the next command; lower the ceiling to zero.
4. Move procedure out of the prompt into what the script prints.

**Decision, 5 October 2026: the refactor stops after step 1.** Steps 2 to 4 were priced at four
to eight agents and two to five million tokens, with a likely extra round of review on top. The
check and the reports carry the value and are done; the walk of changes is marked experimental
in the README instead. Steps 2 to 4 stay here as the order to follow if the walk is taken up
again.
