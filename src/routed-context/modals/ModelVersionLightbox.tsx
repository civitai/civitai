import { z } from 'zod';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { Lightbox } from '~/routed-context/modals/Lightbox';
import { trpc } from '~/utils/trpc';

export default createRoutedContext({
  schema: z.object({
    id: z.number(),
    modelVersionId: z.number(),
    initialSlide: z.number().optional(),
  }),
  element: ({ context, props: { id, modelVersionId, initialSlide } }) => {
    // this should be ok to do once we update the model detail page
    // TODO - have this use a different query: trpc.modelVersion.getById.useQuery({id: modelVersionId})
    const { data } = trpc.model.getById.useQuery({ id });
    const modelVersion = data?.modelVersions.find((x) => x.id === modelVersionId);
    return (
      <Lightbox
        opened={context.opened}
        onClose={context.close}
        initialSlide={initialSlide}
        images={modelVersion?.images.map((x) => x.image)}
      />
    );
  },
});
