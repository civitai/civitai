import { createHash, randomUUID } from 'crypto';
import { TRPCError } from '@trpc/server';
import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { newBlockIdError } from '~/server/utils/apps-slug';
import { isPrismaForeignKeyViolation, isPrismaUniqueViolation } from '~/server/utils/errorHandling';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { boundedClusterCall } from '~/server/utils/cluster-window-count';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { compileRemixApp } from '~/shared/remix-apps/compile';
import type { RemixApp } from '~/shared/remix-apps/define';
import { replayRemixApp, type RemixReplayer } from '~/shared/remix-apps/replay';
import {
  REMIX_BLOCK_ID_PREFIX,
  REMIX_CODE_APP_SLUGS,
  REMIX_SAVABLE_SLOT_IDS,
  REMIX_STATUS,
  REMIX_STATUSES,
  USER_REMIX_SLUG,
  remixEngineIssues,
  userRemixSlugPrefix,
  remixManifestSchema,
  type RemixAppInput,
  type RemixAppSpec,
  type RemixManifest,
  type RemixSlotId,
  type RemixStoredSpec,
  type RemixUserSpec,
  type RemixAppSubmitInput,
  remixAppSlugSchema,
  REMIX_USER_APPS_PER_AUTHOR,
  REMIX_REVIEW_LOG_MAX,
  type RemixRejectReason,
  type RemixReviewLogEntry,
} from '~/shared/remix-apps/row.schema';
import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';
import type { Prisma } from '@prisma/client';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import { CODE_REMIX_APPS } from '~/shared/remix-apps/system-apps';

/** The OAuth client every remix row hangs off: no secret, no redirect, no scopes. */
export const REMIX_APPS_CLIENT_ID = 'civitai-remix-apps';

export type RemixAppRow = {
  id: string;
  blockId: string;
  version: string;
  manifest: unknown;
  status: string;
  featuredOrder: number | null;
};

export type RegisteredRemixApp = {
  slug: string;
  name: string;
  description?: string;
  icon: string;
  target: RemixSlotId;
  enabled: boolean;
  order: number;
  spec: RemixStoredSpec;
  /** Set on a user app: its code is the author's. */
  author?: { userId: number };
  /** Its listing and engine. A user app's `run` is never called in-process. */
  app: RemixApp;
  /** What `start` and `advance` replay. */
  replay: RemixReplayer;
  /** A hash of what it runs: a run started on another shape is not replayed. */
  shape: string;
};

export const REMIX_APP_UNAVAILABLE = 'This app is unavailable right now';

// shortcut: until the sandbox runner ships, a user app refuses every replay.
const unavailable = async (): Promise<never> => {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: REMIX_APP_UNAVAILABLE });
};

/** The apps `caller` may see: user apps only behind their flag. */
export function visibleRemixApps<T extends Pick<RegisteredRemixApp, 'author'>>(
  apps: T[],
  caller: { features: Pick<FeatureAccess, 'remixAppsUserCode'> }
) {
  return caller.features.remixAppsUserCode ? apps : apps.filter((entry) => !entry.author);
}

export const remixAppRowSelect = {
  id: true,
  blockId: true,
  version: true,
  manifest: true,
  status: true,
  featuredOrder: true,
} as const;

export function remixBlockId(slug: string) {
  return REMIX_BLOCK_ID_PREFIX + slug;
}

/**
 * `app_blocks_id_length_check` holds every id to 28-40 chars. A slug is 3-34 chars and never ends
 * in a hyphen, so `ab_rx_` + slug fits under 40, and padding with `_` to 28 cannot collide.
 */
export function remixAppBlockRowId(slug: string) {
  return `ab_rx_${slug.replaceAll('-', '_')}`.padEnd(28, '_');
}

export const runVersionOf = (manifest: Pick<RemixManifest, 'version'>) =>
  Number(manifest.version.split('.')[0]);

