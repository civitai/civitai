import { ArticleEngagementType } from '@prisma/client';
import produce from 'immer';
import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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

  const isToggled = useMemo(() => {
    if (!data) return undefined;
    const keys = Object.keys(data) as ArticleEngagementType[];
    return keys.reduce<Partial<Record<ArticleEngagementType, boolean>>>((acc, key) => {
      const ids = data[key] ?? [];
      return { ...acc, [key]: !!ids.find((id) => id === articleId) };
    }, {});
  }, [data, articleId]);

  const { mutate, isLoading } = trpc.user.toggleArticleEngagement.useMutation({
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
    },
    onSuccess: async (response, { type, articleId }) => {
      await queryUtils.article.getInfinite.invalidate({ favorites: true });
      await queryUtils.article.getInfinite.invalidate({ hidden: true });
    },
  });

  const handleToggle = (type: ArticleEngagementType) => {
    if (isLoading) return;
    mutate({ type, articleId });
  };

  return children({
    toggle: handleToggle,
    isLoading,
    isToggled,
  });
}
