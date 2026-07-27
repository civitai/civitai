import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { getAnnouncementImageUrl } from '~/components/Announcements/announcement-image';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getActiveAnnouncementImageRefs } from '~/server/services/announcement.service';
import { getB2ImageS3Client } from '~/utils/s3-utils';
import { createLogger } from '~/utils/logging';
import { createJob } from './job';

const log = createLogger('announcement-media-check', 'yellow');

const jobName = 'announcement-media-check';

/**
 * Health check for announcement banner images.
 *
 * `Announcement.metadata.image` is a bare object key with no foreign key and no
 * refcount (see `announcement.schema.ts`). Two cheap conditions predict breakage,
 * both determinable before a single user sees a broken banner:
 *
 *  - BROKEN  — the key is absent from the uploads bucket. The banner is dead (or will
 *              be as soon as the derived variant ages out of the delivery cache).
 *  - AT RISK — an `Image` row exists whose `url` equals the key. That row is
 *              deletable through ordinary product paths, and deleting it deletes the
 *              underlying object. This is the exact chain that broke a live sitewide
 *              announcement.
 *
 * 🔴 Deliberately NOT primarily a "fetch the rendered URL" check. That signal is both
 * lagging and maskable:
 *  - the image service can keep serving an already-materialised variant from its own
 *    cache long after the original object is gone, so the fetch stays green through
 *    the entire window in which we could still have fixed it; and
 *  - the delivery URL is edge-cached for a day, so a poller reads back its own cached
 *    answer. The optional secondary fetch below therefore always cache-busts.
 */

export type AnnouncementMediaStatus = 'ok' | 'at-risk' | 'broken';

export type AnnouncementMediaFinding = {
  key: string;
  announcementIds: number[];
  status: AnnouncementMediaStatus;
  /** `null` when the uploads bucket could not be consulted (no creds / transient error). */
  objectExists: boolean | null;
  hasImageRow: boolean;
  /** HTTP status of the cache-busted rendered-variant probe, when one was performed. */
  renderedStatus?: number | null;
};

export type AnnouncementMediaDeps = {
  /** `true` present, `false` definitively absent, `null` unknown — unknown never alerts. */
  objectExists: (key: string) => Promise<boolean | null>;
  /** Subset of `keys` for which an `Image` row shares the url. */
  findKeysWithImageRow: (keys: string[]) => Promise<string[]>;
  /** Optional secondary user-visible probe. Must be cache-busted by the implementation. */
  probeRenderedVariant?: (key: string) => Promise<number | null>;
};

/**
 * Classify one key. BROKEN outranks AT RISK: a missing object is already a failure,
 * not a risk. An unknown bucket answer (`null`) never manufactures a BROKEN.
 */
export function classifyAnnouncementMedia({
  objectExists,
  hasImageRow,
}: {
  objectExists: boolean | null;
  hasImageRow: boolean;
}): AnnouncementMediaStatus {
  if (objectExists === false) return 'broken';
  if (hasImageRow) return 'at-risk';
  return 'ok';
}

/**
 * Evaluate a set of announcement -> key references. Keys are de-duplicated before any
 * lookup (the same object is legitimately shared by several announcements), and each
 * finding carries every announcement id that references it.
 */
export async function evaluateAnnouncementMedia(
  refs: { id: number; key: string }[],
  deps: AnnouncementMediaDeps
): Promise<AnnouncementMediaFinding[]> {
  const byKey = new Map<string, number[]>();
  for (const { id, key } of refs) {
    if (!key) continue;
    const ids = byKey.get(key);
    if (ids) ids.push(id);
    else byKey.set(key, [id]);
  }

  const keys = [...byKey.keys()];
  if (!keys.length) return [];

  const keysWithImageRow = new Set(await deps.findKeysWithImageRow(keys));

  const findings: AnnouncementMediaFinding[] = [];
  for (const key of keys) {
    const objectExists = await deps.objectExists(key);
    const hasImageRow = keysWithImageRow.has(key);
    const status = classifyAnnouncementMedia({ objectExists, hasImageRow });

    // Only worth the extra request when the cheap signals say we're fine — it exists to
    // catch delivery-side failures those two can't see.
    const renderedStatus =
      status === 'broken' || !deps.probeRenderedVariant
        ? undefined
        : await deps.probeRenderedVariant(key);

    findings.push({
      key,
      announcementIds: byKey.get(key) ?? [],
      status,
      objectExists,
      hasImageRow,
      renderedStatus,
    });
  }

  return findings;
}

