// Every number, name and format the checks rely on, with the documentation page it was read from.
//
// A value with `documented: true` carries the page (`source`) and the sentence it comes from
// (`quote`). A value with `documented: false` is NOT from the documentation: it is a default of
// this tool, labelled as such wherever it is shown.
//
// The pages were read on the date in FACTS.checkedOn. A documented value that was NOT among the
// answers read on that date says so with `verified: false`, and is shown as carried over, never
// as read on that date. When Claude Code changes, this is the one file to check again; nothing
// else in the package states a documented fact.

export const SOURCES = {
  memory: 'https://code.claude.com/docs/en/memory.md',
  skills: 'https://code.claude.com/docs/en/skills.md',
  hooks: 'https://code.claude.com/docs/en/hooks-guide.md',
  permissions: 'https://code.claude.com/docs/en/permissions.md',
  settings: 'https://code.claude.com/docs/en/settings.md',
  mcp: 'https://code.claude.com/docs/en/mcp.md',
};

export const LIMITS = {
  memoryFileLines: {
    value: 200,
    documented: true,
    source: SOURCES.memory,
    quote: 'Size: target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence.',
  },
  memoryFileBytes: {
    value: 4 * 1024 * 1024,
    documented: true,
    source: SOURCES.memory,
    quote: 'Claude Code loads a CLAUDE.md file of up to 4 MiB in full and skips a larger file.',
  },
  importHops: {
    value: 4,
    documented: true,
    source: SOURCES.memory,
    quote: 'Imported files can recursively import other files, with a maximum depth of four hops.',
  },
  // Carried over from the first pass with its page; it was not among the answers checked again
  // on FACTS.checkedOn, and every place that shows it says so.
  skillLines: {
    value: 500,
    documented: true,
    verified: false,
    source: SOURCES.skills,
    quote: 'Keep SKILL.md under 500 lines.',
  },
  skillDescriptionChars: {
    value: 1536,
    documented: true,
    source: SOURCES.skills,
    quote: 'Character cap per description: 1,536 characters (combined description + when_to_use).',
  },
  autoMemoryLines: {
    value: 200,
    documented: true,
    source: SOURCES.memory,
    quote: 'The first 200 lines of MEMORY.md, or the first 25KB, whichever comes first, are loaded at the start of every conversation.',
  },
  // The page says "25KB"; read here as 25,000 bytes.
  autoMemoryBytes: {
    value: 25000,
    documented: true,
    source: SOURCES.memory,
    quote: 'The first 200 lines of MEMORY.md, or the first 25KB, whichever comes first, are loaded at the start of every conversation.',
  },
  skillListingBudgetPercent: {
    value: 1,
    documented: true,
    source: SOURCES.skills,
    quote: "Budget scale: 1% of the model's context window.",
  },
  // The documentation gives a per-file target only. It says a warning is shown when files add up
  // past a combined limit and gives no number for it, so this is a default of this tool (two
  // files at the per-file target).
  alwaysLoadedLines: { value: 400, documented: false, source: null },
  // How many steps make a numbered block a procedure rather than a short list.
  procedureSteps: { value: 4, documented: false, source: null },
  // Tokens are shown as bytes divided by this: a rough estimate for display only.
  bytesPerToken: { value: 4, documented: false, source: null },
  // Pairs of lines that may contradict each other are found by shared words, and every listed
  // pair has to be read. These two bound the list: how many pairs one line may be part of, and
  // how many pairs are listed for one place. What is over is counted and said, not listed.
  conflictPairsPerLine: { value: 3, documented: false, source: null },
  conflictPairsPerPlace: { value: 30, documented: false, source: null },
};

// Every hook event name of the hooks guide. A name outside this list is reported as "not in the
// list this tool knows", never as wrong: a newer Claude Code may know more.
export const HOOK_EVENTS = [
  'SessionStart',
  'Setup',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'MessageDisplay',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'Elicitation',
  'ElicitationResult',
  'SessionEnd',
];

// A permission rule that names an MCP server: the whole server, one of its tools, or all of
// them. The shape leaves no room for free text, so such a rule can be kept where every other
// rule is only counted.
export const MCP_RULE = /^mcp__[\w.-]+(?:__[\w.*-]+)?$/;

// "Each hook has a `type` that determines how it runs." (hooks guide)
export const HOOK_TYPES = ['command', 'http', 'mcp_tool', 'prompt', 'agent'];

// "Here are all documented fields" of the SKILL.md front matter (skills page).
export const SKILL_FRONT_MATTER_FIELDS = [
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'hooks',
  'paths',
  'shell',
  'metadata',
  'license',
  'compatibility',
];

