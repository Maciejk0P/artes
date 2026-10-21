// Entry point for `node --test tests/`.
//
// Node 20 walks a directory argument and runs every test file in it. Node 21 and later treat the
// argument as a file to run, which resolves to this index, so the test files are loaded from here.
// On Node 20 this file does nothing, otherwise every test would run twice.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major >= 21) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const name of readdirSync(here).sort()) {
    if (name.endsWith('.test.mjs')) await import(pathToFileURL(path.join(here, name)).href);
  }
}
