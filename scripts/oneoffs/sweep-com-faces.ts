/**
 * One-off: put .com faces saved before the listing intent check stored its verdicts through the
 * same path a face save takes today (`resolveComFaceIntent`). The verdict is stored and, for a
 * detection on an eligible mature model, the `com-face-intent` nsfw lock is added, which the owner
 * can dispute. No face is removed.
 *
 * Usage (repo root, with the app's env):
 *   pnpm run tsscript scripts/oneoffs/sweep-com-faces.ts --limit 200
 *     Dry run on a random sample of that many candidates. Asks the classifier once per model and
 *     writes nothing to the database.
 *   pnpm run tsscript scripts/oneoffs/sweep-com-faces.ts --apply --limit <n>
 *     The next n candidates by id. Re-run it to continue: a model with a stored verdict is no
 *     longer a candidate.
 *   Both take --concurrency (default 4).
 *
 * Prints counts only, never model ids, text or reasons; it refuses to start with a `prisma*` entry in
 * LOGGING, which prints each query's parameters. A model with a logged moderator nsfw ruling is not
 * locked; rulings from the model form before 2026-10-20 were never logged, so those are not seen.
 */
import path from 'path';
import type { ComFaceIntentWrites } from '~/server/services/model-sfw-face.service';

export const SCRIPT_BASENAME = 'sweep-com-faces';

export type Face = {
  id: number;
  userId: number;
  name: string;
  description: string | null;
  nsfw: boolean;
  minor: boolean;
  poi: boolean;
  sfwOnly: boolean;
  lockedProperties: string[];
  meta: unknown;
};

export type NotLockedReason =
  | 'not-mature'
  | 'minor'
  | 'poi'
  | 'sfw-only'
  | 'already-locked'
  | 'relock-suppressed'
  | 'moderator-ruled'
  | 'lock-refused';
export type Outcome = 'allowed' | 'unavailable' | 'locked' | NotLockedReason;

/**
 * Why `lockForComFaceIntent` would not lock this detected model, mirroring its WHERE minus the
 * stored-verdict terms. shortcut: a copy used only for the dry run's breakdown; the apply decides by
 * the real UPDATE (anything it refuses that this misses is counted `lock-refused`).
 */
export function notLockedReason(face: Face, textHash: string): NotLockedReason | null {
  if (!face.nsfw) return 'not-mature';
  if (face.minor) return 'minor';
  if (face.poi) return 'poi';
  if (face.sfwOnly) return 'sfw-only';
  if (face.lockedProperties.includes('nsfw')) return 'already-locked';
  const suppressed = (face.meta as { comFaceIntentRelockSuppressed?: { textHash?: string } } | null)
    ?.comFaceIntentRelockSuppressed;
  if (suppressed?.textHash === textHash) return 'relock-suppressed';
  return null;
}

/** One face through the face-save path. A dry run swaps in writes that touch nothing. */
export async function sweepOne(face: Face, apply: boolean): Promise<Outcome> {
  const { getOwnTriggerWords, recordComFaceIntent, lockForComFaceIntent, comFaceIntentTextHash } =
    await import('~/server/services/model-com-face-intent.service');
  const { resolveComFaceIntent } = await import('~/server/services/model-sfw-face.service');
  const { moderatorRuledNsfwSince } = await import('~/server/services/rating-review.entities');

  const listing = {
    name: face.name,
    description: face.description,
    triggerWords: await getOwnTriggerWords({ modelId: face.id, userId: face.userId }),
  };
  const textHash = comFaceIntentTextHash(listing);
  // A face save checks for a moderator's nsfw ruling only since a stored verdict, and no candidate
  // has one: a ruling made before `comFaceIntentRelockSuppressed` existed would go unseen, and a
  // bulk lock would override it. So any logged moderator nsfw ruling keeps the sweep's lock off.
  let ruled = false;
  const lock: ComFaceIntentWrites['lock'] = async (modelId, hash) => {
    if (await moderatorRuledNsfwSince(modelId, new Date(0))) {
      ruled = true;
      return false;
    }
    return apply ? lockForComFaceIntent(modelId, hash) : notLockedReason(face, hash) === null;
  };
  const writes: ComFaceIntentWrites = {
    record: apply ? recordComFaceIntent : async () => undefined,
    lock,
  };
  const verdict = await resolveComFaceIntent(
    { ...listing, modelId: face.id, userId: face.userId },
    writes
  );
  if (verdict.status !== 'detected') return verdict.status;
  if (verdict.disputable) return 'locked';
  if (ruled) return 'moderator-ruled';
  return notLockedReason(face, textHash) ?? 'lock-refused';
}

export async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    })
  );
}