function register(
  listing: Omit<RegisteredRemixApp, 'app' | 'icon' | 'replay' | 'shape'> & { version: number }
): RegisteredRemixApp {
  const { slug, name, description, spec, version } = listing;
  let app: RemixApp;
  if ('code' in spec) {
    // The code keeps its own run and version; the row only lists it.
    app = { ...CODE_REMIX_APPS[spec.code], slug, name, description, icon: spec.icon };
  } else if ('source' in spec) {
    app = {
      slug,
      name,
      description,
      icon: spec.icon,
      version,
      engine: spec.engine,
      run: unavailable,
    };
  } else {
    app = compileRemixApp({ slug, name, description, version }, spec);
  }
  const replay: RemixReplayer =
    'source' in spec ? unavailable : (source, log) => replayRemixApp(app, source, log);
  const shape = createHash('sha256').update(runShape(spec)).digest('hex').slice(0, 16);
  const { version: _, ...rest } = listing;
  return { ...rest, icon: spec.icon, app, replay, shape };
}

/** A stored row as a registered app, or `null` (logged) when it no longer validates. */
export function registerRow(row: RemixAppRow): RegisteredRemixApp | null {
  const parsed = remixManifestSchema.safeParse(row.manifest);
  if (!parsed.success || !row.blockId.startsWith(REMIX_BLOCK_ID_PREFIX)) {
    logToAxiom({
      name: 'remix-app-registry',
      type: 'error',
      message: 'Skipped a remix app row that does not validate',
      blockId: row.blockId,
      payload: { issues: parsed.error?.issues.slice(0, 5) },
    });
    return null;
  }
  const manifest = parsed.data;
  const slug = row.blockId.slice(REMIX_BLOCK_ID_PREFIX.length);
  if (
    manifest.author
      ? !slug.startsWith(userRemixSlugPrefix(manifest.author.userId))
      : USER_REMIX_SLUG.test(slug)
  ) {
    logToAxiom({
      name: 'remix-app-registry',
      type: 'error',
      message: 'Skipped a remix app row whose slug does not match its author',
      blockId: row.blockId,
    });
    return null;
  }
  // Saves check the engine; a stored row keeps serving after the allowlist moves on.
  const engineIssues = remixEngineIssues(manifest.remix);
  if (engineIssues.length)
    logToAxiom({
      name: 'remix-app-registry',
      type: 'warning',
      message: 'A remix app row names an engine no longer on the allowlist',
      blockId: row.blockId,
      payload: { issues: engineIssues },
    });
  return register({
    slug,
    name: manifest.name,
    description: manifest.description,
    target: manifest.targets[0].slotId,
    enabled: row.status === REMIX_STATUS.enabled,
    order: row.featuredOrder ?? Number.MAX_SAFE_INTEGER,
    spec: manifest.remix,
    version: runVersionOf(manifest),
    ...(manifest.author ? { author: manifest.author } : {}),
  });
}

/** What the registry serves before the seed migration has run: the same apps, enabled. */
function seedRegistry() {
  return SEED_REMIX_APPS.map((input, order) =>
    register({ ...input, enabled: true, order, version: 1 })
  );
}

const REGISTRY_TTL = CacheTTL.hour;
/** Bounds how long an idle generation key lives; a missing key just starts a new generation. */
const GENERATION_TTL_SECONDS = 24 * 60 * 60;

/**
 * On the primary: a mod's write is followed by this read, and a lagging replica would cache the
 * old row for the whole TTL. It runs once per TTL and once per mod write.
 */
export async function readRemixAppRows(): Promise<RemixAppRow[]> {
  return dbWrite.appBlock.findMany({
    where: { status: { in: REMIX_STATUSES } },
    select: remixAppRowSelect,
  });
}

/**
 * Every remix app, in menu order, disabled ones included: a disabled app's in-flight runs still
 * advance and post. Until any row exists, the seed.
 */
