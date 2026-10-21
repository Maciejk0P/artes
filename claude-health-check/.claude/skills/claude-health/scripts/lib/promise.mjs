// "What it changes / what it never changes": the two short lists a person meets before the tool
// does anything, in the launcher, in the session and in the README.
//
// The lists are data, not prose, so that they cannot drift from the code:
//   - every line of CHANGES names the kinds of file and the writes it stands for. Together they
//     must be exactly the table of writes in lib/targets.mjs, and they must cover every kind of
//     change (lib/kinds.mjs) and everything a change can create. A test compares them, so a new
//     write target or a new kind of change fails the suite until it has a line here.
//   - every key of NEVER has a test that tries the thing through the entry points and sees it
//     refused (tests/promise.test.mjs).
// The sentences themselves are in lib/strings.mjs, under ui.promise.*, in both languages.

// Changed only after a yes to that one change, and with a backup first.
export const CHANGES = [
  {
    // Memory files and rule files: the lines the card shows are removed, shortened or moved.
    key: 'memory',
    shapes: ['memory', 'rule'],
    writes: ['remove-lines', 'replace-lines', 'append-lines'],
    kinds: ['shorten', 'move-to-project', 'move-to-user', 'delete-duplicate', 'review-exception', 'review-conflict'],
    creates: [],
  },
  {
    // The person's own skills, commands and agents: front matter fixed, or the file shortened.
    key: 'own',
    shapes: ['skill', 'command', 'agent'],
    writes: ['remove-lines', 'replace-lines', 'append-lines'],
    kinds: ['fix-front-matter', 'shorten', 'delete-duplicate'],
    creates: [],
  },
  {
    // New files: a skill, a command, a rule file, a hook script, a memory file that is missing.
    key: 'new',
    shapes: ['skill', 'command', 'rule', 'hook-script', 'memory'],
    writes: ['write-new'],
    kinds: ['make-skill', 'make-command', 'make-rule-file', 'make-hook', 'move-to-project', 'move-to-user'],
    creates: ['skill', 'command', 'rule-file', 'file'],
  },
  {
    // Settings: a hook or a permission rule is added; nothing is removed. `adds` names the keys
    // of a settings file a merge may add to; the table that enforces it is SETTINGS_ADDS.
    key: 'settings',
    shapes: ['settings'],
    writes: ['merge-settings'],
    kinds: ['make-hook', 'make-setting'],
    creates: ['hook', 'setting'],
    adds: ['hooks', 'permissions'],
  },
];

// Written without asking: the tool's own folder under <home>/.claude, and nothing else.
export { HEALTH_FOLDER as OWN_FOLDER } from './paths.mjs';

// Never changed, whatever asks for it.
export const NEVER = ['outside', 'unconfirmed', 'existing', 'overwrite', 'third-party', 'mcp', 'sessions', 'git'];
