import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { sql } from '@civitai/db/kysely';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { PRESERVED_VIEW_PAGE, type PreservedVerdict } from '$lib/preserved-view';
import { canAccess } from './access';
import { logToAxiom } from './axiom';
import { dbWrite } from './db';
import { insertModActivity, modActivityRowExists } from './mod-activity';
import {
  createPreservedObjectStore,
  OversizeObjectError,
  type PreservedStoreConfig,
} from './preserved-object-store';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILES = 99;

/** Written before the store is called for a file, whatever happens next. */
export const PRESERVED_SERVED_ACTIVITY = 'preservedFile:served';
/** Written only once the bytes matched the manifest, just before they are sent. */
export const PRESERVED_DELIVERED_ACTIVITY = 'preservedFile:delivered';
export const PRESERVED_VERDICT_ACTIVITY: Record<PreservedVerdict, string> = {
  apparent: 'preservedFile:verdict-apparent',
  not: 'preservedFile:verdict-not',
};
const VERDICT_BY_ACTIVITY = new Map(
  Object.entries(PRESERVED_VERDICT_ACTIVITY).map(([verdict, activity]) => [
    activity,
    verdict as PreservedVerdict,
  ])
);

const SHA256 = /^[0-9a-f]{64}$/;

export type PreservedViewConfig = {
  manifestKey: string;
  manifestSha256: string;
  reviewerIds: ReadonlySet<number>;
  store: PreservedStoreConfig;
};

/** `null` unless every variable is set and well formed; the feature then answers 404 everywhere. */
export function readPreservedViewConfig(
  source: Record<string, string | undefined> = env
): PreservedViewConfig | null {
  const get = (name: string) => source[name]?.trim() ?? '';
  const manifestKey = get('PRESERVED_VIEW_MANIFEST_KEY');
  const manifestSha256 = get('PRESERVED_VIEW_MANIFEST_SHA256');
  const ids = get('PRESERVED_VIEW_USER_IDS')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const store: PreservedStoreConfig = {
    endpoint: get('PRESERVED_VIEW_S3_ENDPOINT'),
    region: get('PRESERVED_VIEW_S3_REGION') || 'us-east-1',
    bucket: get('PRESERVED_VIEW_S3_BUCKET'),
    accessKey: get('PRESERVED_VIEW_S3_KEY'),
    secretKey: get('PRESERVED_VIEW_S3_SECRET'),
  };
  if (!manifestKey || !SHA256.test(manifestSha256)) return null;
  if (!ids.length || !ids.every((id) => /^[1-9][0-9]{0,9}$/.test(id))) return null;
  if (!store.endpoint || !store.bucket || !store.accessKey || !store.secretKey) return null;
  return { manifestKey, manifestSha256, reviewerIds: new Set(ids.map(Number)), store };
}

/**
 * Rows name the file by its own hash, so a verdict stays with the bytes it was about whichever
 * manifest is pinned, and never attaches to a different file at the same position.
 */
const entityTypeOf = (file: PreservedFile) => `preservedFile:${file.sha256.slice(0, 16)}`;

/**
 * Both gates: the page grant (a role), and the reviewer list, which an admin's grant does not pass.
 * Unconfigured is a 404 for everyone, before either.
 */
export function requirePreservedReviewer(locals: App.Locals): {
  config: PreservedViewConfig;
  reviewerId: number;
} {
  const config = readPreservedViewConfig();
  if (!config) error(404, 'Not found.');
  if (!locals.user) error(403, 'Not signed in.');
  if (!canAccess(locals.user, PRESERVED_VIEW_PAGE))
    error(403, 'You do not have access to this page.');
  if (!config.reviewerIds.has(locals.user.id))
    error(403, 'You are not the reviewer for these files.');
  return { config, reviewerId: locals.user.id };
}

/** A file number as the browser sends it: 1 to 99, digits only. */
export function parseFileNumber(raw: string | undefined | null): number | null {
  return raw && /^[1-9][0-9]?$/.test(raw) ? Number(raw) : null;
}

export type PreservedFile = { n: number; key: string; size: number; sha256: string };

export class ManifestRefusedError extends Error {
  constructor(readonly reason: 'missing' | 'sha256' | 'shape') {
    super(`The manifest was refused (${reason}).`);
    this.name = 'ManifestRefusedError';
  }
}

