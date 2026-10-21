// Compares what the two parts found on the same setup: the result of checks.mjs (part 1) and the
// JSON block that /claude-health-prompt --json prints (part 2). A test can hold the two parts to
// the same catalogue, but not a model to reading it well; this measures that, check by check.
//
//   node prompt-parity.mjs --checks <checks.json> --part2 <file>
//
// <file> is either the JSON block alone or a whole answer that holds it (the last ```json block
// is taken), or the output of `claude -p --output-format json`, whose `result` holds the answer.
// Findings and notes are matched by check and file, candidates also by line. Exit code 1 when any
// finding of one part is missing from the other.

import { readFileSync } from 'node:fs';
import { CANDIDATE_CHECKS, CHECKS } from './checks.mjs';
import { parseArgs, readJsonFile, requireOption, runCli } from './lib/cli.mjs';

const pathKey = (file) => {
  const slashed = String(file ?? '').replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
};

export function part2Result(text) {
  let body = text.replace(/^\ufeff/, '');
  try {
    const whole = JSON.parse(body);
    if (whole && typeof whole.result === 'string') body = whole.result;
    else if (whole && Array.isArray(whole.findings)) return whole;
  } catch {
    // Not JSON as a whole: an answer with a block in it.
  }
  const blocks = [...body.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length === 0) throw new Error('No ```json block found in the answer of part 2. Was it run with --json?');
  return JSON.parse(blocks[blocks.length - 1][1]);
}

function compare(one, two, key) {
  const left = new Map(one.map((item) => [key(item), item]));
  const right = new Map(two.map((item) => [key(item), item]));
  return {
    both: [...left.keys()].filter((k) => right.has(k)),
    onlyPart1: [...left.keys()].filter((k) => !right.has(k)),
    onlyPart2: [...right.keys()].filter((k) => !left.has(k)),
  };
}

export function parity(checks, part2) {
  const byFile = (item) => `${item.check} ${pathKey(item.file)}`;
  const byLine = (item) => `${item.check} ${pathKey(item.file)}:${item.line ?? '-'}`;
  const findings = compare(checks.findings ?? [], part2.findings ?? [], byFile);
  const severity = findings.both.filter((k) => {
    const a = (checks.findings ?? []).find((item) => byFile(item) === k);
    const b = (part2.findings ?? []).find((item) => byFile(item) === k);
    return a.severity !== b.severity;
  });
  const perCheck = Object.fromEntries(
    [...CHECKS, ...CANDIDATE_CHECKS].map((id) => {
      const list = CANDIDATE_CHECKS.includes(id) ? 'candidates' : 'findings';
      const a = (checks[list] ?? []).filter((item) => item.check === id).length;
      const b = (part2[list] ?? []).filter((item) => item.check === id).length;
      return [id, { part1: a, part2: b }];
    }),
  );
  const tokens = {};
  for (const [place, value] of Object.entries(checks.contextTokens ?? {})) {
    const found = Object.entries(part2.contextTokens ?? {}).find(([other]) => pathKey(other) === pathKey(place));
    tokens[place] = { part1: value, part2: found ? found[1] : null };
  }
  return {
    findings: { ...findings, severityDiffers: severity },
    candidates: compare(checks.candidates ?? [], part2.candidates ?? [], byLine),
    notes: compare(checks.notes ?? [], part2.notes ?? [], byFile),
    review: compare(checks.review ?? [], part2.review ?? [], byFile),
    perCheck,
    contextTokens: tokens,
  };
}

// The result of checks.mjs keeps the context per place in contextTax; part 2 prints a map.
const contextOf = (checks) =>
  checks.contextTokens ?? Object.fromEntries((checks.contextTax ?? []).map((place) => [place.project ?? 'user', place.tokens]));

runCli(import.meta.url, (argv) => {
  const args = parseArgs(argv, { checks: 'string', part2: 'string' });
  const checks = readJsonFile(requireOption(args, 'checks'), 'checks');
  const part2 = part2Result(readFileSync(requireOption(args, 'part2'), 'utf8'));
  const result = parity({ ...checks, contextTokens: contextOf(checks) }, part2);
  if (result.findings.onlyPart1.length || result.findings.onlyPart2.length) process.exitCode = 1;
  return result;
});
