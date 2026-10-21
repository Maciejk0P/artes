// The deterministic half of a run, shared by the launcher and by ui.mjs inside Claude Code:
// the run folder, the scan, the checks, the view, report 1 and the session file.
// It reads the setup and writes only into <home>/.claude/health-check/.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks } from '../checks.mjs';
import { renderStateView, writeReport } from '../report.mjs';
import { isProject, scan } from '../scan.mjs';
import { isSessionData } from './automemory.mjs';
import { readJsonFile } from './cli.mjs';
import { absolute, entryType, healthDir, isSkippedDir, join, timestamp } from './paths.mjs';
import { shellLine } from './surroundings.mjs';
import { buildView } from './view.mjs';

export const VERSION = '0.1.0';

// The name of a run: YYYYMMDD-HHMMSS. It is the one thing that crosses from the launcher to
// Claude Code, typed there by the person, so nothing else is ever accepted in its place.
export const STAMP_PATTERN = /^\d{8}-\d{6}$/;
export const isStamp = (text) => typeof text === 'string' && STAMP_PATTERN.test(text);

export function resolveHome(explicit) {
  return absolute(explicit || os.homedir());
}

// Every file of a run, by name.
export function runFiles(home, stamp) {
  if (!isStamp(stamp)) throw new Error(`"${stamp}" is not the name of a run; a run is named like 20261001-131730`);
  const health = healthDir(home);
  const dir = join(health, `run-${stamp}`);
  return {
    health,
    dir,
    session: join(dir, 'session.json'),
    scan: join(dir, 'scan.json'),
    checks: join(dir, 'checks.json'),
    reading: join(dir, 'reading.json'),
    judgement: join(dir, 'judgement.json'),
    state: join(dir, 'state.json'),
    applied: join(dir, 'applied.json'),
    flows: join(dir, 'flows.json'),
    drafts: join(dir, 'drafts'),
    scanAfter: join(dir, 'scan-after.json'),
    checksAfter: join(dir, 'checks-after.json'),
    backup: join(health, `backup-${stamp}`),
    report1: join(health, `state-${stamp}.html`),
    report2: join(health, `after-${stamp}.html`),
  };
}