export async function getRemixAppRegistry(): Promise<RegisteredRemixApp[]> {
  const generation = await registryGeneration();
  const rows =
    generation === null
      ? await readRemixAppRows()
      : await fetchThroughCache(
          `${REDIS_KEYS.CACHES.REMIX_APP_REGISTRY}:${generation}`,
          readRemixAppRows,
          { ttl: REGISTRY_TTL }
        );
  if (!rows.length) return seedRegistry();
  return rows
    .map(registerRow)
    .filter((entry): entry is RegisteredRemixApp => entry !== null)
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

/**
 * The registry is cached per generation, and every mod write bumps it after it commits. A refill
 * that read the rows before a write landed fills the old generation's entry, which no reader uses
 * once the bump is done: a bust or a set can't promise that, since a refill already in flight
 * writes after either. `null` when Redis can't say; the caller then reads the primary uncached.
 *
 * The generation is a cache key's version, so it lives on the cache cluster with a TTL, and the
 * cluster can evict it at any time. A reader that finds no key starts a fresh generation (SET NX,
 * so concurrent readers agree on one). It must not fall back to a fixed name: an entry filled under
 * that name before a mod write would be served again once the bumped key was evicted. Losing the
 * key costs one read of the primary per reader until the new generation's entry is filled.
 */
async function registryGeneration() {
  const key = REDIS_KEYS.REMIX_APP.REGISTRY_GENERATION;
  const bounded = <T>(op: () => Promise<T>) => boundedClusterCall('remixAppRegistryGeneration', op);
  try {
    const generation = await bounded(() => redis.get(key));
    if (generation) return generation;
    const fresh = randomUUID();
    if (await bounded(() => redis.set(key, fresh, { NX: true, EX: GENERATION_TTL_SECONDS })))
      return fresh;
    // Another reader started one between the GET and the SET NX.
    return (await bounded(() => redis.get(key))) ?? null;
  } catch {
    return null;
  }
}

/**
 * After a mod write has committed: moves every reader to a fresh read of the primary. A random
 * token rather than a counter, so a generation that expired and started again can never name an
 * entry an earlier generation filled.
 */
export async function bumpRemixAppRegistry() {
  await redis.set(REDIS_KEYS.REMIX_APP.REGISTRY_GENERATION, randomUUID(), {
    EX: GENERATION_TTL_SECONDS,
  });
}

/** The apps the menu lists and the quote prices. */
export async function getEnabledRemixApps(caller: Parameters<typeof visibleRemixApps>[1]) {
  return visibleRemixApps(await getRemixAppRegistry(), caller).filter((entry) => entry.enabled);
}

/**
 * The app `slug` runs. `start` refuses a disabled app unless a mod is test-running it; `advance`
 * finishes a run of one, which was paid for already.
 */
export async function getRegisteredRemixApp(
  slug: string,
  caller: Parameters<typeof visibleRemixApps>[1],
  { allowDisabled }: { allowDisabled: boolean }
) {
  const entry = visibleRemixApps(await getRemixAppRegistry(), caller).find(
    (app) => app.slug === slug
  );
  if (!entry || (!entry.enabled && !allowDisabled))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix app not found' });
  return entry;
}

// ---------------------------------------------------------------------------------------------
// Mod writes. Each one bumps the registry generation, so every server reads the change on its next request.

/** The fields a change to which makes recorded runs mean something else. */
function runShape(spec: RemixStoredSpec) {
  const { icon: _, ...shape } = spec;
  return JSON.stringify(shape);
}

/** `x` when the app runs on mature sources, as every App Block row records its rating. */
const contentRatingOf = (spec: RemixStoredSpec) =>
  ('code' in spec ? CODE_REMIX_APPS[spec.code].engine : spec.engine).mature ? 'x' : 'pg';

export function manifestOf(input: RemixAppInput, runVersion: number): RemixManifest {
  return {
    kind: 'remix',
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    version: `${runVersion}.0.0`,
    targets: [{ slotId: input.target }],
    remix: input.spec,
  };
}

/**
 * Creates or replaces app `input.slug`. A new app starts disabled and last, so a mod can
 * test-run it before anyone sees it. A change to its asks, steps or engine bumps its run
 * version, so a run started on the old content is not replayed on the new.
 */
export async function saveRemixApp(input: RemixAppInput) {
  await assertRemixAppsClient();
  // The slug as a store app's blockId would be: the remix- prefix is the one id this allows.
  const slugError = newBlockIdError(input.slug);
  if (slugError) throw new TRPCError({ code: 'BAD_REQUEST', message: slugError });
  const blockId = remixBlockId(input.slug);
  const existing = await dbWrite.appBlock.findUnique({
    where: { blockId },
    select: remixAppRowSelect,
  });
  if (existing && !REMIX_STATUSES.includes(existing.status))
    throw new TRPCError({ code: 'CONFLICT', message: `${blockId} belongs to another app` });
  // A user app is its author's: a mod reviews it, never edits it.
  if (existing ? isUserRow(existing.manifest) : USER_REMIX_SLUG.test(input.slug))
    throw new TRPCError({ code: 'FORBIDDEN', message: `${blockId} is a user's app` });

  const previous = existing ? remixManifestSchema.safeParse(existing.manifest) : undefined;
  const storedTarget = previous?.success ? previous.data.targets[0].slotId : undefined;
  if (!isSavableTarget(input.target) && input.target !== storedTarget)
    throw new TRPCError({ code: 'BAD_REQUEST', message: `New apps cannot target ${input.target}` });

  const runVersion = nextRunVersion(existing, previous, input.spec);
  const manifest = manifestOf(input, runVersion);
  const fields = {
    manifest,
    version: manifest.version,
    contentRating: contentRatingOf(input.spec),
  };

  if (existing) await dbWrite.appBlock.update({ where: { blockId }, data: fields });
  else await createRemixAppRow(input.slug, fields);
  await bumpRemixAppRegistry();
  return { slug: input.slug, version: runVersion };
}

async function assertRemixAppsClient() {
  const client = await dbWrite.oauthClient.findUnique({
    where: { id: REMIX_APPS_CLIENT_ID },
    select: { id: true },
  });
  if (!client)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The remix apps seed migration has not been applied to this database yet.',
    });
}

