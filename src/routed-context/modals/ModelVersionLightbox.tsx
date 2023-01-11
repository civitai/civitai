import { useRouter } from 'next/router';
import { z } from 'zod';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { Lightbox } from '~/routed-context/modals/Lightbox';
import { trpc } from '~/utils/trpc';

export default createRoutedContext({
  schema: z.object({
    modelVersionId: z.number(),
    initialSlide: z.number().optional(),
  }),
  Element: ({ context, props: { modelVersionId, initialSlide } }) => {
    const router = useRouter();
    const id = Number(router.query.id);
    // this should be ok to do once we update the model detail page
    // TODO - have this use a different query: trpc.modelVersion.getById.useQuery({id: modelVersionId})
    const { data } = trpc.model.getById.useQuery({ id });
    const modelVersion = data?.modelVersions.find((x) => x.id === modelVersionId);

    return (
      <Lightbox
        nsfw={data?.nsfw}
        opened={context.opened}
        onClose={context.close}
        initialSlide={initialSlide}
        images={modelVersion?.images}
        connect={{ entityId: id, entityType: 'model' }}
      />
    );
  },
});
