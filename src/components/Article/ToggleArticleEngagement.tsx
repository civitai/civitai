import { ArticleEngagementType } from '@prisma/client';
import produce from 'immer';
import { useMemo } from 'react';
import { useSystemCollections } from '~/components/Collections/collection.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ToggleArticleEngagement({
  articleId,
  children,
}: {
  articleId: number;
  children: (args: {
    toggle: (type: ArticleEngagementType) => void;
    isLoading: boolean;
    isToggled?: Partial<Record<ArticleEngagementType, boolean>>;
  }) => React.ReactElement;
}) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  const { data } = trpc.user.getArticleEngagement.useQuery(undefined, { enabled: !!currentUser });
  const { data: bookmarkedArticles } = trpc.user.getBookmarkedArticles.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const isToggled = useMemo(() => {
    if (!data) return undefined;
    const keys = Object.keys(data) as ArticleEngagementType[];
    const engagements = keys.reduce<Partial<Record<ArticleEngagementType, boolean>>>((acc, key) => {
      const ids = data[key] ?? [];
      return { ...acc, [key]: !!ids.includes(articleId) };
    }, {});

    return {
      ...engagements,
      [ArticleEngagementType.Favorite]: !!bookmarkedArticles?.includes(articleId),
    };
  }, [data, articleId, bookmarkedArticles]);

  const { mutate: toggleEngagement, isLoading: isLoadingToggleEngagement } =
    trpc.user.toggleArticleEngagement.useMutation({
      onMutate: async ({ type, articleId }) => {
        const previousEngagements = queryUtils.user.getArticleEngagement.getData() ?? {};
        const previousArticle = queryUtils.article.getById.getData({ id: articleId });
        const ids = previousEngagements[type] ?? [];
        const isToggled = !!ids.find((id) => id === articleId);

        if (type === ArticleEngagementType.Favorite) {
          queryUtils.article.getById.setData(
            { id: articleId },
            produce((article) => {
              if (!article?.stats) return;
              const favoriteCount = article.stats.favoriteCountAllTime;
              article.stats.favoriteCountAllTime += !isToggled ? 1 : favoriteCount > 0 ? -1 : 0;
            })
          );
        }

        queryUtils.user.getArticleEngagement.setData(undefined, (old = {}) => ({
          ...old,
          [type]: !isToggled ? [...ids, articleId] : [...ids.filter((id) => id !== articleId)],
        }));

        return { previousEngagements, previousArticle };
      },
      onError: (_error, _variables, context) => {
        queryUtils.user.getArticleEngagement.setData(undefined, context?.previousEngagements);
        queryUtils.article.getById.setData({ id: articleId }, context?.previousArticle);

        showErrorNotification({
          title: 'There was an error while hiding this article',
          error: new Error(_error.message),
        });
      },
      onSuccess: async (response, { type, articleId }) => {
        await queryUtils.article.getInfinite.invalidate({ hidden: true });
      },
    });

  const { mutate: toggleBookmark, isLoading: isLoadingToggleBookmark } =
    trpc.user.toggleBookmarkedArticle.useMutation({
      onMutate: async ({ id: articleId }) => {
        const previousBookmarks = queryUtils.user.getBookmarkedArticles.getData() ?? [];
        const previousArticle = queryUtils.article.getById.getData({ id: articleId });
        const isToggled = !!previousBookmarks.find((id) => id === articleId);

        queryUtils.article.getById.setData(
          { id: articleId },
          produce((article) => {
            if (!article?.stats) return;
            const favoriteCount = article.stats.favoriteCountAllTime;
            article.stats.favoriteCountAllTime += !isToggled ? 1 : favoriteCount > 0 ? -1 : 0;
          })
        );

        queryUtils.user.getBookmarkedArticles.setData(undefined, () =>
          !isToggled
            ? [...previousBookmarks, articleId]
            : [...previousBookmarks.filter((id) => id !== articleId)]
        );

        return { previousBookmarks, previousArticle };
      },
      onError: (_error, _variables, context) => {
        queryUtils.user.getBookmarkedArticles.setData(undefined, context?.previousBookmarks);
        queryUtils.article.getById.setData({ id: articleId }, context?.previousArticle);

        showErrorNotification({
          title: 'There was an error while bookmarking this article',
          error: new Error(_error.message),
        });
      },
      onSuccess: async () => {
        await queryUtils.article.getInfinite.invalidate({ hidden: true });
      },
    });

  const isLoading = isLoadingToggleBookmark || isLoadingToggleEngagement;

  const handleToggle = (type: ArticleEngagementType) => {
    if (isLoading) return;

    if (type === ArticleEngagementType.Favorite) {
      toggleBookmark({ id: articleId });
    } else {
      toggleEngagement({ type, articleId });
    }
  };

  return children({
    toggle: handleToggle,
    isLoading,
    isToggled,
  });
}
