import z from "zod";
import { tryBasicPublish, tryDefaultChannel } from "../ingestion/client";

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

/**
 * Send message to image ingestion service
 * imageIngestion({ source: {...}, ...})
 */
export const imageIngestion = async (
  message: typeof ingestionMessageSchema
) => {
  const channel = await tryDefaultChannel();

  // Could not connect to message queue
  if (channel === undefined) {
    return;
  }

  return tryBasicPublish(channel, "ingestion", message);
};
