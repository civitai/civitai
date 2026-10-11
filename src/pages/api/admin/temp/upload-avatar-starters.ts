import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { fetchGenerationOutputImage } from '~/server/services/blocks/block-image-upload.service';
import { createImage } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { uploadImageBufferToStore } from '~/utils/s3-utils';

/**
 * Avatar gen starter references: copies approved orchestrator outputs into the image store as
 * bare (postless) Image rows owned by `userId`, in colour and as a greyscale copy.
 *
 * POST body: { userId, items: [{ name, url }] } — up to 25 items per call. `name` is the
 * manifest key (e.g. "anime-niji-mara"); `url` is the image's orchestrator output URL.
 *
 * Both rows go through createImage's default ingestion, so they are scanned like any upload, and
 * carry `metadata.avatarStarter = { name, variant }`. A name that already has rows for this user
 * is skipped and its existing rows returned, so a failed call can be re-run safely.
 *
 * Response: { results: [{ name, colour: { imageId, url }, grey: { imageId, url } } | { name, error }] }
 */

const schema = z.object({
  userId: z.number().int().positive(),
  items: z
    .array(z.object({ name: z.string().regex(/^[a-z0-9-]{3,80}$/), url: z.string().url() }))
    .min(1)
    .max(25),
});

type Variant = 'colour' | 'grey';
type Stored = { imageId: number; url: string };

async function store(
  bytes: Buffer,
  contentType: string,
  userId: number,
  name: string,
  variant: Variant
): Promise<Stored> {
  const { width, height } = await sharp(bytes).metadata();
  const { key } = await uploadImageBufferToStore(bytes, { contentType });
  const image = await createImage({
    url: key,
    type: 'image',
    mimeType: contentType,
    width,
    height,
    metadata: { size: bytes.byteLength, avatarStarter: { name, variant } },
    userId,
  });
  return { imageId: image.id, url: key };
}

async function existingStarters(userId: number, names: string[]) {
  const rows = await dbRead.$queryRaw<
    { id: number; url: string; name: string; variant: Variant }[]
  >`
    SELECT id, url, metadata->'avatarStarter'->>'name' AS name, metadata->'avatarStarter'->>'variant' AS variant
    FROM "Image"
    WHERE "userId" = ${userId}
      AND "postId" IS NULL
      AND metadata->'avatarStarter'->>'name' = ANY(${names})
  `;
  const byName = new Map<string, Partial<Record<Variant, Stored>>>();
  for (const row of rows) {
    const entry = byName.get(row.name) ?? {};
    entry[row.variant] = { imageId: row.id, url: row.url };
    byName.set(row.name, entry);
  }
  return byName;
}

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const { userId, items } = parsed.data;

  const existing = await existingStarters(
    userId,
    items.map((item) => item.name)
  );

  const results = [];
  for (const { name, url } of items) {
    try {
      const found = existing.get(name) ?? {};
      if (found.colour && found.grey) {
        results.push({ name, colour: found.colour, grey: found.grey, skipped: true });
        continue;
      }
      const { bytes, contentType } = await fetchGenerationOutputImage(url);
      const colour = found.colour ?? (await store(bytes, contentType, userId, name, 'colour'));
      const greyBytes = await sharp(bytes).grayscale().jpeg({ quality: 90 }).toBuffer();
      const grey = found.grey ?? (await store(greyBytes, 'image/jpeg', userId, name, 'grey'));
      results.push({ name, colour, grey });
    } catch (error) {
      results.push({ name, error: (error as Error).message });
    }
  }

  return res.status(200).json({ results });
});
