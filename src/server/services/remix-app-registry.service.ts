import { TRPCError } from '@trpc/server';
import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { newBlockIdError } from '~/server/utils/apps-slug';
import { fetchThroughCache, setFetchThroughCache } from '~/server/utils/cache-helpers';
import { compileRemixApp } from '~/shared/remix-apps/compile';
import type { RemixApp } from '~/shared/remix-apps/define';
import {
  REMIX_BLOCK_ID_PREFIX,
  REMIX_STATUS,
  REMIX_STATUSES,
  remixEngineIssues,
  remixManifestSchema,
  type RemixAppInput,
  type RemixAppSpec,
  type RemixManifest,
  type RemixSlotId,
} from '~/shared/remix-apps/row.schema';
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
  spec: RemixAppSpec;
  /** What `start` and `advance` run. */
  app: RemixApp;
};

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

export function remixAppBlockRowId(slug: string) {
  // `apb_` like every block id; App Block ids allow only [A-Za-z0-9_].
  return `apb_remix_${slug.replaceAll('-', '_')}`;
}

export const runVersionOf = (manifest: Pick<RemixManifest, 'version'>) =>
  Number(manifest.version.split('.')[0]);

function register(
  listing: Omit<RegisteredRemixApp, 'app' | 'icon'> & { version: number }
): RegisteredRemixApp {
  const { slug, name, description, spec, version } = listing;
  let app: RemixApp;
  if ('code' in spec) {
    // The code keeps its own run and version; the row only lists it.
    app = { ...CODE_REMIX_APPS[spec.code], slug, name, description, icon: spec.icon };
  } else {
    app = compileRemixApp({ slug, name, description, version }, spec);
  }
  const { version: _, ...rest } = listing;
  return { ...rest, icon: spec.icon, app };
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
      issues: parsed.error?.issues.slice(0, 5),
    }).catch(() => undefined);
    return null;
  }
  const manifest = parsed.data;
  // Saves check the engine; a stored row keeps serving after the allowlist moves on.
  const engineIssues = remixEngineIssues(manifest.remix);
  if (engineIssues.length)
    logToAxiom({
      name: 'remix-app-registry',
      type: 'warning',
      message: 'A remix app row names an engine no longer on the allowlist',
      blockId: row.blockId,
      issues: engineIssues,
    }).catch(() => undefined);
  return register({
    slug: row.blockId.slice(REMIX_BLOCK_ID_PREFIX.length),
    name: manifest.name,
    description: manifest.description,
    target: manifest.targets[0].slotId,
    enabled: row.status === REMIX_STATUS.enabled,
    order: row.featuredOrder ?? Number.MAX_SAFE_INTEGER,
    spec: manifest.remix,
    version: runVersionOf(manifest),
  });
}

/** What the registry serves before the seed migration has run: the same apps, enabled. */
function seedRegistry() {
  return SEED_REMIX_APPS.map((input, order) =>
    register({ ...input, enabled: true, order, version: 1 })
  );
}

const REGISTRY_TTL = CacheTTL.hour;

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
  const rows = await fetchThroughCache(REDIS_KEYS.CACHES.REMIX_APP_REGISTRY, readRemixAppRows, {
    ttl: REGISTRY_TTL,
  });
  if (!rows.length) return seedRegistry();
  return rows
    .map(registerRow)
    .filter((entry): entry is RegisteredRemixApp => entry !== null)
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

/** Caches the rows as written, so no reader is served the old ones while a refill runs. */
export async function refreshRemixAppRegistry() {
  await setFetchThroughCache(REDIS_KEYS.CACHES.REMIX_APP_REGISTRY, await readRemixAppRows(), {
    ttl: REGISTRY_TTL,
  });
}

/** The apps the menu lists and the quote prices. */
export async function getEnabledRemixApps() {
  return (await getRemixAppRegistry()).filter((entry) => entry.enabled);
}

/**
 * The app `slug` runs. `start` refuses a disabled app unless a mod is test-running it; `advance`
 * finishes a run of one, which was paid for already.
 */
export async function getRegisteredRemixApp(
  slug: string,
  { allowDisabled }: { allowDisabled: boolean }
) {
  const entry = (await getRemixAppRegistry()).find((app) => app.slug === slug);
  if (!entry || (!entry.enabled && !allowDisabled))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix app not found' });
  return entry;
}

// ---------------------------------------------------------------------------------------------
// Mod writes. Each one recaches the registry, so every server reads the change on its next request.

/** The fields a change to which makes recorded runs mean something else. */
function runShape(spec: RemixAppSpec) {
  const { icon: _, ...shape } = spec;
  return JSON.stringify(shape);
}

/** `x` when the app runs on mature sources, as every App Block row records its rating. */
const contentRatingOf = (spec: RemixAppSpec) =>
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
  const client = await dbWrite.oauthClient.findUnique({
    where: { id: REMIX_APPS_CLIENT_ID },
    select: { id: true },
  });
  if (!client)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The remix apps seed migration has not been applied to this database yet.',
    });
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

  let runVersion = 1;
  if (existing) {
    const previous = remixManifestSchema.safeParse(existing.manifest);
    runVersion = previous.success
      ? runVersionOf(previous.data) +
        (runShape(previous.data.remix) === runShape(input.spec) ? 0 : 1)
      : Number(existing.version.split('.')[0]) + 1 || 1;
  }
  const manifest = manifestOf(input, runVersion);
  const fields = {
    manifest,
    version: manifest.version,
    contentRating: contentRatingOf(input.spec),
  };

  if (existing) {
    await dbWrite.appBlock.update({ where: { blockId }, data: fields });
  } else {
    const last = await dbWrite.appBlock.aggregate({
      where: { status: { in: REMIX_STATUSES } },
      _max: { featuredOrder: true },
    });
    await dbWrite.appBlock.create({
      data: {
        ...fields,
        id: remixAppBlockRowId(input.slug),
        appId: REMIX_APPS_CLIENT_ID,
        blockId,
        status: REMIX_STATUS.disabled,
        featuredOrder: (last._max.featuredOrder ?? -1) + 1,
      },
    });
  }
  await refreshRemixAppRegistry();
  return { slug: input.slug, version: runVersion };
}

export async function setRemixAppEnabled({ slug, enabled }: { slug: string; enabled: boolean }) {
  const { count } = await dbWrite.appBlock.updateMany({
    where: { blockId: remixBlockId(slug), status: { in: REMIX_STATUSES } },
    data: { status: enabled ? REMIX_STATUS.enabled : REMIX_STATUS.disabled },
  });
  if (!count) throw new TRPCError({ code: 'NOT_FOUND', message: 'Remix app not found' });
  await refreshRemixAppRegistry();
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
  await refreshRemixAppRegistry();
}

/** Every row as stored, with why it is skipped when it no longer validates: the mod list. */
export async function listRemixAppsForAdmin() {
  return (await readRemixAppRows())
    .map((row) => {
      const parsed = remixManifestSchema.safeParse(row.manifest);
      const slug = row.blockId.slice(REMIX_BLOCK_ID_PREFIX.length);
      const enabled = row.status === REMIX_STATUS.enabled;
      const order = row.featuredOrder ?? Number.MAX_SAFE_INTEGER;
      if (!parsed.success)
        return {
          slug,
          enabled,
          order,
          version: row.version,
          invalid: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        };
      const { name, description, targets, remix } = parsed.data;
      return {
        slug,
        enabled,
        order,
        version: parsed.data.version,
        input: { slug, name, description, target: targets[0].slotId, spec: remix } as RemixAppInput,
      };
    })
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}
