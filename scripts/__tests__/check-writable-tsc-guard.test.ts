import { describe, expect, it } from 'vitest';

import { directRootTypecheck } from '../../.claude/hooks/check-writable.mjs';

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
    // Not tsc at all.
    ['pnpm run typecheck'],
    ['npx tsx scripts/thing.ts'],
  ])('allows %s', (command) => {
    expect(check(command)).toBe(false);
  });
});
