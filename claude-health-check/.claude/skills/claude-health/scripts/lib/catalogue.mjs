// What each check of the program does, said so that a model can do the same check by reading.
//
// Part 1 of this package is the program (scan.mjs, checks.mjs): it measures and finds without a
// model. Part 2 is the prompt skill in .claude/skills/claude-health-prompt: a model runs the same
// checks with Read, Glob, Grep and wc. The two agree because everything they share comes from one
// place: the ids and their lists from checks.mjs, the numbers from lib/facts.mjs, the titles and
// reasons from lib/strings.mjs, and from this file how each check measures and how severe it is.
// scripts/prompt-catalogue.mjs renders all of it into the checks.md of part 2, and a test fails
// when that file is not what the renderer makes. checks.mjs refuses a severity this file does not
// allow, so the program cannot drift from what the prompt is told either.
//
// `measure` is read by a model, so it is English, and it names limits as {limitName} from LIMITS.

export const CATALOGUE = {
  // --- findings: what a program can prove ---------------------------------------------------
  'memory-too-long': {
    severity: ['medium', 'high'],
    limit: 'memoryFileLines',
    kind: 'shorten',
    measure:
      'For every memory file (CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md, a CLAUDE.md in a subfolder; not an imported file) count its lines. Over {memoryFileLines} lines is a finding: medium, high from twice that. Point at the first line of the largest section and name the three largest sections with their line counts.',
  },
  'memory-too-large': {
    severity: ['high'],
    kind: 'shorten',
    measure:
      'A memory file over {memoryFileBytes} bytes is skipped by Claude Code: high. Such a file is not loaded, so no other check looks at its lines.',
  },
  'always-loaded-total': {
    severity: ['medium'],
    limit: 'alwaysLoadedLines',
    kind: 'make-rule-file',
    measure:
      'Per place (the user files alone, then each project) add up the loaded lines of every file that loads at session start there: memory files, the files they import, rule files without a paths pattern, and AGENTS.md where no memory file stands. Loaded lines leave out block-level HTML comments. Over {alwaysLoadedLines} lines is a finding on the first file of that place, naming the three largest contributors. When the user files alone are over, do not repeat the finding for each project.',
  },
  'duplicate-within': {
    severity: ['low'],
    kind: 'delete-duplicate',
    measure:
      'Inside one loaded file, an instruction line that appears again: compare lines after removing the list marker, *, _ and backticks, collapsing spaces, dropping trailing . ; : ! and lowering the case. Only lines of at least 3 words and 12 characters count. The second occurrence is the finding; name the line of the first.',
  },
  'duplicate-across': {
    severity: ['low'],
    kind: 'delete-duplicate',
    measure:
      'A line of a project file that is equal, compared as in duplicate-within, to a line of a user file that loads in the same place. The project line is the finding; the user line is the original.',
  },
  'same-line-in-projects': {
    severity: ['low'],
    kind: 'move-to-user',
    measure:
      'A line, compared as in duplicate-within, that stands in the loaded files of two or more projects and in no user file. One finding per line, at its first project, listing the other places.',
  },
  'skill-no-description': {
    severity: ['medium'],
    kind: 'fix-front-matter',
    measure: 'A SKILL.md whose front matter has no description, or an empty one.',
  },
  'skill-name-mismatch': {
    severity: ['low'],
    kind: 'fix-front-matter',
    measure: 'A SKILL.md whose front matter name is set and differs from the name of its folder. Point at the name line.',
  },
  'skill-too-long': {
    severity: ['medium'],
    kind: 'shorten',
    measure: 'A SKILL.md over {skillLines} lines.',
  },
  'skill-description-too-long': {
    severity: ['medium'],
    limit: 'skillDescriptionChars',
    kind: 'fix-front-matter',
    measure: 'A skill whose description and when_to_use together are over {skillDescriptionChars} characters. Point at the description line.',
  },
  'skill-copies-differ': {
    severity: ['low'],
    kind: 'delete-duplicate',
    measure:
      'A skill of a project with the same folder name as a user skill, where the two SKILL.md files differ (ignore line endings; cmp -s tells, or compare after reading both). Copies that are equal are not a finding.',
  },
  'skill-unreachable': {
    severity: ['medium'],
    kind: 'fix-front-matter',
    measure: 'A SKILL.md with both disable-model-invocation: true and user-invocable: false. Point at the disable-model-invocation line.',
  },
  'front-matter-unreadable': {
    severity: ['low'],
    kind: 'fix-front-matter',
    measure:
      'A skill, command, agent or rule file that opens a front matter block (--- on the first line) that is not readable YAML or never closes. Such a file gets no other front matter check.',
  },
  'command-no-description': {
    severity: ['low'],
    kind: 'fix-front-matter',
    measure: 'A command file (.claude/commands/**/*.md) without a description in its front matter.',
  },
  'agent-no-description': {
    severity: ['low'],
    kind: 'fix-front-matter',
    measure: 'An agent file (.claude/agents/*.md) without a description in its front matter.',
  },
  'settings-invalid-json': {
    severity: ['high'],
    kind: 'make-setting',
    measure:
      'A settings.json, settings.local.json or .mcp.json that does not parse as JSON, or whose top level is not an object. Say where the parser stops; never quote the file.',
  },
  'hook-missing-file': {
    severity: ['medium'],
    kind: 'make-setting',
    measure:
      'A command hook whose script does not exist. The script is the first word of the command, or the word right after an interpreter (bash, sh, zsh, node, python, python3, pwsh, powershell, ruby, deno, bun), when it ends in .sh .bash .zsh .py .js .mjs .cjs .ts .rb .ps1 .cmd .bat .pl .php. ~, $HOME and %USERPROFILE% resolve to the home folder, $CLAUDE_PROJECT_DIR to the project, a relative path to the project; a relative path in user settings and any other variable cannot be resolved and are skipped, as is a word with a wildcard. One finding per event and script; show the program and the script, never the rest of the command.',
  },
  'hook-unknown-event': {
    severity: ['low'],
    kind: 'make-setting',
    measure:
      'A key of "hooks" in settings that is not one of: {hookEvents}. Call it outside the list this check knows, never wrong.',
  },
  'import-unresolved': {
    severity: ['medium'],
    kind: 'shorten',
    measure:
      'An @path import in a memory file (outside code spans and fenced blocks) that resolves to no file. A relative path resolves against the folder of the file that holds it, ~ to the home folder. A bare @word without a slash or an extension is an import only when that file exists, so it is never a finding.',
  },
  'import-too-deep': {
    severity: ['medium'],
    limit: 'importHops',
    kind: 'shorten',
    measure:
      'An import reached at more than {importHops} hops from a memory file: the import of a memory file is hop 1, an import inside that file hop 2, and so on.',
  },

  // --- candidates: what the wording of a line suggests --------------------------------------
  'conflict-candidate': {
    severity: null,
    kind: 'review-conflict',
    measure:
      'Two instruction lines that load in the same place, from different sections, where one asks for something (always, must, use, prefer, should; vždy, musí, použi, používaj, preferuj) and the other forbids it (never, do not, must not, avoid; nikdy, nesmie, nepoužívaj, nerob, vyhni sa), with at least two words of 3 letters or more in common. A pair whose two files were already compared in an earlier place is not listed again. Report a pair at its later line and name the other one: a project file comes after a user file, then files go by their path as shown (~/.claude/..., <project>/...), then lines by number. At most {conflictPairsPerLine} pairs per line and {conflictPairsPerPlace} per place; count the rest and say how many were left out.',
  },
  exception: {
    severity: null,
    kind: 'review-exception',
    measure:
      'An instruction line with except, unless, but not, only when, only if (okrem, s výnimkou, pokiaľ nie, iba ak, len ak, iba keď, len keď, výnimka). A line that opens with the marker (- Unless the file is a lockfile.) limits the line before it: report the candidate at that line before, spanning both lines.',
  },
  'procedure-in-memory': {
    severity: null,
    kind: 'make-skill',
    measure:
      'A block of {procedureSteps} or more numbered steps (1. or 1) or Step N / Krok N) in a memory file, outside code blocks.',
  },
  'repeated-request': {
    severity: null,
    kind: 'make-command',
    measure:
      'A line that maps a phrase to an action: when / whenever / if / every time I say, type, write, ask (keď, ak, kedykoľvek, zakaždým keď, vždy keď ... poviem, napíšem, zadám, pošlem).',
  },
  'automation-in-memory': {
    severity: null,
    kind: 'make-hook',
    measure:
      'A clause that says when (always, after, before, every time, whenever, on save, on commit; vždy, po každ-, pred každ-, pri každ- with any ending (po každej, pred každým), zakaždým, kedykoľvek, po úprave, po zmene, pri uložení) and tells Claude to run a tool as an imperative: run, execute, lint, format, test, typecheck, build (spusti, pusti, naformátuj, zlintuj, otestuj, zostav) with tests, a linter, a formatter, a build or a command as its object. A line that is a repeated-request is not also this.',
  },
  'permission-in-prose': {
    severity: null,
    kind: 'make-setting',
    measure:
      'A line that forbids a command: never / do not / must not run or execute <command>, or use or call a `command in backticks` whose first word is a known command (git, rm, npm, docker, kubectl, terraform, curl and the like); Slovak nespúšťaj, nepúšťaj, nepoužívaj, nevolaj. With without asking / without confirmation (bez opýtania, bez súhlasu) it wants an ask rule, otherwise a deny rule, written Bash(<command> *). Not a candidate when a rule of the settings that apply (user settings everywhere, project settings in that project) already covers the command: Bash, Bash(*) and Bash(<prefix> *) or Bash(<prefix>:*) cover it; for ask, an ask or a deny rule counts. Say only the list and the rule this line wants, never the other rules.',
  },
  'project-specific-in-user': {
    severity: null,
    kind: 'move-to-project',
    measure:
      'A line of a user file that names exactly one checked project by its folder name (4 letters or more), or, with two or more projects checked, names a path that exists in exactly one of them, or a stack word that only one project has (npm with package.json, cargo with Cargo.toml, pytest with pyproject.toml, and so on).',
  },
  'skill-no-when-cue': {
    severity: null,
    kind: 'fix-front-matter',
    measure:
      'A skill with a description, no when_to_use and no disable-model-invocation: true, whose description has no "use when / when the user / trigger / should be used / použi / keď" wording.',
  },

  // --- to review: proposes no change --------------------------------------------------------
  'mcp-no-permission-rule': {
    severity: null,
    kind: null,
    measure:
      'A server named in a project .mcp.json (read the server names only) that no permission rule of the user or that project names as mcp__<server> or mcp__<server>__<tool>. The user-level ~/.claude.json is never read.',
  },
};
