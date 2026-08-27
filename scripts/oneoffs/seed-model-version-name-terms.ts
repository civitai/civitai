/**
 * Seed (or replace) the curated term list that model VERSION name moderation decides on.
 *
 * Seeding this key is what turns the feature on: the list decides, and an empty or absent key
 * selects nothing. There is no feature flag in front of it, so run this deliberately.
 *
 *   # inspect what is live now — prints counts, never the terms
 *   NODE_ENV=development pnpm exec tsx --env-file=.env \
 *     scripts/oneoffs/seed-model-version-name-terms.ts --show
 *
 *   # replace the live list with a local file
 *   NODE_ENV=development pnpm exec tsx --env-file=.env \
 *     scripts/oneoffs/seed-model-version-name-terms.ts \
 *     --terms-file local/model-name-terms.json --confirm
 *
 * `--confirm` is required for the write, because the target is whatever REDIS_SYS_URL resolves
 * to and that is usually production.
 *
 * The terms live in a gitignored file and in Redis, never in this repository — a trigger list
 * is a decision rule an evader can route around (CLAUDE.md → Security). Nothing here prints a
 * term, so the output of a run is safe to paste anywhere.
 */
import { readFileSync } from 'fs';
import { parseArgs } from 'util';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { setModelVersionNameTerms } from '~/server/services/model-version-name-terms.service';
import type { LabelRegexSpec } from '~/server/services/scanner-label-regex';

const KEY = REDIS_SYS_KEYS.MODEL_VERSION_NAME_MODERATION.TERMS;

const { values } = parseArgs({
  options: {
    'terms-file': { type: 'string' },
    confirm: { type: 'boolean' },
    show: { type: 'boolean' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * The clients connect in the background and the connect promise is not exposed, so a
 * short-lived script races it and the first command throws ClientOfflineError. Polling a cheap
 * command is the only readiness signal available from outside the package.
 */
async function waitForSysRedis(timeoutMs = 15_000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      await sysRedis.exists(KEY);
      return;
    } catch (e) {
      if (Date.now() - startedAt > timeoutMs) throw e;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Read raw rather than through `getModelVersionNameTerms`. That helper fails to an EMPTY list
 * so a Redis outage cannot silently widen what gets scanned — correct on the request path, and
 * badly wrong here, where it would report a failed read as "the key is empty" and invite you to
 * overwrite a live list you never actually saw.
 */
async function readLive(): Promise<LabelRegexSpec | null> {
  return sysRedis.packed.get<LabelRegexSpec>(KEY);
}

function describe(spec: LabelRegexSpec | null) {
  if (!spec) return { absent: true };
  return {
    triggers: spec.triggers?.length ?? 0,
    phrasePatterns: spec.phrasePatterns?.length ?? 0,
    carveOutPatterns: spec.carveOutPatterns?.length ?? 0,
  };
}

async function main() {
  await waitForSysRedis();

  if (values.show) {
    console.log('live:', describe(await readLive()));
    return;
  }

  if (!values['terms-file']) fail('--terms-file is required (or --show)');

  let spec: LabelRegexSpec;
  try {
    spec = JSON.parse(readFileSync(values['terms-file'], 'utf-8')) as LabelRegexSpec;
  } catch (e) {
    return fail(`could not read --terms-file: ${(e as Error).message}`);
  }
  if (!Array.isArray(spec.triggers)) fail('--terms-file must contain a `triggers` array');
  if (!spec.triggers.length)
    fail('refusing to seed an empty trigger list — that is the off switch');

  const before = describe(await readLive());
  const after = describe(spec);

  if (!values.confirm) {
    console.log('DRY RUN — pass --confirm to write');
    console.log({ before, after });
    return;
  }

  await setModelVersionNameTerms(spec);

  // Read back through the same decode path a request uses. A packed value that writes fine and
  // decodes to nothing would otherwise look exactly like a successful seed.
  const live = describe(await readLive());
  console.log({ before, wrote: after, live });
  if ('absent' in live || live.triggers !== after.triggers)
    fail('read-back mismatch — the live list is not what was written');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