type StoredRow = { version: string } | null;
type ParsedManifest = ReturnType<typeof remixManifestSchema.safeParse> | undefined;

/** The run version a write of `spec` gets: the stored one, or the next when what runs changes. */
function nextRunVersion(existing: StoredRow, previous: ParsedManifest, spec: RemixStoredSpec) {
  if (!existing || !previous) return 1;
  return previous.success
    ? runVersionOf(previous.data) + (runShape(previous.data.remix) === runShape(spec) ? 0 : 1)
    : Number(existing.version.split('.')[0]) + 1 || 1;
}

/** A new row starts disabled and last, so a mod can test-run it before anyone sees it. */
async function createRemixAppRow(
  slug: string,
  fields: { manifest: RemixManifest; version: string; contentRating: string }
) {
  const last = await dbWrite.appBlock.aggregate({
    where: { status: { in: REMIX_STATUSES } },
    _max: { featuredOrder: true },
  });
  try {
    await dbWrite.appBlock.create({
      data: {
        ...fields,
        id: remixAppBlockRowId(slug),
        appId: REMIX_APPS_CLIENT_ID,
        blockId: remixBlockId(slug),
        status: REMIX_STATUS.disabled,
        featuredOrder: (last._max.featuredOrder ?? -1) + 1,
      },
    });
  } catch (error) {
    // Two first saves of one slug at once: the second finds the row taken.
    if (isPrismaUniqueViolation(error))
      throw new TRPCError({ code: 'CONFLICT', message: 'That app was just created. Try again.' });
    throw error;
  }
}

/** What a mod approves: a hash of exactly the code and the listing text they read. */
export const remixReviewHash = (manifest: {
  name: string;
  description?: string;
  remix: { icon: string; source: string };
}) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        manifest.name,
        manifest.description ?? '',
        manifest.remix.icon,
        manifest.remix.source,
      ])
    )
    .digest('hex');

/**
 * Creates or replaces the author's app `u<authorId>-<name>`. Every submit, an edit of an approved
 * app included, takes it out of menus until a mod approves the new source.
 */
