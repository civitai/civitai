import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { directRootTypecheck } from '../../.claude/hooks/check-writable.logic.mjs';

/**
 * The tsc guard's matcher had NO automated coverage when it shipped: `check-writable.selftest.mjs`
 * exercises it, but nothing in this repo runs a `*.selftest.mjs` — no package script, no workflow,
 * and `dev-server-daemon-port.test.ts` explicitly skips that suffix. A review found five spellings
 * of a full root typecheck walking past it and one legitimate per-app check denied, and neither
 * could have failed anything.
 */
const check = directRootTypecheck as (command: string) => boolean;

describe('the direct-tsc guard blocks a full root typecheck', () => {
  it.each([
    ['npx tsc --noEmit'],
    ['npx tsc --noEmit -p tsconfig.json'],
    ['npx tsc --noEmit -p .'],
    ['pnpm exec tsc --noEmit'],
    // Runner flags before `exec`. Required `exec` IMMEDIATELY after the runner before, so both of
    // these ran unguarded — and `-w` is how you spell "the root program" in a pnpm workspace.
    ['pnpm -w exec tsc --noEmit'],
    ['pnpm --filter model-share exec tsc --noEmit'],
    ['npm exec tsc -- --noEmit'],
    ['bunx tsc --noEmit'],
    ['npx "tsc" --noEmit'],
    // `npx`/`bunx` take flags of their own, and the flag-tolerant group was added for the other
    // runners only. `-y` is what an agent types when npx would otherwise prompt.
    ['npx -y tsc --noEmit'],
    ['npx --no-install tsc --noEmit'],
    ['bunx --bun tsc --noEmit'],
    // No `exec` at all: both runners run a workspace bin directly, and this is the SHORTEST
    // spelling of the thing being blocked.
    ['pnpm tsc --noEmit'],
    ['yarn tsc --noEmit'],
    // Quotes are stripped per token, which leaves the opening one attached after the `=` split.
    ['npx tsc --noEmit --project="tsconfig.json"'],
    ["npx tsc --noEmit -p 'tsconfig.json'"],
    // `.bin/tsc` reached by any path, and tsc's other entry point.
    ['../node_modules/.bin/tsc --noEmit'],
    ['node ./node_modules/typescript/bin/tsc --noEmit'],
    // pnpm's own word for "the root", whatever else the segment says.
    ['pnpm -w exec tsc --noEmit'],
    // A `cd` out of a package and back to the root does not stay exempt.
    ['cd apps/x && cd ../.. && npx tsc --noEmit'],
    ['cd C:/Dev/Repos/work/model-share && npx tsc --noEmit'],
    ['node ./node_modules/typescript/lib/tsc.js --noEmit'],
    // A root program reached by another path is the same program.
    ['npx tsc --noEmit -p ../other-worktree/tsconfig.json'],
    // The tsc segment is what matters, not the first one.
    ['git fetch origin main && npx tsc --noEmit'],
    // A `cd` to the repo root is still the root program.
    ['cd C:/Dev/Repos/work/model-share && npx tsc --noEmit'],
    // tsc takes a DIRECTORY for -p and resolves its tsconfig.json, so dropping the filename was a
    // one-token bypass: these check exactly what the `…/tsconfig.json` spellings below check.
    ['npx tsc --noEmit -p ../other-worktree'],
    ['npx tsc --noEmit -p ..'],
    ['npx tsc --noEmit -p C:/Dev/Repos/work/model-share'],
    // pnpm's SET selectors each choose N packages, which is worse than the root program rather
    // than narrower. The recursive spelling was already denied; these four were not.
    ["pnpm --filter '!@civitai/ui' exec tsc --noEmit"],
    ["pnpm --filter '*' exec tsc --noEmit"],
    ['pnpm --filter ...@civitai/ui exec tsc --noEmit'],
    ["pnpm --filter './...' exec tsc --noEmit"],
    ['pnpm -r exec tsc --noEmit'],
  ])('blocks %s', (command) => {
    expect(check(command)).toBe(true);
  });
});

