import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { accentCustomizedFrom } from '@civitai/app-assistant/theme-evidence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openAppThemeEvidence, THEME_EVIDENCE_MAX_FILES } from '../app-assistant/theme-evidence';

/**
 * The runner's read of the open app's theme evidence, its one `run_command` run by a real shell over
 * a real directory (the sandbox's workspace stands in as a temp dir): the files it reads are the ones
 * civitai's submit scan reads, and a cut or oversized read judges nothing rather than half the app.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'theme-evidence-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A sandbox whose `run_command` runs in `root`, answering as sandbox-mcp does; `cut` drops output. */
function shellSandbox(app: string | null, { cut = 0 }: { cut?: number } = {}) {
  const commands: string[] = [];
  return {
    commands,
    active: app ? { name: `sb-${app}`, app, state: 'running' as const } : null,
    call: (tool: string, args: Record<string, unknown>) =>
      new Promise<{ text: string; isError: boolean }>((resolve) => {
        expect(tool).toBe('run_command');
        commands.push(String(args.command));
        execFile('bash', ['-c', String(args.command)], { cwd: root }, (err, stdout) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          const out = cut ? stdout.slice(0, stdout.length - cut) : stdout;
          resolve({ text: `exit_code: ${code}\ntimed_out: false\n---\n${out}`, isError: false });
        });
      }),
  };
}

const MAIN = "import '@civitai/theme/styles.css';\n";

describe('openAppThemeEvidence', () => {
  it('reads the app’s own source, not its dependencies, build output or scratch', async () => {
    write({
      'my-app/package.json': '{"dependencies":{"tailwindcss":"4"}}',
      'my-app/src/main.ts': MAIN,
      'my-app/src/index.css': '.app { --civitai-color-primary: #7c3aed; }\n.x { color: #111111; }',
      'my-app/node_modules/lib/x.css': '.a { --civitai-color-body: #000; color: #123456; }',
      'my-app/dist/a.css': '.b { color: #654321; }',
      'my-app/scratch/probe.ts': "const s = { color: '#abcdef' };",
      'my-app/src/dev/harness.css': '.c { color: #fedcba; }',
      'other-app/src/x.css': '.d { --civitai-color-text: #222; }',
    });
    const evidence = await openAppThemeEvidence(shellSandbox('my-app'));
    expect(evidence).toEqual({
      tokenOverrides: ['--civitai-color-primary'],
      // The token override is not counted as a colour of its own; `.x`'s colour is.
      customColorCount: 1,
      customColorFiles: ['src/index.css'],
      usesThemePackage: true,
      stylingDependencies: ['tailwindcss'],
      // package.json is read for its dependencies, not scanned; src/dev is excluded by the scan.
      filesScanned: 2,
    });
    expect(accentCustomizedFrom(evidence)).toBe(true);
  });

  it('the stock look reads false', async () => {
    write({
      'my-app/src/main.ts': MAIN,
      'my-app/src/index.css': 'body { color: var(--civitai-color-text); --civitai-radius: 4px; }',
    });
    expect(accentCustomizedFrom(await openAppThemeEvidence(shellSandbox('my-app')))).toBe(false);
  });

  it('a cut read judges nothing (null), never half the app', async () => {
    write({ 'my-app/src/main.ts': MAIN, 'my-app/src/index.css': '.a { color: #111111; }' });
    expect(await openAppThemeEvidence(shellSandbox('my-app', { cut: 5 }))).toBeNull();
  });

  it(`an app with more than ${THEME_EVIDENCE_MAX_FILES} source files judges nothing`, async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= THEME_EVIDENCE_MAX_FILES; i++) files[`my-app/src/f${i}.ts`] = 'export {};';
    write(files);
    expect(await openAppThemeEvidence(shellSandbox('my-app'))).toBeNull();
  });

  it('tests and the dev harness count against neither the file cap nor the scan', async () => {
    const files: Record<string, string> = { 'my-app/src/index.css': '.a { color: #111111; }' };
    for (let i = 0; i <= THEME_EVIDENCE_MAX_FILES; i++) {
      files[`my-app/src/__tests__/t${i}.ts`] = "const s = { color: '#abcdef' };";
      files[`my-app/tests/e${i}.ts`] = 'export {};';
      // Each pruned directory alone exceeds the cap: dropping any one prune turns this red.
      files[`my-app/src/dev/d${i}.ts`] = 'export {};';
    }
    files['my-app/test/x.css'] = '.t { color: #222222; }';
    files['my-app/src/dev/harness.css'] = '.d { color: #333333; }';
    write(files);
    const evidence = await openAppThemeEvidence(shellSandbox('my-app'));
    expect(evidence).toMatchObject({ filesScanned: 1, customColorCount: 1 });
  });

  it('no open app, or a key that is not an app key, runs nothing', async () => {
    const none = shellSandbox(null);
    expect(await openAppThemeEvidence(none)).toBeNull();
    const odd = shellSandbox('x; rm -rf /');
    expect(await openAppThemeEvidence(odd)).toBeNull();
    expect([...none.commands, ...odd.commands]).toEqual([]);
  });
});
