import { lstatSync } from 'node:fs';
import path from 'node:path';

// Paths are reported with forward slashes on every platform so the output reads the same everywhere.
export function toPosix(file) {
  return file.replace(/\\/g, '/');
}

export function absolute(file) {
  return toPosix(path.resolve(file));
}

export function join(...parts) {
  return toPosix(path.join(...parts));
}

export function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// 'file' | 'dir' | 'symlink' | 'other' | null (missing or unreadable).
// lstat never follows a link; a Windows junction is reported as a symlink too.
export function entryType(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'other';
}

export function expandHome(file, home) {
  if (file === '~') return home;
  if (file.startsWith('~/') || file.startsWith('~\\')) return path.join(home, file.slice(2));
  return file;
}

// The one folder this tool writes into without asking: run data, backups and the two reports.
export const HEALTH_FOLDER = 'health-check';

export function healthDir(home) {
  return join(home, '.claude', HEALTH_FOLDER);
}

export function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// What each project is called in a label: the name of its folder, or as many of the folders above
// it as it takes (client-a/web, client-b/web). One list of projects gives one set of names,
// worked out once.
//
// A label is the name of a project and the path of the file below it, so two files share a label
// exactly when the name of one project is the name of another, or is that name plus folders
// below it ("app" with the file web/CLAUDE.md, and "app/web" with CLAUDE.md). The names are
// therefore made so that none of them leads another: a name that does gets one more folder in
// front, until none does or the name is the full path, which is the file's own. One case needs
// nothing: a project that lies inside another and is named by the path between them, folder for
// folder; there the same label is the same file. A name never starts with the mark of the home
// folder either, whatever a folder is called.
const HOME_MARK = '~';
const namesOf = new WeakMap();
function projectNames(projects) {
  if (!namesOf.has(projects)) {
    const roots = [...new Set(projects.map((project) => toPosix(project)))];
    const parts = new Map(roots.map((root) => [root, root.split('/').filter(Boolean)]));
    const depth = new Map(roots.map((root) => [root, 1]));
    // A root named by all of its folders is named in full: by its path, as it is written.
    const full = (root) => depth.get(root) >= parts.get(root).length;
    const name = (root) => (full(root) ? root : parts.get(root).slice(-depth.get(root)).join('/'));
    const leads = (a, b) => {
      const [first, second] = [name(a), name(b)];
      if (!second.startsWith(`${first}/`)) return false;
      return !(isInside(b, a) && second === `${first}/${toPosix(path.relative(a, b))}`);
    };
    for (;;) {
      const longer = new Set();
      for (const root of roots) {
        if (name(root) === HOME_MARK || name(root).startsWith(`${HOME_MARK}/`)) longer.add(root);
        for (const other of roots) {
          if (other === root) continue;
          if (name(other) === name(root)) longer.add(root);
          // The name that leads the other one is made longer; when it is a full path already, the other is.
          else if (leads(root, other)) longer.add(full(root) ? other : root);
        }
      }
      const grow = [...longer].filter((root) => !full(root));
      if (!grow.length) break;
      for (const root of grow) depth.set(root, depth.get(root) + 1);
    }
    namesOf.set(projects, new Map(roots.map((root) => [root, name(root)])));
  }
  return namesOf.get(projects);
}

// A short label for a report: ~/.claude/CLAUDE.md or <project>/CLAUDE.md. Two files never share
// a label: a project is named by projectNames() above.
export function displayPath(file, home, projects = []) {
  const target = toPosix(file);
  const owner = projects
    .map((project) => toPosix(project))
    .filter((project) => isInside(target, project))
    .sort((a, b) => b.length - a.length)[0];
  if (owner) {
    const relative = toPosix(path.relative(owner, target));
    const name = projectNames(projects).get(owner);
    return relative ? `${name}/${relative}` : name;
  }
  if (home && isInside(target, home)) return `~/${toPosix(path.relative(home, target))}`;
  return target;
}

// Folders the directory walks never enter, wherever they are: dependencies, caches and
// operating-system folders. Hidden folders are skipped by the walks as well.
export const SKIP_DIRS = new Set(
  [
    'node_modules',
    'bower_components',
    '__pycache__',
    'site-packages',
    'AppData',
    'Application Data',
    'Local Settings',
    'Library',
    'Applications',
    'Program Files',
    'Program Files (x86)',
    'ProgramData',
    'Windows',
    '$Recycle.Bin',
    'System Volume Information',
    'Cache',
    'Caches',
    'tmp',
    'temp',
  ].map((name) => name.toLowerCase()),
);

// Names that mean build output or a virtual environment inside a project, but that people also
// give to a folder of projects (~/work/build, ~/src/env). They are skipped inside a project and
// deep in the home folder, and entered near its top; the caller says which applies.
export const BUILD_OUTPUT_DIRS = new Set(['vendor', 'dist', 'build', 'out', 'target', 'coverage', 'venv', 'env']);

export function isSkippedDir(name, { buildOutput = true } = {}) {
  const lower = name.toLowerCase();
  return name.startsWith('.') || SKIP_DIRS.has(lower) || (buildOutput && BUILD_OUTPUT_DIRS.has(lower));
}
