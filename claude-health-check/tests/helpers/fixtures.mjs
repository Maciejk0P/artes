// Test support. The fixture tree under tests/fixtures/ stores the special names with a leading
// underscore (_claude, _CLAUDE.md, ...) so that an agent working in this repository never loads
// fixture content as real memory, skills or settings. materialise() copies a fixture into the
// operating-system temp folder under the real names; every test runs against that copy.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.join(here, '..', '..');
export const FIXTURES = path.join(here, '..', 'fixtures');

// The one place that says where the skill lives. Every test reaches the scripts through it.
export const SKILL_DIR = path.join(PACKAGE_ROOT, '.claude', 'skills', 'claude-health');
export const SCRIPTS = path.join(SKILL_DIR, 'scripts');

// A script or lib module of the skill, by its path below scripts/ ("checks.mjs", "lib/facts.mjs").
export const load = (relative) => import(pathToFileURL(path.join(SCRIPTS, relative)).href);

const REAL_NAMES = {
  _claude: '.claude',
  '_CLAUDE.md': 'CLAUDE.md',
  '_CLAUDE.local.md': 'CLAUDE.local.md',
  '_AGENTS.md': 'AGENTS.md',
  '_mcp.json': '.mcp.json',
  '_settings.local.json': 'settings.local.json',
  _node_modules: 'node_modules',
  // The marker of a repository: a folder in a clone, a file in a worktree or a submodule.
  _git: '.git',
};

function restoreNames(dir) {
  for (const name of readdirSync(dir)) {
    let current = path.join(dir, name);
    if (name.startsWith('_')) {
      const real = REAL_NAMES[name];
      if (!real) throw new Error(`Fixture entry "${name}" starts with "_" but has no real name in REAL_NAMES`);
      renameSync(current, path.join(dir, real));
      current = path.join(dir, real);
    }
    if (statSync(current).isDirectory()) restoreNames(current);
  }
}

const slash = (file) => file.replace(/\\/g, '/');

// name is a folder under tests/fixtures/ that holds home/ and projects/.
export function materialise(name) {
  // The real path, so that paths in a result compare equal on systems whose temp folder is
  // reached through a link or a short name.
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'claude-health-check-')));
  cpSync(path.join(FIXTURES, name), root, { recursive: true });
  restoreNames(root);
  return {
    root: slash(root),
    home: slash(path.join(root, 'home')),
    projects: slash(path.join(root, 'projects')),
    project: (project) => slash(path.join(root, 'projects', project)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// A setup built by a test, file by file: an empty home folder with its .claude folder, and a
// folder for projects. write(relative, lines | text) puts a file below the root, under its real
// name; dir(relative) makes a folder.
export function emptySetup() {
  const root = slash(realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'claude-health-check-'))));
  mkdirSync(path.join(root, 'home', '.claude'), { recursive: true });
  mkdirSync(path.join(root, 'projects'));
  const dir = (relative) => {
    mkdirSync(path.join(root, relative), { recursive: true });
    return `${root}/${relative}`;
  };
  const write = (relative, content) => {
    dir(path.posix.dirname(relative));
    writeFileSync(path.join(root, relative), Array.isArray(content) ? `${content.join('\n')}\n` : content);
    return `${root}/${relative}`;
  };
  return { root, home: `${root}/home`, projects: `${root}/projects`, project: (name) => `${root}/projects/${name}`, write, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Rewrites every Markdown and JSON file below a folder with CRLF line endings, the way a checkout
// with line-ending conversion leaves them. Returns how many files were rewritten.
export function toCrlf(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += toCrlf(full);
    else if (/\.(md|json)$/i.test(entry.name)) {
      const text = readFileSync(full, 'utf8');
      writeFileSync(full, text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
      count += 1;
    }
  }
  return count;
}

export function runScript(script, args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    input: options.input,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function runJson(script, args, options) {
  const result = runScript(script, args, options);
  if (result.status !== 0) throw new Error(`${script} exited with ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
