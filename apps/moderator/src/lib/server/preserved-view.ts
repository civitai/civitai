import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { sql } from '@civitai/db/kysely';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { PRESERVED_VIEW_PAGE, type PreservedVerdict } from '$lib/preserved-view';
import { canAccess } from './access';
import { logToAxiom } from './axiom';
import { dbWrite } from './db';
import { insertModActivity, modActivityRowExists } from './mod-activity';
import { createPreservedObjectStore, type PreservedStoreConfig } from './preserved-object-store';

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
 * Every row names the pinned manifest as well as the file's position in it, so pinning another
 * manifest never inherits a verdict or a view recorded against a different file at that position.
 */
const entityTypeOf = (config: PreservedViewConfig) =>
  `preservedFile:${config.manifestSha256.slice(0, 16)}`;

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
    source: z.object({ key: z.string().min(1) }),
    pinned: z.object({ size: z.number(), sha256: z.string() }).optional(),
  })
  .refine((e) => !e.pinned || (e.pinned.size === e.size && e.pinned.sha256 === e.sha256));

function externalFiles(manifest: unknown): PreservedFile[] {
  const entries = (manifest as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) throw new ManifestRefusedError('shape');
  const external = entries.filter((e) => (e as { status?: unknown } | null)?.status === 'external');
  if (external.length > MAX_FILES) throw new ManifestRefusedError('shape');
  return external.map((e, i) => {
    const parsed = externalEntry.safeParse(e);
    if (!parsed.success) throw new ManifestRefusedError('shape');
    const { source, size, sha256 } = parsed.data;
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

  const bytes = await store.read(config.manifestKey, MAX_MANIFEST_BYTES);
  if (!bytes) throw new ManifestRefusedError('missing');
  if (sha256Hex(bytes) !== config.manifestSha256) throw new ManifestRefusedError('sha256');
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ManifestRefusedError('shape');
  }
  const files = externalFiles(manifest);
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
  config: PreservedViewConfig
): Promise<Map<number, PreservedVerdict>> {
  const rows = await dbWrite
    .selectFrom('ModActivity')
    .select(['entityId', 'activity'])
    .where('entityType', '=', entityTypeOf(config))
    .where('activity', 'in', Object.values(PRESERVED_VERDICT_ACTIVITY))
    .execute();
  const out = new Map<number, PreservedVerdict>();
  for (const row of rows) {
    const verdict = VERDICT_BY_ACTIVITY.get(row.activity);
    if (row.entityId !== null && verdict && !out.has(row.entityId)) out.set(row.entityId, verdict);
  }
  return out;
}

/** The file numbers whose bytes this reviewer has been sent. */
export async function deliveredTo(
  config: PreservedViewConfig,
  reviewerId: number
): Promise<Set<number>> {
  const rows = await dbWrite
    .selectFrom('ModActivity')
    .select('entityId')
    .distinct()
    .where('entityType', '=', entityTypeOf(config))
    .where('activity', '=', PRESERVED_DELIVERED_ACTIVITY)
    .where('userId', '=', reviewerId)
    .execute();
  return new Set(rows.flatMap((r) => (r.entityId === null ? [] : [r.entityId])));
}

async function writeAndReadBack(
  config: PreservedViewConfig,
  reviewerId: number,
  n: number,
  activity: string
): Promise<boolean> {
  try {
    const id = await insertModActivity({
      userId: reviewerId,
      entityType: entityTypeOf(config),
      entityId: n,
      activity,
      credential: 'web',
    });
    return await modActivityRowExists(id);
  } catch (e) {
    console.error('[preserved-view] audit row not written', activity, errorName(e));
    return false;
  }
}

/** The audit row for one serve, written and read back. `false` means call no store and send no bytes. */
export const auditServe = (config: PreservedViewConfig, reviewerId: number, n: number) =>
  writeAndReadBack(config, reviewerId, n, PRESERVED_SERVED_ACTIVITY);

/** The row that lets a verdict follow. `false` means send no bytes. */
export const recordDelivery = (config: PreservedViewConfig, reviewerId: number, n: number) =>
  writeAndReadBack(config, reviewerId, n, PRESERVED_DELIVERED_ACTIVITY);

/**
 * One verdict per file, ever. The advisory lock serialises two submits for the same file, which a
 * check-then-insert alone would let both through.
 */
export async function recordPreservedVerdict(
  config: PreservedViewConfig,
  reviewerId: number,
  n: number,
  verdict: PreservedVerdict
): Promise<'recorded' | 'already'> {
  const entityType = entityTypeOf(config);
  return dbWrite.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${entityType}), ${n}::int)`.execute(trx);
    const existing = await trx
      .selectFrom('ModActivity')
      .select('id')
      .where('entityType', '=', entityType)
      .where('entityId', '=', n)
      .where('activity', 'in', Object.values(PRESERVED_VERDICT_ACTIVITY))
      .executeTakeFirst();
    if (existing) return 'already';
    await insertModActivity(
      {
        userId: reviewerId,
        entityType,
        entityId: n,
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
  void logToAxiom({ name: 'preserved-file-serve', type: 'info', ...record }).catch(() => null);
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