describe('the direct-tsc guard leaves a narrow run alone', () => {
  it.each([
    // The scripts gate recommends this one by name.
    ['npx tsc --noEmit -p tsconfig.scripts.json'],
    ['npx tsc --noEmit src/utils/foo.ts'],
    ['npx tsc --version'],
    ['npx tsc --build'],
    ['TYPECHECK_DIRECT=1 npx tsc --noEmit'],
    // `pnpm run typecheck` does not cover `apps/` — only CI's typecheck-apps.mjs does — so denying
    // a per-app check sends an agent to a command that cannot see the files it asked about.
    ['cd apps/notifications && npx tsc --noEmit'],
    ['cd apps/moderator && pnpm exec tsc --noEmit'],
    ['pnpm --filter ./apps/creator-studio exec tsc --noEmit'],
    // tsc resolves a DIRECTORY to its tsconfig.json, so the narrow spelling has to be a project
    // file with another name — dropping the filename is the root program, not a smaller one.
    ['npx tsc --noEmit -p apps/moderator'],
    // A package is addressed by PATH or by NAME, and no workspace package's NAME contains a path.
    // Matching a path alone denied every by-name filter — this guard's own bug, by the other
    // spelling. `@civitai/moderator-app` is a real name in this repo; `model-share` is the root.
    ['pnpm --filter @civitai/moderator-app exec tsc --noEmit'],
    ['pnpm --filter @civitai/ui exec tsc --noEmit'],
    // The subshell form of the same thing.
    ['(cd apps/moderator && npx tsc --noEmit)'],
    // `;` is a cd like any other: the shell is in the package when tsc runs.
    ['cd apps/moderator; npx tsc --noEmit'],
    ['pnpm -C packages/civitai-ui exec tsc --noEmit'],
    ['npx tsc --noEmit -p apps/storage/tsconfig.json'],
    // Managing the package is not running it. The flag-value group ate the verb, so these read as
    // `<runner> <flag> tsc` and were denied — `pnpm -r add <pkg>` is an ordinary command.
    ['pnpm -r add tsc'],
    ['pnpm -D add tsc'],
    ['pnpm -r why tsc'],
    ['npm i --save-dev tsc'],
    // Not tsc at all.
    ['pnpm run typecheck'],
    ['npx tsx scripts/thing.ts'],
  ])('allows %s', (command) => {
    expect(check(command)).toBe(false);
  });
});

/**
 * 🔴 The guard is a PROCESS, and every test above imports it instead. That gap hid a defect that
 * disabled the hook outright: a main-module self-check compared `resolve(process.argv[1])` (not a
 * realpath) against `import.meta.url` (a realpath), so behind a symlink or a directory junction it
 * attached no stdin handler, exited 0, and every Bash command ran unguarded — the taskkill block
 * and the DB-write confirmation included, silently. Inverting that condition left every imported
 * test green.
 *
 * These spawn it. The junction case is the realistic one: this repo junctions node_modules between
 * worktrees, so a junction in the path is not hypothetical.
 */
describe('the hook answers when it is run as a process', () => {
  const hooks = resolve(__dirname, '../../.claude/hooks');
  const tmp = mkdtempSync(join(tmpdir(), 'hook-link-'));
  const linked = join(tmp, 'hooks');
  symlinkSync(hooks, linked, 'junction');
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const ask = (hookPath: string) =>
    spawnSync(process.execPath, [join(hookPath, 'check-writable.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npx tsc --noEmit' } }),
      encoding: 'utf8',
      timeout: 30_000,
    });

  it.each([
    ['its own path', () => hooks],
    ['a directory junction', () => linked],
  ])('denies a full root typecheck through %s', (_label, path) => {
    const r = ask(path());
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('allows an ordinary command, so the deny above is not just "it always denies"', () => {
    const r = spawnSync(process.execPath, [join(hooks, 'check-writable.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
