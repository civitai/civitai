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
 *   pnpm run tsscript scripts/oneoffs/sweep-com-faces.ts --apply --limit <n> --max-locks <m> --list-out <new file>
 *     The next n candidates by id, stopping before a lock past m. Re-run it to continue: a model
 *     with a stored verdict is no longer a candidate.
 *   Both take --concurrency (default 4).
 *
 * Prints counts only, never model ids, text or reasons; it refuses to start with a `prisma*` entry in
 * LOGGING, which prints each query's parameters. A model with a logged moderator nsfw ruling is not
 * locked. Rulings from the model form were not logged until the 2026-10-20 deploy, so a would-lock
 * model with any ModActivity (other than the system's) before 2026-10-21 is not locked either
 * (`moderator-list`). A form ruling that left no ModActivity is not seen. The apply writes each
 * `locked`, `lock-error` and `moderator-list` model id to the --list-out file, private, so a lock
 * can be reversed by id and a listed model reviewed.
 */
import { existsSync, openSync, writeSync } from 'fs';
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
  /** Someone other than the system acted on the model or a version before rulings were logged. */
  touchedBeforeLogging: boolean;
};

export type NotLockedReason =
  | 'not-mature'
  | 'minor'
  | 'poi'
  | 'sfw-only'
  | 'already-locked'
  | 'relock-suppressed'
  | 'moderator-ruled'
  | 'moderator-list'
  | 'lock-refused'
  | 'lock-error';
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

/**
 * A held-back model's verdict. A stored detection is reused by the owner's next face save, which
 * looks for a moderator ruling only since that verdict, so it would lock the model after all. The
 * re-lock suppression a moderator's unlock writes goes first, so the stored detection never locks
 * this text.
 */
export async function recordHeldBack(
  ...[modelId, record]: Parameters<ComFaceIntentWrites['record']>
) {
  const { recordComFaceIntent, suppressComFaceIntentRelockSql } = await import(
    '~/server/services/model-com-face-intent.service'
  );
  const { dbWrite } = await import('~/server/db/client');
  if (record.detected)
    await dbWrite.$executeRaw(suppressComFaceIntentRelockSql(modelId, record.textHash));
  await recordComFaceIntent(modelId, record);
}

/** One face through the face-save path. A dry run swaps in writes that touch nothing. */
export async function sweepOne(face: Face, apply: boolean): Promise<Outcome> {
  const {
    getOwnTriggerWords,
    recordComFaceIntent,
    lockForComFaceIntent,
    comFaceIntentTextHash,
    suppressComFaceIntentRelock,
  } = await import('~/server/services/model-com-face-intent.service');
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
  // An unlogged ruling may sit behind an early moderator action: those go to a moderator list.
  const heldBack: 'moderator-ruled' | 'moderator-list' | null = (await moderatorRuledNsfwSince(
    face.id,
    new Date(0)
  ))
    ? 'moderator-ruled'
    : face.touchedBeforeLogging
    ? 'moderator-list'
    : null;
  let lockReached = false;
  // The resolver swallows a lock error into "not locked", after the verdict is stored. Kept apart
  // from a refusal: the lock may have committed (the replication-lag flag runs after it), and the
  // model is no longer a candidate, so it is found again by its stored detection without a lock.
  let lockError = false;
  const lock: ComFaceIntentWrites['lock'] = async (modelId, hash) => {
    lockReached = true;
    if (heldBack) return false;
    try {
      return apply
        ? await lockForComFaceIntent(modelId, hash)
        : notLockedReason(face, hash) === null;
    } catch (error) {
      lockError = true;
      throw error;
    }
  };
  const writes: ComFaceIntentWrites = {
    record: !apply ? async () => undefined : heldBack ? recordHeldBack : recordComFaceIntent,
    lock,
    suppress: apply ? suppressComFaceIntentRelock : async () => undefined,
  };
  const verdict = await resolveComFaceIntent(
    { ...listing, modelId: face.id, userId: face.userId },
    writes
  );
  if (verdict.status !== 'detected') return verdict.status;
  if (verdict.disputable) return 'locked';
  if (lockError) return 'lock-error';
  if (heldBack && lockReached) return heldBack;
  return notLockedReason(face, textHash) ?? 'lock-refused';
}

/** The outcomes whose model ids the apply writes to the --list-out file. */
const ID_OUT: Outcome[] = ['locked', 'lock-error', 'moderator-list'];

export async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  stop: () => boolean = () => false
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length && !stop()) await fn(items[next++]);
    })
  );
  return items.length - next;
}

