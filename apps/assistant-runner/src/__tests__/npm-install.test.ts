import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { npmInstallCommand, npmInstallRunningProbe } from '../app-assistant/npm-install';

/**
 * The is-another-install-running probe, run for real (by `sh -c`, as the sandbox runs a command)
 * against a fake process list: a directory of `<pid>/cmdline` files, each NUL-separated as the
 * kernel writes them.
 */
let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function probe(processes: Record<string, string[]>, extra: string[] = []): string {
  root = mkdtempSync(path.join(tmpdir(), 'npm-install-probe-'));
  for (const [pid, argv] of Object.entries(processes)) {
    mkdirSync(path.join(root, pid));
    writeFileSync(path.join(root, pid, 'cmdline'), argv.map((arg) => `${arg}\0`).join(''));
  }
  // Not processes: the probe passes over them.
  for (const name of extra) mkdirSync(path.join(root, name));
  return execFileSync('sh', ['-c', npmInstallRunningProbe(root)], { encoding: 'utf8' });
}

describe('npmInstallRunningProbe', () => {
  it('finds an npm install however it was launched', () => {
    for (const argv of [
      // npm's own process title, written over its argv.
      ['npm install --no-audit --no-fund'],
      // The shell the sandbox runs the assistant's command in.
      ['sh', '-c', 'cd web && npm install --no-audit --no-fund'],
      ['node', '/usr/local/lib/node_modules/npm/bin/npm-cli.js', 'ci'],
      ['npm', 'i'],
      ['/usr/local/bin/npm', 'add', 'zod'],
    ])
      expect(probe({ '1': ['/sbin/init'], '812': argv }), JSON.stringify(argv)).toBe('installing');
  });

  it('passes over entries that are not a pid, even one whose cmdline names an install', () => {
    // As `/proc/self` would read if it pointed at an install: not a process of its own.
    expect(probe({ '1': ['/sbin/init'], self: ['npm', 'install'], net: ['npm', 'ci'] })).toBe(
      'idle'
    );
    // Control: the same command line under a pid is seen.
    expect(probe({ '1': ['/sbin/init'], '77': ['npm', 'install'] })).toBe('installing');
  });

  it('is idle when no npm install runs', () => {
    expect(
      probe(
        {
          '1': ['/sbin/init'],
          '40': ['npm', 'run', 'dev', '--', '--host', '0.0.0.0'],
          '41': ['node', '/workspace/web/node_modules/.bin/vite', '--port', '5173'],
          '42': ['pnpm', 'install'],
          '43': ['node', 'server.js', '--install'],
        },
        ['self', 'sys']
      )
    ).toBe('idle');
  });

  it('never sees itself: neither the shell that runs it nor its own node process', () => {
    const command = npmInstallRunningProbe('/proc');
    const script = /^node -e '(.*)' \/proc$/s.exec(command)?.[1];
    expect(script).toEqual(expect.any(String));
    expect(
      probe({
        '1': ['/sbin/init'],
        '90': ['sh', '-c', command],
        '91': ['node', '-e', script!, '/proc'],
      })
    ).toBe('idle');
    // Control: the same list with an install in it is seen.
    expect(
      probe({
        '90': ['sh', '-c', command],
        '91': ['node', '-e', script!, '/proc'],
        '92': ['sh', '-c', npmInstallCommand('web')],
      })
    ).toBe('installing');
  });
});
