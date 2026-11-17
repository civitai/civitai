// A worker_threads entry that dies before it can report ready, standing in for a replacement
// worker that fails to start (for example a broken image). Used by sandbox.test.ts.
throw new Error('crash-worker: failing on purpose during start');
