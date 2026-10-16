import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';
import { STORYLINE_CHAPTER_PARAM } from '~/components/Storyline/storyline-mode.utils';

const ImageDetailModal = dynamic(() => import('~/components/Image/Detail/ImageDetailModal'), {
  ssr: false,
});

const imageDetailDialog = routedDialogDictionary.addItem('imageDetail', {
  component: ImageDetailModal,
  target: '#main',
  resolve: (query, { imageId, storylineChapterId, ...state }) => ({
    query: {
      ...query,
      imageId,
      ...(storylineChapterId ? { [STORYLINE_CHAPTER_PARAM]: storylineChapterId } : {}),
    },
    asPath: storylineChapterId
      ? `/images/${imageId}?${STORYLINE_CHAPTER_PARAM}=${storylineChapterId}`
      : `/images/${imageId}`,
    state,
  }),
});

export type ImageDetailDialog = typeof imageDetailDialog;