export async function submitUserRemixApp({
  authorId,
  name,
  title,
  description,
  icon,
  source,
}: RemixAppSubmitInput & { authorId: number }) {
  await assertRemixAppsClient();
  const slug = userRemixSlugPrefix(authorId) + name;
  const slugError = remixAppSlugSchema.safeParse(slug).success
    ? newBlockIdError(slug)
    : 'Use a shorter name';
  if (slugError) throw new TRPCError({ code: 'BAD_REQUEST', message: slugError });
  const blockId = remixBlockId(slug);
  // primary: decides who owns the row this write replaces.
  const existing = await dbWrite.appBlock.findUnique({
    where: { blockId },
    select: remixAppRowSelect,
  });
  if (existing && (!REMIX_STATUSES.includes(existing.status) || !isUserRow(existing.manifest)))
    throw new TRPCError({ code: 'CONFLICT', message: `${blockId} belongs to another app` });

  if (!existing) {
    // primary: the cap guards this create.
    const held = await dbWrite.appBlock.count({
      where: { blockId: { startsWith: remixBlockId(userRemixSlugPrefix(authorId)) } },
    });
    if (held >= REMIX_USER_APPS_PER_AUTHOR)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `You can have up to ${REMIX_USER_APPS_PER_AUTHOR} remix apps`,
      });
  }
  const previous = existing ? remixManifestSchema.safeParse(existing.manifest) : undefined;
  const spec: RemixUserSpec = { icon, engine: { safe: DEFAULT_ENGINE.safe }, source };
  const runVersion = nextRunVersion(existing, previous, spec);
  const listing = {
    kind: 'remix',
    name: title,
    ...(description ? { description } : {}),
    version: `${runVersion}.0.0`,
    targets: [{ slotId: 'image.remix' }],
    remix: spec,
    author: { userId: authorId },
    review: 'submitted',
  } satisfies RemixManifest;
  const sha256 = remixReviewHash(listing);
  // The log and the minor-themed marker are the server's: an author's save carries them over as stored.
  const kept = previous?.success ? previous.data : undefined;
  const reviewLog = kept?.reviewLog;
  const minorThemed = kept?.minorThemed;
  const manifest = withReviewLog(
    { ...listing, ...(reviewLog ? { reviewLog } : {}), ...(minorThemed ? { minorThemed } : {}) },
    { by: authorId, action: 'submitted', sha256 }
  );
  const fields = { manifest, version: manifest.version, contentRating: contentRatingOf(spec) };
  if (existing)
    await dbWrite.appBlock.update({
      where: { blockId },
      data: { ...fields, status: REMIX_STATUS.disabled },
    });
  else await createRemixAppRow(slug, fields);
  await bumpRemixAppRegistry();
  return { slug, version: runVersion, sha256 };
}

const withReviewLog = (
  manifest: RemixManifest,
  entry: Omit<RemixReviewLogEntry, 'at'>
): RemixManifest => ({
  ...manifest,
  reviewLog: [...(manifest.reviewLog ?? []), { ...entry, at: new Date().toISOString() }].slice(
    -REMIX_REVIEW_LOG_MAX
  ),
});

/** A user app as stored now: every mod decision is checked against it. */
async function readUserRemixApp(slug: string) {
  // primary: a decision must be about the row as it is now, not a replica's copy.
  const row = await dbWrite.appBlock.findUnique({
    where: { blockId: remixBlockId(slug) },
    select: remixAppRowSelect,
  });
  const parsed =
    row && REMIX_STATUSES.includes(row.status)
      ? remixManifestSchema.safeParse(row.manifest)
      : undefined;
  if (!row || !parsed?.success || !('source' in parsed.data.remix))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'User remix app not found' });
  return { row, parsed, manifest: parsed.data, remix: parsed.data.remix };
}

const userAppChanged = () =>
  new TRPCError({
    code: 'CONFLICT',
    message: 'The app changed after you opened it. Reload it and try again.',
  });

/** Conditional on the manifest read, so a submit that lands in between is never acted on. */
async function writeUserRemixApp(
  row: { id: string; manifest: unknown },
  data: Prisma.AppBlockUpdateManyMutationInput
) {
  const { count } = await dbWrite.appBlock.updateMany({
    where: { id: row.id, manifest: { equals: row.manifest as Prisma.InputJsonValue } },
    data,
  });
  if (!count) throw userAppChanged();
  await bumpRemixAppRegistry();
}

