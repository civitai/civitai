import { describe, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

const rootDir = path.resolve(__dirname, '../../..');
const runTest = process.env.TEST_MODULE_LOADING === 'true';

describe('Server Module Loading Sanity Check', () => {
  const itFn = runTest ? it : it.skip;

  itFn('should import all server routers, jobs, and services without load-time ReferenceErrors', () => {
    const workerPath = path.join(__dirname, 'load-modules-worker.ts');
    const tsxCliPath = path.join(rootDir, 'node_modules/tsx/dist/cli.mjs');
    
    const result = spawnSync('node', [tsxCliPath, workerPath], {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
      },
      timeout: 55000, // Hard stop at 55 seconds to prevent Vitest worker lockup
      stdio: 'pipe',
    });

    if (result.status !== 0 || result.error) {
      const errorMsg = result.error ? result.error.message : '';
      const stdout = result.stdout ? result.stdout.toString() : '';
      const stderr = result.stderr ? result.stderr.toString() : '';
      throw new Error(
        `Module loading check failed (status: ${result.status}, error: ${errorMsg}):\n${stdout}\n${stderr}`
      );
    }
  }, 60000); // 60s timeout for cold compilation/resolution
});
