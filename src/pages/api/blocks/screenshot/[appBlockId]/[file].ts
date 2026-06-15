import type { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * F-E E5 — public screenshot serving route for the marketplace gallery.
 *
 * The bundle MinIO (where screenshots are stored alongside the ZIP) is an
 * INTERNAL endpoint with no public bucket policy, so screenshots can't be
 * hot-linked directly. This route is the opaque public URL the detail page's
 * <img> tags point at (`/api/blocks/screenshot/<appBlockId>/<index>.<ext>`,
 * built by `toPublicScreenshots`). It streams ONE approved app's ONE stored
 * screenshot, with the magic-byte-derived content-type that was validated at
 * approve.
 *
 * 🔒 GATING INVARIANT (E5 — same as the rest of F-E, do not violate):
 *   - `MixedAuthEndpoint` → anon-CAPABLE (no session required) but we evaluate
 *     `isAppBlocksEnabled({ user })` with the optional session user FIRST. For a
 *     real anon / non-mod viewer the mod-segmented `app-blocks-enabled` flag is
 *     OFF → 404 (dark today; same posture as getAppDetail). Lit only when the
 *     SEGMENT is widened at launch — there is intentionally NO isModerator belt.
 *   - Serves ONLY a `status='approved'` app's screenshots — a missing /
 *     non-approved appBlockId → 404, never its data (no id-enumeration of
 *     unapproved apps, matching getAppDetail).
 *   - Serves ONLY a screenshot RECORDED in `app_blocks.screenshots` for that id
 *     (we look up the entry by index, then fetch its stored MinIO key — the
 *     client cannot request an arbitrary key/path; index is the only knob).
 *
 * EXPOSURE: image bytes + a fixed image content-type only. No app metadata, no
 * key, no per-user data.
 */

type StoredScreenshot = {
  key: unknown;
  index: unknown;
  ext: unknown;
  contentType: unknown;
};

const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/webp', 'image/jpeg']);

export default MixedAuthEndpoint(
  async (req: NextApiRequest, res: NextApiResponse, user) => {
    // Dark-flag fail-closed: while the appBlocks flag is off for this viewer
    // (anon / non-mod today) we 404 — identical to the getAppDetail posture, so
    // a dark viewer can't even confirm a screenshot exists.
    if (!(await isAppBlocksEnabled({ user }))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const appBlockId = typeof req.query.appBlockId === 'string' ? req.query.appBlockId : '';
    const file = typeof req.query.file === 'string' ? req.query.file : '';
    // `file` is `<index>.<ext>` — parse the index; the ext in the URL is
    // cosmetic (the served content-type comes from the stored record).
    const dot = file.indexOf('.');
    const indexStr = dot > 0 ? file.slice(0, dot) : '';
    const requestedIndex = Number(indexStr);
    if (!appBlockId || !Number.isInteger(requestedIndex) || requestedIndex < 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const block = await dbRead.appBlock.findUnique({
      where: { id: appBlockId },
      select: { status: true, screenshots: true },
    });
    // Approved-only — never serve a pending/rejected/withdrawn app's images.
    if (!block || block.status !== 'approved') {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const screenshots = Array.isArray(block.screenshots)
      ? (block.screenshots as StoredScreenshot[])
      : [];
    const record = screenshots.find(
      (s) => typeof s?.index === 'number' && s.index === requestedIndex
    );
    if (
      !record ||
      typeof record.key !== 'string' ||
      typeof record.contentType !== 'string' ||
      !ALLOWED_CONTENT_TYPES.has(record.contentType)
    ) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Stream the object from the bundle MinIO. Imported lazily so the route
    // (and its env coupling) only loads the S3 client when actually serving.
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const { getBundleBucket, getBundleS3Client } = await import('~/utils/bundle-s3');
      const obj = await getBundleS3Client().send(
        new GetObjectCommand({ Bucket: getBundleBucket(), Key: record.key })
      );
      if (!obj.Body) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const bytes = await obj.Body.transformToByteArray();
      res.setHeader('Content-Type', record.contentType);
      // Screenshots are immutable per (appBlockId, index, ext) — a re-approve
      // overwrites in place but the gallery URL only changes on a new approve.
      // Cache moderately; the page is deIndex'd + dark so this is conservative.
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).send(Buffer.from(bytes));
    } catch {
      res.status(404).json({ error: 'Not found' });
    }
  },
  ['GET']
);