/**
 * A mod's decision on a user app's source, refused unless `sha256` is the source stored now. An
 * approval may add the mature engine; a rejection also takes the app out of menus.
 */
export async function reviewUserRemixApp({
  slug,
  sha256,
  decision,
  mature = false,
  reason,
  note,
  moderatorId,
}: {
  slug: string;
  sha256: string;
  decision: 'approved' | 'rejected';
  mature?: boolean;
  reason?: RemixRejectReason;
  note?: string;
  moderatorId: number;
}) {
  if (decision === 'rejected' && !reason)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Give a reason for the rejection' });
  const { row, parsed, manifest: stored, remix } = await readUserRemixApp(slug);
  if (remixReviewHash({ ...stored, remix }) !== sha256) throw userAppChanged();
  const withMature = decision === 'approved' && mature;
  if (withMature && stored.minorThemed)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This app was rejected as minor-themed, so it can only be approved for safe sources',
    });

  const spec: RemixUserSpec = {
    ...remix,
    engine: { safe: remix.engine.safe, ...(withMature ? { mature: DEFAULT_ENGINE.mature } : {}) },
  };
  const runVersion = nextRunVersion(row, parsed, spec);
  const minorThemed =
    stored.minorThemed ??
    (reason === 'minor-themed' ? { by: moderatorId, at: new Date().toISOString() } : undefined);
  const manifest = withReviewLog(
    {
      ...stored,
      version: `${runVersion}.0.0`,
      remix: spec,
      review: decision,
      ...(minorThemed ? { minorThemed } : {}),
    },
    {
      by: moderatorId,
      action: decision,
      sha256,
      ...(decision === 'approved' ? { mature: withMature } : { reason }),
      ...(note ? { note } : {}),
    }
  );
  await writeUserRemixApp(row, {
    manifest,
    version: manifest.version,
    contentRating: contentRatingOf(spec),
    ...(decision === 'rejected' ? { status: REMIX_STATUS.disabled } : {}),
  });
  return { slug, review: decision, version: runVersion };
}

/** Lifts a minor-themed marker. A second moderator must do it: never the one who set it. */
export async function clearRemixMinorThemed({
  slug,
  moderatorId,
}: {
  slug: string;
  moderatorId: number;
}) {
  const { row, manifest: stored } = await readUserRemixApp(slug);
  if (!stored.minorThemed)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This app is not marked' });
  if (stored.minorThemed.by === moderatorId)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'A different moderator must clear a mark you set',
    });
  const { minorThemed: _, ...rest } = stored;
  await writeUserRemixApp(row, {
    manifest: withReviewLog(rest, { by: moderatorId, action: 'cleared-minor-themed' }),
  });
}

/** Read off the raw manifest, so a user row that no longer validates still counts as one. */
const isUserRow = (manifest: unknown) =>
  typeof manifest === 'object' && manifest !== null && 'author' in manifest;

const isSavableTarget = (target: string) =>
  (REMIX_SAVABLE_SLOT_IDS as readonly string[]).includes(target);

const BUILT_IN_SLUGS = new Set<string>([
  ...SEED_REMIX_APPS.map((app) => app.slug),
  ...REMIX_CODE_APP_SLUGS,
]);

/** Only a disabled app that is not a built-in default can be deleted. */
const isDeletable = (slug: string, status: string) =>
  status === REMIX_STATUS.disabled && !BUILT_IN_SLUGS.has(slug);

/**
 * Deletes a disabled, non-default app row for good. Rows hanging off it (BlockUserSubscription
 * among them) go by FK cascade or SET NULL; a Restrict FK (attribution, a platform default) refuses.
 */
