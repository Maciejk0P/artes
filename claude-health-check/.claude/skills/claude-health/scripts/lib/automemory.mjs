// The auto memory index of a project: <home>/.claude/projects/<project>/memory/MEMORY.md.
// Its first lines load at the start of every conversation, so its size belongs to the context tax.
//
// The folder next to it holds session transcripts, which this tool never opens. This module
// therefore asks for one thing only: the size of that one file, by its full name. It lists no
// folder and reads no content, and it is the only module that names the per-project folders of
// the home configuration. A test holds it to that.
//
// The name of the per-project folder is observed, not documented: the absolute path of the
// project with every character that is not a letter or a digit replaced by "-". When the file is
// not where that rule puts it, the answer is "not found"; nothing else is tried.

import { lstatSync } from 'node:fs';
import path from 'node:path';

export function autoMemoryDirName(projectPath) {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

// true for the folder that holds the per-project session data, and for anything inside it.
// A folder named as a project is checked with this, so that not even a request reaches in there.
export function isSessionData(home, dir) {
  const relative = path.relative(path.join(path.resolve(home), '.claude', 'projects'), path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// { path, found, bytes }: the place the index is expected at, whether a regular file is there,
// and its size. A link is not followed and counts as not found.
export function autoMemoryIndex(home, projectPath) {
  const file = path.join(home, '.claude', 'projects', autoMemoryDirName(projectPath), 'memory', 'MEMORY.md').replace(/\\/g, '/');
  try {
    const stat = lstatSync(file);
    if (stat.isFile()) return { path: file, found: true, bytes: stat.size };
  } catch {
    // Missing or unreachable: both are "not found".
  }
  return { path: file, found: false, bytes: 0 };
}
