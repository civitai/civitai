import produce from 'immer';
import { useRouter } from 'next/router';
import { createContext, Fragment, useContext, useMemo, useRef, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useCollection } from '~/components/Collections/collection.utils';
import type { DetailItem, DetailText } from '~/components/Image/Detail/detail-items';
import {
  anchorImageIndex,
  mergeDetailItems,
  TEXT_SLIDE_PARAM,
} from '~/components/Image/Detail/detail-items';
import { usePostDetailTexts } from '~/components/Image/Detail/usePostDetailTexts';
import type { ImagesQueryParamSchema } from '~/components/Image/image.utils';
import {
  hasImageDetailQueryFilters,
  parseImageQueryParams,
  useQueryImages,
} from '~/components/Image/image.utils';
import type { ConnectProps } from '~/components/ImageGuard/ImageGuard2';
import { useMarkImageMilestonesReadOnView } from '~/components/Notifications/notifications.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { parseIdParam } from '~/components/Storyline/storyline-mode.utils';
import { useCloseOnEscape } from '~/components/Image/Detail/useCloseOnEscape';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import type { CollectionByIdModel, ImageGetInfinite } from '~/types/router';
import { QS } from '~/utils/qs';
import { getModelUrl } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type ImageDetailState = {
  images: ImageGetInfinite;
  /** The carousel's slides: `images`, with any storyline text items placed among them. */
  items: DetailItem<ImageGetInfinite[number]>[];
  isLoading: boolean;
  active: boolean;
  connect: ConnectProps;
  isMod?: boolean;
  isOwner?: boolean;
  shareUrl: string;
  /** The URL's slide, in `items`. */
  index: number;
  toggleInfo: () => void;
  close: () => void;
  /** Point the URL at an image, or at a text slide anchored on `imageId`. */
  navigate: (imageId: number, textId?: number) => void;
  /** Point the URL at the slide at this index of `items`. */
  navigateTo: (index: number) => void;
  loadMore: () => void;
  hasMore: boolean;
  updateImage: (id: number, data: Partial<ImagesInfiniteModel>) => void;
  collection?: CollectionByIdModel;
  hideReactions?: boolean;
};

const ImageDetailContext = createContext<ImageDetailState | null>(null);
export const useImageDetailContext = () => {
  const context = useContext(ImageDetailContext);
  if (!context) throw new Error('useImageDetailContext not found in tree');
  return context;
};