// A stamp no earlier run of this home folder has: two runs in one second get different names.
export function newStamp(home, now = new Date()) {
  const health = healthDir(home);
  for (let second = 0; second < 120; second += 1) {
    const stamp = timestamp(new Date(now.getTime() + second * 1000));
    if (entryType(join(health, `run-${stamp}`)) === null && entryType(join(health, `state-${stamp}.html`)) === null) return stamp;
  }
  throw new Error(`No free run name near ${timestamp(now)} in ${health}`);
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// The projects a folder stands for, the way the scan reads it: the folder itself when it is a
// project, otherwise its subfolders that are. Used to confirm a typed folder before the scan.
export function projectsIn(home, folder) {
  const dir = absolute(folder);
  if (isSessionData(home, dir)) return { ok: false, reason: 'session' };
  if (entryType(dir) !== 'dir') return { ok: false, reason: 'missing' };
  if (isProject(dir)) return { ok: true, projects: [dir] };
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const projects = names
    .filter((entry) => entry.isDirectory() && !isSkippedDir(entry.name, { buildOutput: false }))
    .map((entry) => join(dir, entry.name))
    .filter((child) => isProject(child))
    .sort();
  return projects.length ? { ok: true, projects } : { ok: false, reason: 'none' };
}

// scope: { projects: [folders], machine, nested }. Returns the scan and how long it took.
export function scanSetup({ home, scope, now = new Date(), onProgress, caps = {} }) {
  const started = performance.now();
  const result = scan({ home, projects: scope.projects ?? [], machine: Boolean(scope.machine), nested: Boolean(scope.nested), now, onProgress, ...caps });
  return { scan: result, scanMs: performance.now() - started };
}

// The same setup scanned again, without searching for projects again: the roots the first scan
// found are named one by one. What the person asked for stays written in the result.
export function scanAgain({ home, scan: before, nested = before.scope.nested, now = new Date() }) {
  const roots = before.projects.filter((project) => !project.nestedIn).map((project) => project.path);
  const started = performance.now();
  const result = scan({ home, projects: roots, machine: false, nested, now, ...before.scope.limits });
  result.scope = { ...result.scope, projects: before.scope.projects, machine: before.scope.machine };
  return { scan: result, scanMs: performance.now() - started };
}

// Repositories that sit inside the scanned projects, have their own setup and were left out.
export const nestedLeftOut = (result) => result.nestedRepositories.filter((repository) => repository.setup && !repository.included).length;

export function check({ scan: result, lang, judgement = [], now = new Date() }) {
  const started = performance.now();
  const checks = runChecks(result, { lang, judgement, now });
  const view = buildView({ scan: result, checks, lang, now });
  return { checks, view, checksMs: performance.now() - started };
}

export function writeStateReport({ view, file, home }) {
  const started = performance.now();
  const report = writeReport(renderStateView(view), file, home);
  return { report: { ...report, name: path.basename(report.path) }, reportMs: performance.now() - started };
}

// What a screen needs to know about a run, ready to print. How to go on is two things, never one
// line: `start` is what a person types in a shell, in the folder of this tool, and `inside` is
// what they type inside Claude Code. The second begins with a slash, which a shell may rewrite
// when it is an argument (lib/surroundings.mjs, shellLine), so it is never made one.
export function runInfo(stamp, report) {
  return { stamp, start: shellLine('claude'), inside: `/claude-health resume ${stamp}`, report };
}

// Checks, report 1 and the three files of the run folder, for a scan that is already made.
export function startRun({ home, scan: result, scanMs = 0, lang, startedBy, now = new Date() }) {
  const stamp = newStamp(home, now);
  const files = runFiles(home, stamp);
  const { checks, view, checksMs } = check({ scan: result, lang, now });
  const session = {
    version: 1,
    tool: VERSION,
    stamp,
    createdAt: now.toISOString(),
    startedBy,
    lang,
    home,
    scope: {
      projects: result.scope.projects,
      machine: result.scope.machine,
      nested: result.scope.nested,
      resolved: result.projects.filter((project) => !project.nestedIn).map((project) => project.path),
    },
    report1: files.report1,
  };
  writeJson(files.scan, result);
  writeJson(files.checks, checks);
  const { report, reportMs } = writeStateReport({ view, file: files.report1, home });
  writeJson(files.session, session);
  return { stamp, files, session, scan: result, checks, view, report, timings: { scanMs, checksMs, reportMs }, info: runInfo(stamp, report) };
}

// A run the launcher (or an earlier call) left in the health-check folder.
export function loadRun({ home, stamp }) {
  const files = runFiles(home, stamp);
  if (entryType(files.session) !== 'file') {
    throw new Error(`There is no run ${stamp} in ${files.health}. Start one with: claude-health check`);
  }
  const session = readJsonFile(files.session, 'session');
  if (session.version !== 1 || session.stamp !== stamp) throw new Error(`${files.session} is not the session file of run ${stamp}`);
  return { stamp, files, session, scan: readJsonFile(files.scan, 'scan'), checks: readJsonFile(files.checks, 'checks') };
}

// The files that differ between two scans of one setup: changed, added or gone.
export function changedSince(before, after) {
  const key = (file) => `${file.lines}:${file.bytes}:${file.contentSha ?? ''}`;
  const sizes = (result) => new Map([...result.files.map((file) => [file.path, key(file)]), ...result.settings.map((file) => [file.path, `${file.bytes}:${file.valid}`])]);
  const [old, current] = [sizes(before), sizes(after)];
  return [...new Set([...old.keys(), ...current.keys()])].filter((file) => old.get(file) !== current.get(file)).sort();
}
