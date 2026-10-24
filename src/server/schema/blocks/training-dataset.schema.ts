import * as z from 'zod';
import {
  civitaiHostedImageUrlSchema,
  SOURCE_IMAGE_URL_MAX,
} from '~/server/schema/blocks/civitai-image-url';

// The `kind:'training'` dataset items (App Blocks): the consumer blobs the page host
// uploaded for the viewer, each with its caption — the same `{ air, caption }` shape
// the Training Studio sends.
//
// FREE OF IMPORTS other than zod and the client-safe image-url bound: the page host
// reads `trainingBlobKeyFromAir` too, and importing `workflow.schema.ts` there would
// put its step and recipe registries in the page host's client bundle.

/** Max images in one training dataset. */
export const BLOCK_TRAINING_DATASET_MAX_ITEMS = 50;
/** Max characters of one training caption. */
export const BLOCK_TRAINING_CAPTION_MAX_CHARS = 8192;

const CONSUMER_BLOB_PATH_PREFIX = '/v2/consumer/blobs/';
/** A consumer blob key: the orchestrator's id, optionally with its file extension. */
const BLOB_KEY_REGEX = /^[A-Za-z0-9]{1,64}(\.[A-Za-z0-9]{1,8})?$/;

/**
 * The consumer-blob key an item's `air` names, or `null` when it names anything
 * else. Accepts the bare key, or a Civitai-hosted https url whose path is exactly
 * `/v2/consumer/blobs/<key>` (the upload's own url; its query is dropped).
 */
export function trainingBlobKeyFromAir(air: string): string | null {
  if (BLOB_KEY_REGEX.test(air)) return air;
  const url = civitaiHostedImageUrlSchema.safeParse(air);
  if (!url.success) return null;
  const { pathname } = new URL(url.data);
  if (!pathname.startsWith(CONSUMER_BLOB_PATH_PREFIX)) return null;
  const key = pathname.slice(CONSUMER_BLOB_PATH_PREFIX.length);
  return BLOB_KEY_REGEX.test(key) ? key : null;
}

/** Identity of a blob key for comparison; keys are case-insensitive. */
export function trainingBlobKeyIdentity(key: string): string {
  return key.toLowerCase();
}

/**
 * The keys of `itemKeys` that `uploadedKeys` does not name — empty when every item
 * is a blob the caller uploaded. A non-array `itemKeys` is reported as foreign
 * whole, so a malformed reply can never read as "nothing foreign".
 */
export function findForeignTrainingBlobKeys(
  itemKeys: unknown,
  uploadedKeys: Iterable<string>
): string[] {
  if (!Array.isArray(itemKeys)) return ['<unreadable>'];
  const uploaded = new Set([...uploadedKeys].map(trainingBlobKeyIdentity));
  return itemKeys
    .filter((key) => typeof key !== 'string' || !uploaded.has(trainingBlobKeyIdentity(key)))
    .map(String);
}

/**
 * `kind:'training'` items, each `air` canonicalized to its bare blob key — so the
 * quote's body hash, the run key and the orchestrator step all see one spelling.
 * A dataset naming one blob twice is refused (the orchestrator refuses it too).
 */
export const blockTrainingDatasetItemsSchema = z
  .array(
    z
      .object({
        air: z
          .string()
          .max(SOURCE_IMAGE_URL_MAX)
          .transform((air, ctx) => {
            const key = trainingBlobKeyFromAir(air);
            if (key === null) {
              ctx.addIssue({
                code: 'custom',
                message: 'air must be a consumer blob key or its Civitai-hosted blob url',
              });
              return z.NEVER;
            }
            return key;
          }),
        caption: z.string().max(BLOCK_TRAINING_CAPTION_MAX_CHARS),
      })
      .strict()
  )
  .min(1)
  .max(BLOCK_TRAINING_DATASET_MAX_ITEMS)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const identity = trainingBlobKeyIdentity(item.air);
      if (seen.has(identity)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'air'],
          message: 'a training dataset names each image once',
        });
      }
      seen.add(identity);
    });
  });
