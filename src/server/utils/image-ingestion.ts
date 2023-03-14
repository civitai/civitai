import z from "zod";
import { tryDefaultChannel, tryRPC } from "../ingestion/client";

export const ingestionMessageSchema = z.object({
  source: z.object({
    type: z.string(),
    name: z.string(),
    id: z.number().gt(0),
    url: z.string(),
    user: z.object({
      id: z.number().gt(0),
      name: z.string(),
    }),
  }),
  image: z.string(),
  contentType: z.string().optional(),
  action: z.string(),
});

export const ingestionMessageResponseSchema = z.object({
  imageLabels: z.array(z.object({ Name: z.string(), Confidence: z.number() })),
  moderationLabels: z.array(
    z.object({ Name: z.string(), Confidence: z.number() })
  ),
});

/**
 * Send message to image ingestion service
 *
 * ```javascript
 * try {
 *   const response = await imageIngestion({ source: {...}, ...}, "imageId-1234")
 *   console.log(response.imageLabels, response.moderationLabels);
 * } catch (err) {
 *   console.log("could not ")
 * }
 * ```
 */
export const imageIngestion = async (
  message: typeof ingestionMessageSchema,
  id: string
): Promise<typeof ingestionMessageResponseSchema> => {
  return tryDefaultChannel().then((channel) =>
    tryRPC(message, id, ingestionMessageResponseSchema, channel)
  );
};