/** Only the error's name: an S3 error carries the bucket and key in its other fields. */
export const errorName = (e: unknown) => (e as { name?: unknown } | null)?.name ?? 'unknown';

const externalEntry = z
  .object({
    status: z.literal('external'),
    size: z.number().int().positive().max(MAX_FILE_BYTES),
    sha256: z.string().regex(SHA256),
    source: z.object({ key: z.string().min(1), bucket: z.string().optional() }),
    pinned: z.object({ size: z.number(), sha256: z.string() }).optional(),
  })
  .refine((e) => !e.pinned || (e.pinned.size === e.size && e.pinned.sha256 === e.sha256));

function externalFiles(manifest: unknown, bucket: string): PreservedFile[] {
  const entries = (manifest as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) throw new ManifestRefusedError('shape');
  const external = entries.filter((e) => (e as { status?: unknown } | null)?.status === 'external');
  if (external.length > MAX_FILES) throw new ManifestRefusedError('shape');
  return external.map((e, i) => {
    const parsed = externalEntry.safeParse(e);
    if (!parsed.success) throw new ManifestRefusedError('shape');
    const { source, size, sha256 } = parsed.data;
    if (source.bucket !== undefined && source.bucket !== bucket)
      throw new ManifestRefusedError('shape');
    return { n: i + 1, key: source.key, size, sha256 };
  });
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * The pinned manifest's external files, and a reader for them. The store lists the manifest key
 * alone until the manifest matches its pin, then adds only the keys that manifest names.
 */
export async function openPreservedFiles(config: PreservedViewConfig) {
  const listed = new Set([config.manifestKey]);
  const store = createPreservedObjectStore(config.store, (key) => listed.has(key));

  const bytes = await store.read(config.manifestKey, MAX_MANIFEST_BYTES).catch((e: unknown) => {
    if (e instanceof OversizeObjectError) throw new ManifestRefusedError('shape');
    throw e;
  });
  if (!bytes) throw new ManifestRefusedError('missing');
  if (sha256Hex(bytes) !== config.manifestSha256) throw new ManifestRefusedError('sha256');
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ManifestRefusedError('shape');
  }
  const files = externalFiles(manifest, config.store.bucket);
  for (const file of files) listed.add(file.key);

  return {
    files,
    read: (file: PreservedFile, signal?: AbortSignal) =>
      store.read(file.key, MAX_FILE_BYTES, signal),
  };
}

/** `openPreservedFiles` as a route answers it: 409 for a refused manifest, 502 for a store error. */
export async function openPreservedFilesOrError(config: PreservedViewConfig) {
  try {
    return await openPreservedFiles(config);
  } catch (e) {
    if (e instanceof ManifestRefusedError) {
      console.error('[preserved-view] manifest refused', e.reason);
      error(409, 'The manifest does not match its pin.');
    }
    console.error('[preserved-view] manifest read failed', errorName(e));
    error(502, 'Could not reach storage.');
  }
}

/** Verdicts recorded so far, by file number. Read from the primary, so a verdict just made is seen. */
export async function preservedVerdicts(
  files: readonly PreservedFile[],
  reviewerIds: ReadonlySet<number>
): Promise<Map<number, PreservedVerdict>> {
  if (!files.length) return new Map();
  const rows = await verdictRows(dbWrite, files.map(entityTypeOf), reviewerIds);
  const out = new Map<number, PreservedVerdict>();
  for (const file of files) {
    const row = rows.find((r) => r.entityType === entityTypeOf(file));
    const verdict = row && VERDICT_BY_ACTIVITY.get(row.activity);
    if (verdict) out.set(file.n, verdict);
  }
  return out;
}

/** The file numbers whose bytes this reviewer has been sent. */
export async function deliveredTo(
  files: readonly PreservedFile[],
  reviewerId: number
): Promise<Set<number>> {
  if (!files.length) return new Set();
  const rows = await dbWrite
    .selectFrom('ModActivity')
    .select('entityType')
    .distinct()
    .where('entityType', 'in', files.map(entityTypeOf))
    .where('activity', '=', PRESERVED_DELIVERED_ACTIVITY)
    .where('userId', '=', reviewerId)
    .execute();
  const sent = new Set(rows.map((r) => r.entityType));
  return new Set(files.filter((f) => sent.has(entityTypeOf(f))).map((f) => f.n));
}

