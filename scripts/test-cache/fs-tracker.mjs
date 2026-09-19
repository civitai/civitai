/**
 * Setup file: records every path a test file touches through `fs`, so a test whose inputs are
 * files — a fixture, or a whole source tree read as text by a convention guard — can be keyed on
 * them. Without it those 224 files (5.9% of modelled worker time) would have to run every time.
 *
 * Patching the CommonJS `fs` object and then calling `syncBuiltinESMExports` is what makes this
 * reach `import { readFileSync } from 'node:fs'` too — measured on a fixture: the ESM named import
 * went through the wrapper. Loaded only when the cache is on; it is inert otherwise.
 *
 * The paths leave the worker as the file task's `meta`, which vitest serialises to the main process
 * where the reporter reads it. A per-file Set is correct because the unit projects isolate every
 * file in its own process; were that ever turned off, reads would pool across files, which only
 * makes keys stricter.
 */

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterAll } from 'vitest';

import { mode } from './core.mjs';

if (mode() !== 'off') {
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const reads = new Set();

  const note = (p) => {
    if (typeof p === 'string') reads.add(p);
    else if (p instanceof URL) reads.add(p.href);
    else if (Buffer.isBuffer(p)) reads.add(p.toString());
  };

  const wrap = (obj, name) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function (p, ...rest) {
      note(p);
      return orig.call(this, p, ...rest);
    };
  };

  for (const name of [
    'readFileSync',
    'readFile',
    'readdirSync',
    'readdir',
    'statSync',
    'lstatSync',
    'stat',
    'lstat',
    'existsSync',
    'opendirSync',
    'opendir',
    'createReadStream',
    'accessSync',
    'access',
    'openSync',
    'open',
    'realpathSync',
    'realpath',
    'readlinkSync',
    'readlink',
  ]) {
    wrap(fs, name);
  }
  for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'opendir', 'open', 'access', 'realpath', 'readlink']) {
    wrap(fs.promises, name);
  }
  syncBuiltinESMExports();

  // The first argument must be an object pattern — vitest 4 parses hook signatures as fixtures and
  // rejects anything else — and the file's suite arrives second.
  // eslint-disable-next-line no-empty-pattern
  afterAll(({}, suite) => {
    suite.meta.testCacheReads = [...reads];
  });
}