export async function sweep(faces: Face[], apply: boolean, concurrency: number) {
  const outcomes: Partial<Record<Outcome, number>> = {};
  const owners = new Set<number>();
  // By error class only: a message can carry a model's text.
  const failed: Record<string, number> = {};
  await pool(faces, concurrency, async (face) => {
    const outcome = await sweepOne(face, apply).catch((error: unknown) => {
      const kind = error instanceof Error ? error.constructor.name : typeof error;
      failed[kind] = (failed[kind] ?? 0) + 1;
      return null;
    });
    if (!outcome) return;
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (outcome === 'locked') owners.add(face.userId);
  });
  return { outcomes, ownersLocked: owners.size, failed };
}

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Candidates: the next `limit` by id for an apply, a random sample for a dry run. */
export async function readCandidates(limit: number, apply: boolean) {
  const { Prisma } = await import('@prisma/client');
  const { dbRead } = await import('~/server/db/client');
  // A candidate is a .com face (cover and .com title, as the edit re-check reads one) with no
  // stored verdict. A cover with no Image row is counted, never checked.
  const candidate = Prisma.sql`
    m."sfwCoverImageId" IS NOT NULL AND m."sfwName" IS NOT NULL AND m."deletedAt" IS NULL
    AND NOT (m.meta ? 'comFaceIntent')`;
  const coverExists = Prisma.sql`EXISTS (SELECT 1 FROM "Image" i WHERE i.id = m."sfwCoverImageId")`;
  const [{ candidates, dangling }] = await dbRead.$queryRaw<
    { candidates: number; dangling: number }[]
  >`
    SELECT count(*) FILTER (WHERE ${coverExists})::int AS candidates,
           count(*) FILTER (WHERE NOT ${coverExists})::int AS dangling
    FROM "Model" m WHERE ${candidate}`;
  const faces = await dbRead.$queryRaw<Face[]>`
    SELECT m.id, m."userId", m.name, m.description, m.nsfw, m.minor, m.poi, m."sfwOnly",
           COALESCE(m."lockedProperties", ARRAY[]::text[]) AS "lockedProperties", m.meta
    FROM "Model" m WHERE ${candidate} AND ${coverExists}
    ORDER BY ${apply ? Prisma.sql`m.id` : Prisma.sql`random()`}
    LIMIT ${limit}`;

  return { candidates, dangling, faces };
}

class UsageError extends Error {}

/** The services' `logToAxiom` echoes each event, model id and error text included, to stdout outside
 *  production, which is how `tsscript` runs. Dropped here, counted: stdout stays counts only. */
export function muteAxiomEcho() {
  const log = console.log;
  const muted: Record<string, number> = {};
  console.log = (...args: unknown[]) => {
    if (args[0] !== 'logToAxiom') return log(...args);
    const event = args[1] as { name?: string; message?: string } | undefined;
    // The services' fixed messages ('lock not added') are kept; a free-form error text is not.
    const fixed = typeof event?.message === 'string' && /^[a-z ]{1,40}$/i.test(event.message);
    const key = `${event?.name}: ${fixed ? event?.message : 'other'}`;
    muted[key] = (muted[key] ?? 0) + 1;
  };
  return muted;
}

async function main() {
  if (/(^|,)\s*prisma/.test(process.env.LOGGING ?? ''))
    throw new UsageError('unset the prisma entries in LOGGING: they print query parameters');
  const muted = muteAxiomEcho();
  const apply = process.argv.includes('--apply');
  const limit = Number(arg('--limit'));
  const concurrency = Number(arg('--concurrency') ?? 4);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit <n> is required');
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new UsageError('--concurrency must be a whole number from 1');

  const { candidates, dangling, faces } = await readCandidates(limit, apply);
  const started = Date.now();
  const { outcomes, ownersLocked, failed } = await sweep(faces, apply, concurrency);
  console.log({
    mode: apply ? 'apply' : 'dry run (no writes; locked = would lock)',
    candidates,
    danglingCover: dangling,
    checked: faces.length,
    classifierCalls: faces.length,
    ...outcomes,
    ownersLocked,
    failed,
    // By event name and message only; the echo's model ids and error text are dropped.
    mutedLogLines: muted,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
  });
  if (!apply) return;
  // As high as `candidates` means the run made no progress (verdicts not stored).
  const after = await readCandidates(1, apply).catch(() => null);
  console.log({ candidatesAfter: after?.candidates ?? 'count failed' });
}

if (path.basename(process.argv[1] ?? '').startsWith(`${SCRIPT_BASENAME}.`))
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      // Only our own usage errors are printed whole: a database error can carry row text.
      console.error(e instanceof UsageError ? e.message : `failed: ${e?.constructor?.name}`);
      process.exit(1);
    });
