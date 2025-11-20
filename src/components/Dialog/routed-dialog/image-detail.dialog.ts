import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const ImageDetailModal = dynamic(() => import('~/components/Image/Detail/ImageDetailModal'), {
  ssr: false,
});

const imageDetailDialog = routedDialogDictionary.addItem('imageDetail', {
  component: ImageDetailModal,
  target: '#main',
  resolve: (query, { imageId, ...state }) => ({
    query: { ...query, imageId },
    asPath: `/images/${imageId}`,
    state,
  }),
});

export type ImageDetailDialog = typeof imageDetailDialog;
