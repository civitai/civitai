import { apiFor } from './auth';
import { closeDb, dbNow, many, one, timestampSelfCheck } from './db';
import { createArticle } from './drivers';
import { e2eEnv } from './env';
import { fixture, withNonce } from './fixtures';
import { clockSkewError, devDbFingerprintError, modeMismatches, observedPhase } from './logic';
import { harness, runJob } from './ops';
import { getEm, getFreshEm, SCAN_TIMEOUT_MS } from './scan';
import { createUser, ensureUserIdSequence, RESERVED_FIRST_ID } from './users';
import { waitFor } from './wait';

const REQUIRED_PROMPT_KEYS = ['base', 'label:nsfw', 'label:poi', 'label:minor', 'label:scam'];
const DEV_DB_MIN_NEWEST_USER_AGE_S = 600;
const CLOCK_SKEW_TOLERANCE_MS = 2_000;

// The scam sweep jobs and the KeyValue keys they keep their id cursors under.
const SWEEPS = [
  { job: 'text-scan-chat-windows', cursorKey: 'text-scan-chat-cursor', table: 'ChatMessage' },
  { job: 'text-scan-new-users', cursorKey: 'text-scan-new-user-cursor', table: 'User' },
] as const;

async function assertDevDb() {
  const newest = await one<{ ageSeconds: number }>(
    `SELECT extract(epoch FROM (clock_timestamp() AT TIME ZONE 'UTC') - "createdAt")::float AS "ageSeconds"
     FROM "User" WHERE id < $1 ORDER BY id DESC LIMIT 1`,
    [RESERVED_FIRST_ID]
  );
  const error = devDbFingerprintError(newest?.ageSeconds ?? null, DEV_DB_MIN_NEWEST_USER_AGE_S);
  if (error) throw new Error(`TEXT_SCAN_E2E_DB_URL: ${error}`);
}

async function assertClocks() {
  await timestampSelfCheck();
  const error = clockSkewError(await dbNow(), Date.now(), CLOCK_SKEW_TOLERANCE_MS);
  if (error) throw new Error(error);
}

async function probe(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.text() };
}

async function assertTunnel() {
  const { TEXT_SCAN_E2E_CALLBACK_ORIGIN: origin, WEBHOOK_TOKEN: token } = e2eEnv();
  for (const route of ['text-scan-result', 'text-moderation-result']) {
    const url = `${origin}/api/webhooks/${route}`;
    const wrong = await probe(`${url}?token=wrong`);
    if (wrong.status !== 401 || !wrong.body.includes('Unauthorized'))
      throw new Error(
        `tunnel does not reach /api/webhooks/${route} (wrong token got ${wrong.status}); callbacks will never land`
      );
    // Only an app holding this WEBHOOK_TOKEN gets past the token check to the method check.
    const right = await probe(`${url}?token=${encodeURIComponent(token)}`);
    if (right.status !== 405)
      throw new Error(
        `the app behind the tunnel does not hold this WEBHOOK_TOKEN (/api/webhooks/${route} got ${right.status}, expected 405)`
      );
  }
  const exposed = await probe(`${origin}/api/testing/chat-completion-scan`);
  if (exposed.status !== 404)
    throw new Error(
      `the tunnel serves /api/testing (got ${exposed.status}); restrict its ingress to the two /api/webhooks callback paths`
    );
}

async function assertApp() {
  const { TEXT_SCAN_E2E_BASE_URL: base } = e2eEnv();
  const app = await fetch(base, { signal: AbortSignal.timeout(180_000) }).catch((e) => e as Error);
  if (app instanceof Error || app.status >= 500)
    throw new Error(
      `main app not serving at ${base}: ${app instanceof Error ? app.message : app.status}`
    );
}

async function assertPrompts() {
  const prompts = await harness<{ active: Record<string, unknown> }>({ action: 'getPrompts' });
  const missing = REQUIRED_PROMPT_KEYS.filter((k) => !(k in (prompts.active ?? {})));
  if (missing.length)
    throw new Error(`prompt rows missing: ${missing.join(', ')} (insert them with the harness putPrompt action)`);
}

async function assertModes(expected: 'shadow' | 'active') {
  const { modes } = await harness<{ modes: Record<string, unknown> }>({ action: 'getModes' });
  const wrong = modeMismatches(modes, expected);
  if (wrong.length)
    throw new Error(
      `suite asked for ${expected}, the app resolves ${wrong.join(
        ', '
      )}: FLIPT_LOCAL_OVERRIDES is not in effect (set it in the app worktree .env and restart)`
    );
}

/**
 * Points each sweep cursor at the table's newest row before running the job once. A cursor left
 * from an earlier week would otherwise sweep every row the dev re-clone brought in.
 */
async function primeSweeps() {
  for (const { job, cursorKey, table } of SWEEPS) {
    await many(
      `INSERT INTO "KeyValue" (key, value)
       SELECT $1, to_jsonb(COALESCE(max(id), 0)) FROM "${table}"
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [cursorKey]
    );
    await runJob(job);
  }
}

async function assertPhase(expected: 'shadow' | 'active') {
  const owner = await createUser();
  const api = await apiFor(owner.id);
  try {
    const since = await dbNow();
    const id = await createArticle(api, withNonce(fixture('sfw')));
    const seen = await waitFor(
      'phase positive control (Article)',
      async () => {
        const [live, shadow] = await Promise.all([
          getFreshEm('Article', id, 'live', since),
          getFreshEm('Article', id, 'shadow', since),
        ]);
        const phase = observedPhase({ live, shadow });
        if (phase) return { done: true, value: phase };
        const [anyLive, anyShadow] = await Promise.all([
          getEm('Article', id, 'live'),
          getEm('Article', id, 'shadow'),
        ]);
        return {
          done: false,
          observed: { live: anyLive?.status ?? null, shadow: anyShadow?.status ?? null },
        };
      },
      { timeoutMs: SCAN_TIMEOUT_MS }
    );
    if (seen !== expected)
      throw new Error(`app wrote the Article verdict in ${seen}, suite asked for ${expected}`);

    const row = await one<{ ageSeconds: number }>(
      `SELECT extract(epoch FROM (clock_timestamp() AT TIME ZONE 'UTC') - "updatedAt")::float AS "ageSeconds"
       FROM "EntityModeration" WHERE "entityType" = $1 AND "entityId" = $2`,
      [seen === 'shadow' ? 'Article:shadow' : 'Article', id]
    );
    if (!row || row.ageSeconds < -CLOCK_SKEW_TOLERANCE_MS / 1000)
      throw new Error(
        `the app stamped the Article verdict ${
          row ? -row.ageSeconds : '?'
        }s in the future of the DB clock; freshness checks cannot be trusted`
      );
  } finally {
    await api.dispose();
  }
}

export default async function globalSetup() {
  const env = e2eEnv();
  try {
    await assertDevDb();
    await assertClocks();
    await assertApp();
    await assertTunnel();
    await assertPrompts();
    await ensureUserIdSequence();
    if (env.TEXT_SCAN_E2E_PHASE !== 'calibrate') {
      await assertModes(env.TEXT_SCAN_E2E_PHASE);
      await primeSweeps();
      await assertPhase(env.TEXT_SCAN_E2E_PHASE);
    }
  } finally {
    await closeDb();
  }
}