export async function sweep(
  faces: Face[],
  apply: boolean,
  concurrency: number,
  onIdOut: (outcome: Outcome, modelId: number) => void = () => undefined,
  maxLocks = Infinity
) {
  const outcomes: Partial<Record<Outcome, number>> = {};
  const owners = new Set<number>();
  // By error class only: a message can carry a model's text.
  const failed: Record<string, number> = {};
  let inFlight = 0;
  // Stops starting faces while every one in flight could still lock and reach the cap, so locks
  // never pass it. A lock error may have committed, so it counts. The rest stay candidates.
  const atCap = () => (outcomes.locked ?? 0) + (outcomes['lock-error'] ?? 0) + inFlight >= maxLocks;
  const unchecked = await pool(
    faces,
    concurrency,
    async (face) => {
      inFlight++;
      const outcome = await sweepOne(face, apply).catch((error: unknown) => {
        const kind = error instanceof Error ? error.constructor.name : typeof error;
        failed[kind] = (failed[kind] ?? 0) + 1;
        return null;
      });
      // Left in flight until its outcome is counted, or another worker could slip past the cap.
      inFlight--;
      if (!outcome) return;
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if (outcome === 'locked') owners.add(face.userId);
      if (ID_OUT.includes(outcome)) onIdOut(outcome, face.id);
    },
    atCap
  );
  return { outcomes, ownersLocked: owners.size, failed, unchecked };
}

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Candidates: the next `limit` by id for an apply, a random sample for a dry run. */
export async function readCandidates(limit: number, apply: boolean) {
  const { Prisma } = await import('@prisma/client');
  const { dbRead } = await import('~/server/db/client');
  const { constants } = await import('~/server/common/constants');
  const SYSTEM_USER_ID = constants.system.user.id;
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
           COALESCE(m."lockedProperties", ARRAY[]::text[]) AS "lockedProperties", m.meta,
           EXISTS (
             SELECT 1 FROM "ModActivity" a
             WHERE a."createdAt" < '2026-10-21' AND a."userId" <> ${SYSTEM_USER_ID}
               AND ((a."entityType" IN ('model', 'Model') AND a."entityId" = m.id)
                 OR (a."entityType" IN ('modelVersion', 'ModelVersion') AND a."entityId" IN
                   (SELECT v.id FROM "ModelVersion" v WHERE v."modelId" = m.id)))
           ) AS "touchedBeforeLogging"
    FROM "Model" m WHERE ${candidate} AND ${coverExists}
    ORDER BY ${apply ? Prisma.sql`m.id` : Prisma.sql`random()`}
    LIMIT ${limit}`;

  return { candidates, dangling, faces };
}

class UsageError extends Error {}

/** The private --list-out file: a new file only, owner-readable, one `<outcome>\t<model id>` line
 *  per model, written as it happens through the one descriptor that created it. */
export function openIdOut(listOut: string) {
  const fd = openSync(listOut, 'wx', 0o600);
  return (outcome: Outcome, id: number) => writeSync(fd, `${outcome}\t${id}\n`);
}

/** `LOGGING` with a `prisma*` entry prints each query's parameters. Read after the env files load,
 *  as the db client reads it, or a value set only in `.env.local` would pass. */
export async function assertNoPrismaLogging() {
  await import('~/env/server');
  if (/(^|,)\s*prisma/.test(process.env.LOGGING ?? ''))
    throw new UsageError('unset the prisma entries in LOGGING: they print query parameters');
}

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
  await assertNoPrismaLogging();
  const muted = muteAxiomEcho();
  const apply = process.argv.includes('--apply');
  const limit = Number(arg('--limit'));
  const concurrency = Number(arg('--concurrency') ?? 4);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit <n> is required');
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new UsageError('--concurrency must be a whole number from 1');

  // The apply's moderator list holds model ids: a private file, never an existing one.
  const listOut = arg('--list-out');
  if (listOut?.startsWith('-')) throw new UsageError('--list-out needs a path');
  if (apply && !listOut) throw new UsageError('--apply needs --list-out <new path>');
  // A run that reaches the ceiling stops, so a person decides before more locks land.
  const maxLocks = Number(arg('--max-locks'));
  if (apply && (!Number.isInteger(maxLocks) || maxLocks < 1))
    throw new UsageError('--apply needs --max-locks <n>');
  if (listOut && existsSync(listOut)) throw new UsageError('--list-out exists; pass a new path');
  // Appended as each model is listed, since its verdict is already stored and a re-run skips it.
  // shortcut: a crash between that store and the append drops the id; re-read verdicts if one does.
  const onIdOut = apply && listOut ? openIdOut(listOut) : undefined;

  const { candidates, dangling, faces } = await readCandidates(limit, apply);
  const started = Date.now();
  const { outcomes, ownersLocked, failed, unchecked } = await sweep(
    faces,
    apply,
    concurrency,
    onIdOut,
    apply ? maxLocks : Infinity
  );
  console.log({
    mode: apply ? 'apply' : 'dry run (no writes; locked = would lock)',
    candidates,
    danglingCover: dangling,
    checked: faces.length - unchecked,
    classifierCalls: faces.length - unchecked,
    ...(unchecked && { stoppedAtMaxLocks: maxLocks, unchecked }),
    ...outcomes,
    ownersLocked,
    failed,
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
