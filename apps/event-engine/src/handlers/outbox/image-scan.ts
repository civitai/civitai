import { createOutboxHandler } from '../base'
import { withKafka } from '@/services/spine'
import { getImageUrl } from '@/utils/media';

export const postHandler = createOutboxHandler<{url: string}>({
  entityTypes: ['Image'],
  events: ['TO_SCAN'],
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
            model: 'wd14-vit.v1',
            threshold:0.5,
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
