import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';
import {
  parseIdListParam,
  STORYLINE_CHAPTER_PARAM,
  STORYLINE_VIA_PARAM,
  storylineReadHref,
} from '~/components/Storyline/storyline-mode.utils';

const ImageDetailModal = dynamic(() => import('~/components/Image/Detail/ImageDetailModal'), {
  ssr: false,
});

// A history entry inherits the previous entry's state, so a detail opened from inside another
// one (the remix card) would otherwise arrive with the first one's feed. Cleared unless named.
const FEED_STATE_RESET = {
  images: undefined,
  postTail: undefined,
  filters: undefined,
  collectionId: undefined,
  hideReactionCount: undefined,
  hideReactions: undefined,
};

const imageDetailDialog = routedDialogDictionary.addItem('imageDetail', {
  component: ImageDetailModal,
  target: '#main',
  resolve: (query, { imageId, storylineChapterId, storylineVia, ...state }) => {
    // An image opened from inside the reader (a remix, say) is not in the storyline: drop the
    // reader's params rather than carry them into a URL that no longer names them.
    const {
      [STORYLINE_CHAPTER_PARAM]: _chapter,
      [STORYLINE_VIA_PARAM]: _via,
      ...rest
    } = query as Record<string, unknown>;
    // Props come back from the query on a reload, where the list is a comma string.
    const via = parseIdListParam(
      Array.isArray(storylineVia) ? storylineVia.join(',') : storylineVia
    );
    return {
      query: {
        ...rest,
        imageId,
        ...(storylineChapterId ? { [STORYLINE_CHAPTER_PARAM]: storylineChapterId } : {}),
        ...(storylineChapterId && via.length ? { [STORYLINE_VIA_PARAM]: via.join(',') } : {}),
      },
      asPath: storylineChapterId
        ? storylineReadHref({ imageId, chapterId: storylineChapterId, via })
        : `/images/${imageId}`,
      state: { ...FEED_STATE_RESET, ...state },
    };
  },
});

export type ImageDetailDialog = typeof imageDetailDialog;