/** The audit row for one serve, written and read back. `false` means call no store and send no bytes. */
export async function auditServe(file: PreservedFile, reviewerId: number): Promise<boolean> {
  try {
    const id = await insertModActivity({
      userId: reviewerId,
      entityType: entityTypeOf(file),
      entityId: file.n,
      activity: PRESERVED_SERVED_ACTIVITY,
      credential: 'web',
    });
    return await modActivityRowExists(id);
  } catch (e) {
    console.error('[preserved-view] served row not written', errorName(e));
    return false;
  }
}

/**
 * Only a listed reviewer's verdict counts: these rows cannot be deleted, so one written by anything
 * else would close a file for good.
 */
function verdictRows(db: Kysely<DB>, entityTypes: string[], reviewerIds: ReadonlySet<number>) {
  return db
    .selectFrom('ModActivity')
    .select(['entityType', 'activity'])
    .where('entityType', 'in', entityTypes)
    .where('activity', 'in', Object.values(PRESERVED_VERDICT_ACTIVITY))
    .where('userId', 'in', [...reviewerIds])
    .execute();
}

/** Serialises everything that reads or writes one file's verdict. */
const lockFile = (trx: Kysely<DB>, entityType: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtext(${entityType}), 0)`.execute(trx);

/**
 * The row that lets a verdict follow, written under the verdict lock so no verdict can land between
 * the check and the send. `ruled` and `failed` both mean send no bytes.
 */
export async function recordDelivery(
  file: PreservedFile,
  reviewerId: number,
  reviewerIds: ReadonlySet<number>
): Promise<'delivered' | 'ruled' | 'failed'> {
  const entityType = entityTypeOf(file);
  try {
    const id = await dbWrite.transaction().execute(async (trx) => {
      await lockFile(trx, entityType);
      if ((await verdictRows(trx, [entityType], reviewerIds)).length) return null;
      return insertModActivity(
        {
          userId: reviewerId,
          entityType,
          entityId: file.n,
          activity: PRESERVED_DELIVERED_ACTIVITY,
          credential: 'web',
        },
        trx
      );
    });
    if (id === null) return 'ruled';
    return (await modActivityRowExists(id)) ? 'delivered' : 'failed';
  } catch (e) {
    console.error('[preserved-view] delivered row not written', errorName(e));
    return 'failed';
  }
}

/** One verdict per file, ever, from a listed reviewer. */
export async function recordPreservedVerdict(
  file: PreservedFile,
  reviewerId: number,
  reviewerIds: ReadonlySet<number>,
  verdict: PreservedVerdict
): Promise<'recorded' | 'already'> {
  const entityType = entityTypeOf(file);
  return dbWrite.transaction().execute(async (trx) => {
    await lockFile(trx, entityType);
    if ((await verdictRows(trx, [entityType], reviewerIds)).length) return 'already';
    await insertModActivity(
      {
        userId: reviewerId,
        entityType,
        entityId: file.n,
        activity: PRESERVED_VERDICT_ACTIVITY[verdict],
      },
      trx
    );
    return 'recorded';
  });
}

export function recordPreservedServe(record: {
  reviewerId: number;
  n: number;
  status: number;
  bytes: number | null;
  sizeMatch: boolean | null;
  sha256Match: boolean | null;
}) {
  void logToAxiom({
    name: 'preserved-file-serve',
    type: 'info',
    moderatorId: record.reviewerId,
    status: record.status,
    bytes: record.bytes,
    payload: { n: record.n, sizeMatch: record.sizeMatch, sha256Match: record.sha256Match },
  });
}

const SIGNATURES: [string, (b: Uint8Array) => boolean][] = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => ascii(b, 1, 4) === 'PNG' && b[0] === 0x89],
  ['image/gif', (b) => ascii(b, 0, 4) === 'GIF8'],
  ['image/webp', (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'],
];

function ascii(bytes: Uint8Array, from: number, to: number) {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/** The image type the bytes themselves declare, or `null` for anything this page will not render. */
export function sniffImageType(bytes: Uint8Array): string | null {
  return SIGNATURES.find(([, matches]) => matches(bytes))?.[0] ?? null;
}