const UPLOADS_BUCKET = () => env.S3_IMAGE_B2_BUCKET ?? 'civitai-media-uploads';

function isNotFound(e: unknown) {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
}

/**
 * Existence check against the uploads bucket the app actually writes to and deletes
 * from. Note the legacy DigitalOcean image client cannot be used for this — it points
 * at a decommissioned read proxy.
 */
async function objectExistsInUploads(key: string): Promise<boolean | null> {
  if (!env.S3_IMAGE_B2_ACCESS_KEY || !env.S3_IMAGE_B2_SECRET_KEY || !env.S3_IMAGE_B2_ENDPOINT)
    return null;

  try {
    await getB2ImageS3Client().send(
      new HeadObjectCommand({ Bucket: UPLOADS_BUCKET(), Key: key })
    );
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    // Permission/transient/network — do not turn an infrastructure hiccup into a page.
    return null;
  }
}

async function findKeysWithImageRow(keys: string[]) {
  const rows = await dbRead.image.findMany({
    where: { url: { in: keys } },
    select: { url: true },
    distinct: ['url'],
  });
  return rows.map((r) => r.url);
}

const RENDER_PROBE_TIMEOUT_MS = 10_000;

/**
 * Secondary, user-visible probe of the exact variant the banner renders.
 *
 * 🔴 Cache-busted on purpose: the delivery URL is edge-cached for a day, so a plain
 * request reads back the poller's own cached answer and would stay green through a
 * real outage.
 */
async function probeRenderedVariant(key: string): Promise<number | null> {
  const url = `${getAnnouncementImageUrl(key)}?cb=${Date.now()}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { range: 'bytes=0-0', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(RENDER_PROBE_TIMEOUT_MS),
    });
    return res.status;
  } catch {
    return null;
  }
}

export const announcementMediaCheckJob = createJob(
  jobName,
  '0 * * * *',
  async () => {
    const refs = await getActiveAnnouncementImageRefs();
    if (!refs.length) {
      log('no active announcements with a banner image');
      return { checked: 0, broken: 0, atRisk: 0 };
    }

    const findings = await evaluateAnnouncementMedia(refs, {
      objectExists: objectExistsInUploads,
      findKeysWithImageRow,
      probeRenderedVariant,
    });

    const broken = findings.filter((f) => f.status === 'broken');
    const atRisk = findings.filter((f) => f.status === 'at-risk');
    // Cheap signals are clean but the variant users load isn't served.
    const renderFailures = findings.filter(
      (f) => f.status !== 'broken' && f.renderedStatus != null && f.renderedStatus >= 400
    );

    for (const finding of broken) {
      logToAxiom({
        type: 'error',
        name: 'announcement-image-broken',
        message: 'Announcement banner object is missing from the uploads bucket',
        details: {
          announcementIds: finding.announcementIds,
          imageKey: finding.key,
          url: getAnnouncementImageUrl(finding.key),
        },
      }).catch();
    }

    for (const finding of atRisk) {
      logToAxiom({
        type: 'warning',
        name: 'announcement-image-at-risk',
        message:
          'Announcement banner key is also an Image url — deleting that image would break the banner',
        details: {
          announcementIds: finding.announcementIds,
          imageKey: finding.key,
        },
      }).catch();
    }

    for (const finding of renderFailures) {
      logToAxiom({
        type: 'error',
        name: 'announcement-image-render-failed',
        message: 'Announcement banner variant did not serve',
        details: {
          announcementIds: finding.announcementIds,
          imageKey: finding.key,
          url: getAnnouncementImageUrl(finding.key),
          status: finding.renderedStatus,
        },
      }).catch();
    }

    log(
      `checked ${findings.length} keys: ${broken.length} broken, ${atRisk.length} at risk, ${renderFailures.length} render failures`
    );

    return {
      checked: findings.length,
      broken: broken.length,
      atRisk: atRisk.length,
      renderFailures: renderFailures.length,
    };
  },
  { lockExpiration: 5 * 60 }
);
