// Preloaded with `--require` (via NODE_OPTIONS) by the M3 tsx smoke test. When
// M3_MODULE_TRACE_DIR is set, each process writes the absolute paths of every module in
// its `require.cache` to `<dir>/<pid>.json` as it exits.
//
// Why `require.cache` and not a loader hook: tsx runs the script in a child process and
// loads the project's TypeScript as CommonJS there, through its own compile path; an
// ESM-style `module.registerHooks` trace recorded none of those modules when tried. The
// `exit` event also fires on `process.exit()` and after an uncaught exception, so a run
// that crashes still leaves its trace. One file per process, because tsx's parent CLI
// outlives the child and would overwrite a shared file.
// A `--require` preload must be CommonJS, so `require` is the only way to load here.
/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
/* eslint-enable @typescript-eslint/no-var-requires */

const dir = process.env.M3_MODULE_TRACE_DIR;
if (dir) {
  process.on('exit', () => {
    fs.writeFileSync(
      path.join(dir, `${process.pid}.json`),
      JSON.stringify(Object.keys(require.cache))
    );
  });
}
