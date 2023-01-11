import { z } from 'zod';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { trpc } from '~/utils/trpc';
import { Lightbox } from '~/routed-context/modals/Lightbox';

export default createRoutedContext({
  schema: z.object({
    reviewId: z.number(),
    initialSlide: z.number().optional(),
  }),
  Element: ({ context, props: { reviewId, initialSlide } }) => {
    const { data } = trpc.review.getDetail.useQuery({ id: reviewId });

    return (
      <Lightbox
        nsfw={data?.nsfw}
        opened={context.opened}
        onClose={context.close}
        initialSlide={initialSlide}
        images={data?.images}
        connect={{ entityId: reviewId, entityType: 'review' }}
      />
    );
  },
});
