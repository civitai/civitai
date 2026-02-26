import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const GeneratedImageLightbox = dynamic(
  () => import('~/components/ImageGeneration/GeneratedImageLightbox'),
  { ssr: false }
);

const generatedImageDialog = routedDialogDictionary.addItem('generatedImage', {
  component: GeneratedImageLightbox,
  resolve: (query, { imageId, workflowId }) => ({
    query: { ...query, imageId, workflowId },
  }),
});

export type GeneratedImageDialog = typeof generatedImageDialog;
