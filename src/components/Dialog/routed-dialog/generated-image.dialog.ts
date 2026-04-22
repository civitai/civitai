import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const GeneratedOutputLightbox = dynamic(
  () => import('~/components/ImageGeneration/GeneratedOutputLightbox'),
  { ssr: false }
);

const generatedImageDialog = routedDialogDictionary.addItem('generatedImage', {
  component: GeneratedOutputLightbox,
  resolve: (query, { imageId, workflowId }) => ({
    query: { ...query, imageId, workflowId },
  }),
});

export type GeneratedImageDialog = typeof generatedImageDialog;