export const FACTS = {
  checkedOn: '2026-10-01',

  hooks: {
    source: SOURCES.hooks,
    // { "<Event>": [ { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] }
    shape: 'event > matcher group > hooks[] > { type, command | url | ... }',
    // "For PreToolUse permission decisions, the most restrictive answer applies, in the order
    // deny, defer, ask, allow." A PreToolUse hook blocks by exit code 2 or permissionDecision "deny".
    preToolUseDecisions: ['deny', 'defer', 'ask', 'allow'],
  },

  permissionRules: {
    source: SOURCES.permissions,
    quote: 'Permission rules follow the format `Tool` or `Tool(specifier)`. Bash rules match the whole command text, with `*` standing in for any text.',
    format: 'Tool or Tool(specifier)',
    wildcard: '*',
    // "mcp__puppeteer matches any tool provided by the puppeteer server;
    //  mcp__puppeteer__puppeteer_navigate matches the puppeteer_navigate tool."
    mcp: { server: 'mcp__<server>', anyTool: 'mcp__<server>__*', tool: 'mcp__<server>__<tool>' },
    // "deny takes precedence, then ask, then allow"
    evaluation: ['deny', 'ask', 'allow'],
    lists: ['allow', 'ask', 'deny'],
  },

  rules: {
    source: SOURCES.memory,
    quote: 'Rules without a `paths` field are loaded unconditionally and apply to all files. Path-scoped rules trigger when Claude reads files matching the pattern, not on every tool use.',
    withoutPaths: 'launch',
    withPaths: 'on-demand',
  },

  imports: {
    source: SOURCES.memory,
    quote: 'Import parsing skips Markdown code spans and fenced code blocks. To mention a path in your CLAUDE.md without importing it, wrap it in backticks.',
    skipsCode: true,
    // Imports "don't reduce context, since imported files load at launch".
    loadAtLaunch: true,
  },

  comments: {
    source: SOURCES.memory,
    quote: 'Block-level HTML comments in CLAUDE.md files are stripped before the content is injected.',
    stripped: true,
  },

  nestedMemory: {
    source: SOURCES.memory,
    // CLAUDE.md files in subdirectories load when Claude reads files there, not at launch.
    loads: 'on-demand',
  },

  agentsMd: {
    source: SOURCES.memory,
    // AGENTS.md (and .claude/AGENTS.md) is read when the working directory and the folders above
    // it hold no CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md.
    names: ['AGENTS.md', '.claude/AGENTS.md'],
    readWhenMissing: ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'],
    since: '2.1.277',
  },

  memoryExcludes: {
    source: SOURCES.memory,
    // Globs matched against absolute paths, in any settings layer; the arrays of all layers
    // combine. Files of a managed policy cannot be excluded.
    setting: 'claudeMdExcludes',
  },

  autoMemory: {
    source: SOURCES.memory,
    // <home>/.claude/projects/<project>/memory/MEMORY.md
    index: 'MEMORY.md',
  },

  skillListing: {
    source: SOURCES.skills,
    quote: 'Adjust the budget with settings: `skillListingBudgetFraction`, `skillListingMaxDescChars`',
    settings: ['skillListingBudgetFraction', 'skillListingMaxDescChars'],
  },

  projectSkills: {
    source: SOURCES.skills,
    quote: 'Claude Code loads project skills from `.claude/skills/` in the directory where you start it and in every parent directory up to the repository root.',
    folder: '.claude/skills',
  },

  settings: {
    source: SOURCES.settings,
    quote: 'Managed settings → Command line → Project local → Shared project → User. A key set at a higher level overrides the same key set lower down.',
    // Highest first.
    precedence: ['managed', 'command-line', 'project-local', 'project', 'user'],
    // "Array values such as permission rules merge across layers."
    arraysMerge: true,
  },

  mcp: {
    source: SOURCES.mcp,
    quote: 'Project-scoped | `.mcp.json` file in project root. User-scoped | `~/.claude.json`.',
    projectFile: '.mcp.json',
    // Named so the rule is visible: this tool never reads it.
    userFile: '~/.claude.json',
  },

  placement: {
    source: SOURCES.memory,
    quote: 'If an entry is a multi-step procedure or only matters for one part of the codebase, move it to a skill or a path-scoped rule instead.',
  },
};

// Marker files whose presence at a project root says which stack the project uses.
// Only existence is checked; the files are never read.
export const STACK_MARKERS = {
  'package.json': ['npm', 'npx', 'node.js', 'nodejs'],
  'pnpm-lock.yaml': ['pnpm'],
  'yarn.lock': ['yarn'],
  'Cargo.toml': ['cargo', 'rust'],
  'go.mod': ['golang'],
  'pyproject.toml': ['python', 'pytest', 'poetry'],
  'requirements.txt': ['python', 'pip', 'pytest'],
  Gemfile: ['ruby', 'bundler', 'rspec'],
  'composer.json': ['php', 'composer'],
  'pom.xml': ['maven'],
  'build.gradle': ['gradle'],
  'build.gradle.kts': ['gradle'],
  'deno.json': ['deno'],
  Dockerfile: ['docker'],
};

// Rough estimate for display only; see LIMITS.bytesPerToken.
export const APPROX_CHARS_PER_TOKEN = LIMITS.bytesPerToken.value;

// The cost of the person's own sessions (tokens.mjs). Neither number is from the documentation:
// the weights are what one token costs against one uncached input token, the same for every
// model, so a share of them estimates what a usage limit counts and is not a bill; the context
// size marks a long session, a default of this tool.
export const TOKENS = {
  weights: { read: 0.1, write5m: 1.25, write1h: 2, input: 1, output: 5, documented: false, source: null },
  longContext: { value: 400_000, documented: false, source: null },
  defaultDays: 7,
  maxDays: 90,
};