export function ImageDetailProvider({
  children,
  imageId,
  images: initialImages = [],
  hideReactionCount,
  hideReactions,
  filters,
  collectionId,
  texts: givenTexts,
  postOrder,
}: {
  children: React.ReactElement;
  imageId: number;
  images?: ImagesInfiniteModel[];
  /** Text items to place among the images. Without it, a post-scoped viewer reads its post's own. */
  texts?: DetailText[];
  /** The order of the posts `texts` belong to, when the images span several (a storyline path). */
  postOrder?: number[];
  hideReactionCount?: boolean;
  hideReactions?: boolean;
  filters: ImagesQueryParamSchema;
  collectionId?: number;
}) {
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const hasHistory = useHasClientHistory();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  // Only do this so that we have it pre-fetched
  const { collection } = useCollection(collectionId as number, {
    enabled: !!collectionId,
  });

  // `browserRouter.query` holds raw strings, so reading `postId` off it with a cast
  // was not a parse: on `?postId=null` this handed the string 'null' to the `??`
  // below, it beat the parsed filter, and `image.getInfinite` was called with a
  // string against an input schema typed `z.number()` — a guaranteed failed request
  // on every load of the very links this page was fixed to serve. Parse it the same
  // way the filters are parsed; `active` is a genuine boolean read and stays a cast.
  const { postId: queryPostId } = parseImageQueryParams(browserRouter.query);
  const { active: queryActive = false } = browserRouter.query as { active?: boolean };
  const textId = parseIdParam(browserRouter.query[TEXT_SLIDE_PARAM]);
  // A comment link (`?highlight=`) opens with the phone sheet up. Held here rather than pushed as
  // `active`, so closing it is one tap and leaves no history entry for Back to step through.
  // Without it the highlight scroll drags the collapsed sheet into view and the toggle reads closed.
  const [deepLinkOpen, setDeepLinkOpen] = useState(() => !!browserRouter.query.highlight);
  const active = queryActive || deepLinkOpen;
  const { modelId, modelVersionId, username, userId, reactions, postId: filterPostId } = filters;
  const postId = queryPostId ?? filterPostId;
  // #region [data fetching]
  // Shared with the page-data endpoint, which withholds the main-image preload on the same rule.
  const shouldFetchMany = !initialImages?.length && hasImageDetailQueryFilters(filters, postId);
  const browsingLevel = useBrowsingLevelDebounced();
  const {
    images: queryImages = [],
    isInitialLoading: imagesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useQueryImages(
    // TODO: Hacky way to prevent sending the userId when filtering by reactions
    { ...filters, userId: !!reactions?.length ? undefined : userId, postId, browsingLevel },
    { enabled: shouldFetchMany }
  );

  const usingQueryImages = initialImages.length === 0;
  const baseImages = usingQueryImages ? queryImages : initialImages;

  // Seeded from a feed card, `images` is a fixed window the feed handed us — only
  // the query we own here can grow.
  const hasMore = usingQueryImages && shouldFetchMany && !!hasNextPage;
  const loadMore = () => {
    if (hasMore && !isFetchingNextPage) fetchNextPage();
  };

  const shouldFetchImage =
    !imagesLoading && (baseImages.length === 0 || !baseImages.find((x) => x.id === imageId));
  // TODO - this needs to return the data as `ImagesInfiniteModel`
  // alternatively, we always query multiple images, with the cursor starting at `imageId`
  const { data: prefetchedImage, isInitialLoading: imageQueryLoading } = trpc.image.get.useQuery(
    { id: imageId },
    { enabled: shouldFetchImage }
  );
  // A disabled observer still reports `isInitialLoading` while *another* observer
  // fetches the same key. `/images/[imageId]` renders this provider too and reads
  // its id from the same router store, so opening a routed image dialog over it
  // puts two providers on one id: the page owns the fetch, and the dialog — which
  // already has the image — showed a full-page loader over content that never
  // went away. Only report loading for a fetch we asked for.
  const imageLoading = shouldFetchImage && imageQueryLoading;

  // Prepended, not `unshift`ed: a routed dialog's props come from the immer-backed
  // dialog store, which deep-freezes them, and react-query freezes cached data in
  // dev — so mutating this in render threw `Cannot add property N, object is not
  // extensible`. Element identity is preserved because `updateImage` writes
  // through `images[index]` by reference.
  const images =
    prefetchedImage && shouldFetchImage ? [prefetchedImage as any, ...baseImages] : baseImages;

  const postTexts = usePostDetailTexts(postId, { enabled: !givenTexts });
  const texts = givenTexts ?? postTexts;
  const items = useMemo(
    () => mergeDetailItems(images, texts, postOrder),
    [images, texts, postOrder]
  );

  // A `?text=` id selects a text slide already among the items; an unknown one falls back to the image.
  function findCurrentIndex() {
    const textIndex = textId
      ? items.findIndex((x) => x.type === 'text' && x.text.id === textId)
      : -1;
    if (textIndex > -1) return textIndex;
    const index = items.findIndex((x) => x.type === 'image' && x.image.id === imageId);
    return index > -1 ? index : 0;
  }

  const index = findCurrentIndex();
  const anchor = anchorImageIndex(items, index);
  const image =
    anchor > -1 ? (items[anchor] as { image: ImageGetInfinite[number] }).image : undefined;

  const updateImage = (id: number, data: Partial<ImagesInfiniteModel>) => {
    queryUtils.image.getInfinite.setInfiniteData(
      { ...filters, userId: !!reactions?.length ? undefined : userId, postId, browsingLevel },
      produce((queryData) => {
        if (!queryData?.pages?.length) return;

        for (const page of queryData.pages)
          for (const item of page.items) {
            if (item.id === id) {
              Object.assign(item, data);
              break;
            }
          }
      })
    );

    queryUtils.image.get.setData(
      { id },
      produce((old) => {
        if (!old) {
          return old;
        }

        Object.assign(old, data);
        const index = images.findIndex((x) => x.id === id);
        if (index !== -1) Object.assign(images[index], data);
      })
    );
  };
  // #endregion

  // #region [back button functionality]
  const close = () => {
    if (hasHistory) browserRouter.back();
    else {
      const [, queryString] = browserRouter.asPath.split('?');
      const { active, ...query } = QS.parse(queryString) as any;

      if (active) browserRouter.replace({ query: browserRouter.query }, { query });
      else {
        const returnUrl = getReturnUrl({ postId, modelId, modelVersionId, username }) ?? '/images';
        router.push(returnUrl, undefined, { shallow: true });
      }
    }
  };
  useCloseOnEscape(close);

  // #region [info toggle]
  const toggleInfo = () => {
    if (deepLinkOpen) setDeepLinkOpen(false);
    if (deepLinkOpen && !queryActive) return;
    if (!active)
      browserRouter.push({ query: { ...browserRouter.query, active: true } }, browserRouter.asPath);
    else if (active) browserRouter.back();
  };
  // #endregion

  // #region [navigation]
  // The carousel keeps its own position and only writes the URL back. When the image changes from
  // anywhere else (a remix card opening its source over this detail), it would keep showing the old
  // one and, on its next settle, write that back over the new URL — so start the detail over.
  const lastNavigatedIdRef = useRef(imageId);
  const [seenImageId, setSeenImageId] = useState(imageId);
  const [externalMoves, setExternalMoves] = useState(0);
  if (!Object.is(seenImageId, imageId)) {
    setSeenImageId(imageId);
    setDeepLinkOpen(false);
    if (!Object.is(lastNavigatedIdRef.current, imageId)) setExternalMoves(externalMoves + 1);
    lastNavigatedIdRef.current = imageId;
  }

  const navigate = (id: number, textId?: number) => {
    lastNavigatedIdRef.current = id;
    const { [TEXT_SLIDE_PARAM]: _text, ...query } = browserRouter.query;
    const [, queryString] = browserRouter.asPath.split('?');
    const { [TEXT_SLIDE_PARAM]: _asText, ...asQuery } = QS.parse(queryString) as any;
    browserRouter.replace(
      { query: { ...query, imageId: id, ...(textId ? { [TEXT_SLIDE_PARAM]: textId } : {}) } },
      {
        pathname: `/images/${id}`,
        query: textId ? { ...asQuery, [TEXT_SLIDE_PARAM]: textId } : asQuery,
      }
    );
  };

  // A text slide has no page of its own: its URL is its anchor image's, with `?text=`.
  const navigateTo = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.type === 'image') return navigate(item.image.id);
    const anchorItem = items[anchorImageIndex(items, i)];
    if (anchorItem?.type === 'image') navigate(anchorItem.image.id, item.text.id);
  };

  // #endregion

  const shareUrl = useMemo(() => {
    const [pathname, queryString] = browserRouter.asPath.split('?');
    const { active, ...query } = QS.parse(queryString);
    return Object.keys(query).length > 0 ? `${pathname}?${QS.stringify(query)}` : pathname;
  }, [browserRouter]);

  const isMod = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === image?.user.id;
  // `index` falls back to 0 while the routed image loads; only mark the image actually shown.
  useMarkImageMilestonesReadOnView(isOwner && image?.id === imageId ? imageId : undefined);

  const connect: ConnectProps = modelId
    ? { connectType: 'model', connectId: modelId }
    : postId
    ? { connectType: 'post', connectId: postId }
    : username
    ? { connectType: 'user', connectId: username }
    : {};

  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === image?.user.id);

  if (imagesLoading || imageLoading) return <PageLoader />;
  if (!image || isBlocked) return <NotFound />;

  return (
    <ImageDetailContext.Provider
      value={{
        images,
        items,
        isLoading: imagesLoading || imageLoading,
        active,
        connect,
        toggleInfo,
        close,
        isOwner,
        isMod,
        shareUrl,
        navigate,
        navigateTo,
        loadMore,
        hasMore,
        index,
        updateImage,
        collection,
        hideReactions,
      }}
    >
      <Fragment key={externalMoves}>{children}</Fragment>
    </ImageDetailContext.Provider>
  );
}

const getReturnUrl = ({
  postId,
  modelId,
  modelVersionId,
  username,
}: {
  postId?: number;
  modelId?: number;
  modelVersionId?: number;
  username?: string;
}) => {
  if (modelId) {
    return getModelUrl({ modelId, modelVersionId });
  } else if (postId) {
    return `/posts/${postId}`;
  } else if (username) {
    return `/user/${username}/images`;
  }
};
