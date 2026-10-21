// What the scanner keeps of a hook command, and how the checks find the script a hook runs.
//
// A hook command is a shell line and can carry anything: a password as a plain argument, a
// webhook address, an inline script. Only two of its words are ever needed here: the program,
// and the script file an interpreter is given. Everything else is replaced before the command
// leaves the scanner.

import path from 'node:path';
import { join, toPosix } from './paths.mjs';
import { MASK, maskSecrets } from './secrets.mjs';

const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'pwsh', 'powershell', 'ruby', 'deno', 'bun']);
const SCRIPT_EXTENSION = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|ps1|cmd|bat|pl|php)$/i;

// Splits a shell command into words, honouring quotes, so a quoted path with spaces stays whole.
export function shellWords(command) {
  const words = [];
  let current = '';
  let quote = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) words.push(current);
      current = '';
    } else current += char;
  }
  if (current) words.push(current);
  return words;
}

const programName = (word) => toPosix(word).split('/').pop().replace(/\.exe$/i, '').toLowerCase();
// An option, an assignment or an address is never the program or its script.
const isPlain = (word) => word !== '' && !word.startsWith('-') && !word.includes('=') && !word.includes('://');

// The words that can name what a hook runs: the first word, and the word right after a known
// interpreter. A trailing shell operator (`gone.sh;`) is not part of the name.
function keptWords(command) {
  const words = shellWords(command).map((word) => word.replace(/[;&|)]+$/, ''));
  const kept = [];
  if (words.length && isPlain(words[0])) {
    kept.push(words[0]);
    if (INTERPRETERS.has(programName(words[0])) && words.length > 1 && isPlain(words[1])) kept.push(words[1]);
  }
  return { kept, dropped: words.length - kept.length };
}

// The script files a hook command names, as written in the command.
export function scriptTokens(command) {
  return keptWords(command).kept.filter((word) => SCRIPT_EXTENSION.test(word));
}

// The command as the scanner reports it: program and script, every other argument as one ***.
export function summariseHookCommand(command) {
  const { kept, dropped } = keptWords(command);
  const shown = kept.map((word) => (/\s/.test(word) ? `"${word}"` : word));
  return maskSecrets([...shown, ...(dropped > 0 ? [MASK] : [])].join(' '));
}

// The file a script word points at, or null when that cannot be told (an unknown variable, or a
// relative path in the user settings, which have no folder to be relative to).
export function resolveHookScript(token, { home, project, platform = process.platform }) {
  let word = token.replace(/^\$\{?HOME\}?(?=[\\/])/, '~').replace(/^%USERPROFILE%(?=[\\/])/i, '~');
  if (word.startsWith('~/') || word.startsWith('~\\')) return join(home, word.slice(2));
  const projectDir = /^\$\{?CLAUDE_PROJECT_DIR\}?[\\/]/.exec(word);
  if (projectDir) return project ? join(project, word.slice(projectDir[0].length)) : null;
  if (/[$%]/.test(word)) return null;
  // On Windows hooks run through Git Bash, which spells C:\x as /c/x.
  if (platform === 'win32') word = word.replace(/^\/([A-Za-z])\//, '$1:/');
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  if (flavour.isAbsolute(word)) return toPosix(word);
  return project ? join(project, word) : null;
}
