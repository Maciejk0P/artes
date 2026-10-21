// The one order of suggested changes: file by file.
//
//   1. your user memory file,
//   2. the other user files,
//   3. each project in the order of the scan,
// and inside each place: memory files, then skills, commands, agents, rule files, settings.
// Inside a file the changes go from the top of the file down; one that is about the file as a
// whole (it names no line) comes first. A change that names two files belongs to the file its
// finding sits in.
//
// The walk of cards, the console and both reports take the order from here and from nowhere
// else, so they cannot disagree about what comes next.

import { isInside } from './paths.mjs';

// Kinds of file in the order they are walked inside one place. 'other' is a file the scan does
// not list (a finding can point at one): it comes last in its place.
export const FILE_KINDS = ['memory', 'memory-local', 'memory-nested', 'import', 'agents-md', 'skill', 'command', 'agent', 'rule', 'settings', 'settings-local', 'mcp', 'other'];

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// items: anything with { file, line, endLine } (findings, or records that carry those of their
// finding). Returns the files that hold at least one item, in walk order, each with its items:
// [{ path, kind, scope, project, place, lines, items }]. place is 'user' or the project's path.
export function byFile(scan, items) {
  const entries = new Map([...(scan.settings ?? []), ...scan.files].map((entry) => [entry.path, entry]));
  const projects = (scan.projects ?? []).map((project) => project.path);
  // The project a file the scan does not list lies in: the innermost one, so a file of a
  // repository nested in a project belongs to that repository.
  const owner = (file) => projects.filter((project) => isInside(file, project)).sort((a, b) => b.length - a.length)[0] ?? null;

  const groups = new Map();
  items.forEach((item, index) => {
    if (!groups.has(item.file)) {
      const entry = entries.get(item.file);
      const project = entry ? (entry.scope === 'user' ? null : entry.project) : owner(item.file);
      groups.set(item.file, {
        path: item.file,
        kind: entry && FILE_KINDS.includes(entry.kind) ? entry.kind : 'other',
        scope: project === null ? 'user' : 'project',
        project,
        place: project ?? 'user',
        lines: entry?.lines ?? null,
        rows: [],
      });
    }
    groups.get(item.file).rows.push({ item, index });
  });

  const placeRank = (group) => (group.project === null ? 0 : 1 + projects.indexOf(group.project));
  return [...groups.values()]
    .sort((a, b) => placeRank(a) - placeRank(b) || FILE_KINDS.indexOf(a.kind) - FILE_KINDS.indexOf(b.kind) || compare(a.path, b.path))
    .map(({ rows, ...group }) => ({
      ...group,
      // No line means the whole file: before line 1. Items on one line keep the order they came in.
      items: rows.sort((a, b) => (a.item.line ?? 0) - (b.item.line ?? 0) || (a.item.endLine ?? 0) - (b.item.endLine ?? 0) || a.index - b.index).map((row) => row.item),
    }));
}
