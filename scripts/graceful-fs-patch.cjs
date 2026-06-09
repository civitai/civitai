// Windows EMFILE ("too many open files") mitigation for `next build`.
//
// A Pages-Router app this size opens thousands of files during page-data
// collection / output emit. Windows' descriptor limit is lower than Linux's,
// so the build can exhaust it and throw EMFILE. graceful-fs patches the global
// fs module to queue and retry EMFILE/ENFILE operations instead of failing.
//
// Preload via: NODE_OPTIONS="--require ./scripts/graceful-fs-patch.cjs".
// No effect on Linux/macOS builds (they don't hit the limit), so it's safe to
// keep enabled everywhere.
const path = require('path');
const realFs = require('fs');

let gracefulFs;
try {
  gracefulFs = require('graceful-fs');
} catch {
  // pnpm doesn't hoist graceful-fs to a root-resolvable path; fall back to the
  // copy webpack/next already depend on in the pnpm store.
  gracefulFs = require(path.resolve(
    __dirname,
    '..',
    'node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs'
  ));
}

gracefulFs.gracefulify(realFs);
