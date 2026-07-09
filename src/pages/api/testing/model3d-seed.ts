/**
 * Test endpoint: seed a Model3D as if it came from a PolyGen / Meshy workflow.
 *
 * Use this instead of hitting Meshy when you want to exercise the publish →
 * view → review loop without burning credits. The created row is
 * indistinguishable from a real generation downstream: it has a `workflowId`
 * (prefixed `test-…` to avoid colliding with real Meshy workflows), a
 * `generationParams` snapshot, a thumbnailImage that flowed through standard
 * NSFW/CSAM scanning, and Model3DFile rows registered by the same shared
 * service used by the real workflow result handler.
 *
 * Auth: WEBHOOK_TOKEN (?token=…) OR session moderator cookie. The mod-gated
 * UI page at /moderator/testing/model3d-seed posts here via the session path.
 *
 * Body (JSON):
 *   {
 *     name:                string,             // Model3D.name
 *     description?:        string,
 *     licenseId?:          number,             // defaults to 5 (All Rights Reserved)
 *     thumbnailImageId:    number,             // Image.id, REQUIRED — already
 *                                              // uploaded + scanned via /api/image-upload
 *     sourceImageId?:      number,             // for "image-to-3D-style" tests
 *     files:               Array<{
 *       format: 'glb' | 'fbx' | 'obj' | 'stl' | string,  // lowercased
 *       url:    string,                                   // pre-uploaded S3 URL
 *       sizeKB: number,
 *       name?:  string,
 *     }>,                                      // at least one file with format=='glb' REQUIRED
 *     generationParams?:   Record<string, unknown>,       // optional snapshot
 *     publish?:            boolean,            // if true, immediately set status=Published
 *   }
 *
 * Returns: { model3dId: number, created: boolean, viewUrl: string }
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import * as z from 'zod';
import type { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { createImage } from '~/server/services/image.service';
import { MediaType } from '~/shared/utils/prisma/enums';
import {
  publishModel3D,
  upsertModel3DFromWorkflow,
} from '~/server/services/model3d.service';

const fileSchema = z.object({
  format: z
    .string()
    .min(1)
    .max(16)
    .transform((s) => s.toLowerCase().replace(/^\./, '')),
  url: z.string().url(),
  sizeKB: z.number().positive(),
  name: z.string().optional(),
});

// Thumbnail can be either:
//  - a pre-existing Image.id (when the caller has already created the row)
//  - a fresh upload shape (matches CustomFile from useCFImageUpload) — the
//    endpoint calls `createImage` to materialize the Image row + kick off
//    standard NSFW / CSAM scanning, then uses the resulting id.
const thumbnailSchema = z.union([
  z.object({ imageId: z.number().int().positive() }),
  z.object({
    url: z.string().min(1),
    name: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    hash: z.string().optional(),
    sizeKB: z.number().nonnegative().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const bodySchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    licenseId: z.number().int().positive().default(5),
    thumbnail: thumbnailSchema,
    sourceImageId: z.number().int().positive().optional(),
    files: z.array(fileSchema).min(1),
    generationParams: z.record(z.string(), z.unknown()).optional(),
    publish: z.boolean().default(false),
  })
  .refine((d) => d.files.some((f) => f.format === 'glb'), {
    message: 'At least one file with format="glb" is required (matches PolyGenOutput.model).',
    path: ['files'],
  });

type SeedBody = z.infer<typeof bodySchema>;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Dual auth: WEBHOOK_TOKEN query OR session moderator
  const tokenOk =
    typeof req.query.token === 'string' &&
    env.WEBHOOK_TOKEN.length > 0 &&
    req.query.token === env.WEBHOOK_TOKEN;
  let sessionUserId: number | null = null;

  if (!tokenOk) {
    const session = await getServerAuthSession({ req, res });
    if (!session?.user?.isModerator || session.user.bannedAt) {
      return res.status(401).json({ error: 'Unauthorized — supply ?token=WEBHOOK_TOKEN or sign in as a moderator.' });
    }
    sessionUserId = session.user.id;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
  }
  const body: SeedBody = parsed.data;

  // Decide owner. Session path uses the signed-in mod's id. Token path needs a
  // userId in the body (we don't know who's curling). Fall back to creating
  // under the system user (id=-1 is used elsewhere; verify against your repo
  // — using sessionUserId is the safe default; token-without-session must
  // pass userId explicitly).
  const ownerUserId =
    sessionUserId ?? (typeof req.body?.userId === 'number' ? req.body.userId : null);
  if (!ownerUserId) {
    return res.status(400).json({
      error: 'Missing owner — pass `userId` in body when authenticating with WEBHOOK_TOKEN.',
    });
  }

  // Resolve / create thumbnail Image. Inline-upload shape goes through the
  // same `createImage` path that PolyGen uses, so NSFW / CSAM scan happens
  // identically.
  let thumbnailImageId: number;
  if ('imageId' in body.thumbnail) {
    thumbnailImageId = body.thumbnail.imageId;
  } else {
    const created = await createImage({
      type: MediaType.image,
      url: body.thumbnail.url,
      name: body.thumbnail.name ?? 'test-thumbnail',
      width: body.thumbnail.width ?? null,
      height: body.thumbnail.height ?? null,
      hash: body.thumbnail.hash,
      sizeKB: body.thumbnail.sizeKB,
      meta: body.thumbnail.meta,
      userId: ownerUserId,
    });
    thumbnailImageId = created.id;
  }

  // Synthetic workflowId so the row is idempotent and indistinguishable from a
  // real PolyGen draft. `test-` prefix is the discriminator if anyone audits.
  const workflowId = `test-${randomUUID()}`;

  // Snapshot the test-shape into generationParams so the detail page's
  // Generation Details panel can render *something* representative.
  const generationParams: Prisma.InputJsonValue = {
    source: 'test-endpoint',
    engine: 'fal',
    model: 'meshy',
    operation: body.sourceImageId ? 'imageTo3D' : 'textTo3D',
    test: true,
    ...(body.generationParams ?? {}),
  };

  const { id, created } = await upsertModel3DFromWorkflow({
    workflowId,
    userId: ownerUserId,
    thumbnailImageId,
    sourceImageId: body.sourceImageId,
    licenseId: body.licenseId,
    generationParams,
    files: body.files.map((f) => ({
      name: f.name ?? `test-${workflowId}.${f.format}`,
      url: f.url,
      format: f.format,
      sizeKB: f.sizeKB,
      isPrimary: f.format === 'glb',
    })),
  });

  // Set the freshly-created Model3D's name to the user-supplied one. The
  // shared `upsertModel3DFromWorkflow` always creates with a placeholder
  // name ("Generated 3D Model") to match the real PolyGen path — we patch
  // it post-create to honor the test page's input without forking the helper.
  if (created) {
    const { dbWrite } = await import('~/server/db/client');
    await dbWrite.model3D.update({
      where: { id },
      data: { name: body.name, description: body.description },
    });
  }

  // Optional: immediately flip Draft → Published so the publish/view/review
  // loop can be exercised end-to-end from a single call. Requires a session
  // path (publishModel3D takes a SessionUser).
  if (body.publish) {
    if (!sessionUserId) {
      return res.status(400).json({
        error: 'publish=true requires session auth (publishModel3D needs a SessionUser).',
        model3dId: id,
        created,
      });
    }
    try {
      await publishModel3D({
        input: { id },
        user: { id: sessionUserId, isModerator: true },
      });
    } catch (e) {
      return res.status(200).json({
        model3dId: id,
        created,
        publishedError: e instanceof Error ? e.message : String(e),
        viewUrl: `/3d-models/${id}`,
      });
    }
  }

  return res.status(200).json({
    model3dId: id,
    created,
    workflowId,
    viewUrl: `/3d-models/${id}`,
  });
}
