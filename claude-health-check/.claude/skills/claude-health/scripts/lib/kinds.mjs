// The closed sets shared by the checks, the apply log and the reports.

// What a finding suggests doing.
export const SUGGESTION_KINDS = [
  'shorten',
  'move-to-project',
  'move-to-user',
  'make-skill',
  'make-hook',
  'make-command',
  'make-setting',
  'make-rule-file',
  'delete-duplicate',
  'fix-front-matter',
  'review-exception',
  'review-conflict',
];

// What an applied change can leave behind as a new thing.
export const CREATED_TYPES = ['skill', 'hook', 'command', 'setting', 'rule-file', 'file'];

export const SEVERITIES = ['high', 'medium', 'low'];

export const MEMORY_KINDS = ['memory', 'memory-local', 'memory-nested', 'import'];

// What is recorded for a change the person decided on: this tool applied it, the person made it
// by hand (the tool took a copy first and did nothing else), or it was skipped. Only "applied"
// is ever counted, drawn or worded as something this tool did.
export const RECORD_STATES = ['applied', 'by-hand', 'skipped'];

// What a judgement entry may say about a candidate.
export const CANDIDATE_STATES = ['open', 'confirmed', 'dismissed'];