export async function deleteRemixApp({ slug }: { slug: string }) {
  const blockId = remixBlockId(slug);
  const row = await dbWrite.appBlock.findUnique({
    where: { blockId },
    select: remixAppRowSelect,
  });
  if (!row || !REMIX_STATUSES.includes(row.status))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix app not found' });
  if (BUILT_IN_SLUGS.has(slug))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Built-in default apps cannot be deleted' });
  if (row.status !== REMIX_STATUS.disabled)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Disable the app first' });

  // The only record of what was deleted.
  logToAxiom({
    name: 'remix-app-registry',
    type: 'info',
    message: 'Deleted a remix app row',
    row,
  });
  let count: number;
  try {
    // Conditional on the status, so an enable that lands after the read above wins.
    ({ count } = await dbWrite.appBlock.deleteMany({
      where: { id: row.id, status: REMIX_STATUS.disabled },
    }));
  } catch (error) {
    if (isPrismaForeignKeyViolation(error))
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Other records still point at this app, so it cannot be deleted',
      });
    throw error;
  }
  if (!count)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Disable the app first' });
  await bumpRemixAppRegistry();
}

export async function setRemixAppEnabled({
  slug,
  enabled,
  moderatorId,
}: {
  slug: string;
  enabled: boolean;
  /** Who did it, for a user app's review log. */
  moderatorId?: number;
}) {
  const status = enabled ? REMIX_STATUS.enabled : REMIX_STATUS.disabled;
  if (USER_REMIX_SLUG.test(slug)) {
    if (!moderatorId) throw new Error('A user app is enabled or disabled by a named moderator');
    const { row, manifest, remix } = await readUserRemixApp(slug);
    if (enabled && manifest.review !== 'approved')
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Approve this app before enabling it',
      });
    const sha256 = remixReviewHash({ ...manifest, remix });
    await writeUserRemixApp(row, {
      status,
      manifest: withReviewLog(manifest, {
        by: moderatorId,
        action: enabled ? 'enabled' : 'disabled',
        sha256,
      }),
    });
    return;
  }
  const { count } = await dbWrite.appBlock.updateMany({
    where: { blockId: remixBlockId(slug), status: { in: REMIX_STATUSES } },
    data: { status },
  });
  if (!count) throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix app not found' });
  await bumpRemixAppRegistry();
}

/** `slugs` in menu order; apps it leaves out keep their place after these. */
export async function orderRemixApps(slugs: string[]) {
  await dbWrite.$transaction(
    slugs.map((slug, order) =>
      dbWrite.appBlock.updateMany({
        where: { blockId: remixBlockId(slug), status: { in: REMIX_STATUSES } },
        data: { featuredOrder: order },
      })
    )
  );
  await bumpRemixAppRegistry();
}

/** Every row as stored, with why it is skipped when it no longer validates: the mod list. */
export async function listRemixAppsForAdmin() {
  return (await readRemixAppRows())
    .map((row) => {
      const parsed = remixManifestSchema.safeParse(row.manifest);
      const slug = row.blockId.slice(REMIX_BLOCK_ID_PREFIX.length);
      const enabled = row.status === REMIX_STATUS.enabled;
      const order = row.featuredOrder ?? Number.MAX_SAFE_INTEGER;
      const deletable = isDeletable(slug, row.status);
      if (!parsed.success)
        return {
          slug,
          enabled,
          deletable,
          order,
          version: row.version,
          invalid: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        };
      const { name, description, targets, remix, author, review } = parsed.data;
      // A user app is reviewed, never edited, so it carries no editor input.
      if (author && review && 'source' in remix)
        return {
          slug,
          enabled,
          deletable,
          order,
          version: parsed.data.version,
          user: {
            authorId: author.userId,
            name,
            description,
            icon: remix.icon,
            review,
            mature: !!remix.engine.mature,
            source: remix.source,
            sha256: remixReviewHash({ ...parsed.data, remix }),
            reviewLog: parsed.data.reviewLog ?? [],
            minorThemed: parsed.data.minorThemed ?? null,
          },
        };
      return {
        slug,
        enabled,
        deletable,
        order,
        version: parsed.data.version,
        input: { slug, name, description, target: targets[0].slotId, spec: remix } as RemixAppInput,
      };
    })
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}
