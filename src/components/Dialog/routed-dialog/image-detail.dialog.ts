import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';
import {
  STORYLINE_CHAPTER_PARAM,
  STORYLINE_VIA_PARAM,
  storylineReadHref,
} from '~/components/Storyline/storyline-mode.utils';

const ImageDetailModal = dynamic(() => import('~/components/Image/Detail/ImageDetailModal'), {
  ssr: false,
});

const imageDetailDialog = routedDialogDictionary.addItem('imageDetail', {
  component: ImageDetailModal,
  target: '#main',
  resolve: (query, { imageId, storylineChapterId, storylineVia = [], ...state }) => ({
    query: {
      ...query,
      imageId,
      ...(storylineChapterId ? { [STORYLINE_CHAPTER_PARAM]: storylineChapterId } : {}),
      ...(storylineChapterId && storylineVia.length
        ? { [STORYLINE_VIA_PARAM]: storylineVia.join(',') }
        : {}),
    },
    asPath: storylineChapterId
      ? storylineReadHref({ imageId, chapterId: storylineChapterId, via: storylineVia })
      : `/images/${imageId}`,
    state,
  }),
});

export type ImageDetailDialog = typeof imageDetailDialog;
