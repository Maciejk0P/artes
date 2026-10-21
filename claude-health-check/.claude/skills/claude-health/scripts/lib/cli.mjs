import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedOutput } from './targets.mjs';

export class UsageError extends Error {}

// Reads a JSON file written by one of the scripts or by a shell redirect. Windows PowerShell
// redirects as UTF-16 with a byte order mark, so both that and a UTF-8 mark are accepted.
export function readJsonFile(file, what) {
  let text;
  try {
    const bytes = readFileSync(file);
    const utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
    text = bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\ufeff/, '');
  } catch (error) {
    throw new Error(`Cannot read the ${what} file ${file} (${error.code ?? error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The ${what} file ${file} is not valid JSON`);
  }
}

// With --out the full result goes to that file as UTF-8 and stdout carries only a summary,
// which keeps large results out of the console and away from shell redirection. An existing file
// is replaced only inside the health-check folder of `home`; anywhere else --out only creates.
export function deliver(result, out, summary, home) {
  if (!out) return result;
  const target = allowedOutput(out, home);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  return { out: target, ...summary };
}

// spec maps an option name to 'string' | 'number' | 'boolean' | 'list'.
// A 'list' option may be repeated and may take several values in a row.
export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (const [name, type] of Object.entries(spec)) {
    if (type === 'list') out[name] = [];
    if (type === 'boolean') out[name] = false;
  }
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      i += 1;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const type = spec[name];
    if (!type) throw new UsageError(`Unknown option --${name}`);
    i += 1;
    if (type === 'boolean') {
      out[name] = true;
      continue;
    }
    const values = eq === -1 ? [] : [arg.slice(eq + 1)];
    while (i < argv.length && !argv[i].startsWith('--') && (type === 'list' || values.length === 0)) {
      values.push(argv[i]);
      i += 1;
    }
    if (values.length === 0) throw new UsageError(`Option --${name} needs a value`);
    if (type === 'list') {
      out[name].push(...values);
    } else if (type === 'number') {
      const number = Number(values[0]);
      if (!Number.isInteger(number) || number < 0) {
        throw new UsageError(`Option --${name} needs a non-negative whole number, got "${values[0]}"`);
      }
      out[name] = number;
    } else {
      out[name] = values[0];
    }
  }
  return out;
}

export function requireOption(args, name) {
  const value = args[name];
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    throw new UsageError(`Missing required option --${name}`);
  }
  return value;
}

function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  const normalise = (file) => {
    const real = realpathSync.native(file);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  try {
    return normalise(process.argv[1]) === normalise(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

export function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

// Runs `main` only when the module is the entry point, so the same file is a CLI and a library.
// The result goes to stdout as JSON; any error goes to stderr with a non-zero exit code.
export async function runCli(metaUrl, main) {
  if (!isMain(metaUrl)) return;
  try {
    const result = await main(process.argv.slice(2));
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof UsageError ? 'Usage error: ' : 'Error: '}${error.message}\n`);
    process.exitCode = 1;
  }
}
