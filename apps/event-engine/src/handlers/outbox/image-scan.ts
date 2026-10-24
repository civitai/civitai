// The three disables below are all the same reason: the processor body is commented out until
// the old ingestion service is removed from prod, and these are the bindings it uses.
import { createOutboxHandler } from '../base'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { withKafka } from '@/services/spine'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { getImageUrl } from '@/utils/media';

export const postHandler = createOutboxHandler<{url: string}>({
  entityTypes: ['Image'],
  events: ['TO_SCAN'],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  processor: async ({ event, entityId, actions, details }) => {
    // TODO briant: Enable this when we have the old ingestion service removed from prod
    // Do nothing until we remove old image ingestion
    return;

    /* Disabled for now - re-enable when ready to process image scans
    const { url } = details ?? {};

    if (!url) return;

    const metadata = {
      imageId: entityId
    }

    const presignedUrl = await getImageUrl(url);
    if (!presignedUrl) {
      console.warn(`Image Scan: Unable to get presigned URL for image ${entityId}`);
      return;
    }

    await actions.spine.req(withKafka({
      topic: 'orchestrator.imageScanned',
      metadata: {
        imageId: entityId
      },
      arguments: {
        url: presignedUrl
      },
      steps: ({ args }) => [
        {
          $type: 'wdTagging',
          name: 'tags',
          metadata,
          input: {
            mediaUrl: args.url,
            model:
              'urn:air:siglip2:repository:huggingface:cella110n/cl_tagger_v2@b57909b8e9c63f71e208a26473e7aabdf45ed6b6.tar',
            threshold: 0.55,
          }
        },
        {
          $type: 'mediaRating',
          name: 'rating',
          metadata,
          input: {
            mediaUrl: args.url
          }
        },
        {
          $type: 'mediaHash',
          name: 'hash',
          metadata,
          input: {
            mediaUrl: args.url,
            hashTypes: ['perceptual']
          }
        }
      ]
    }))
    */
  }
})
