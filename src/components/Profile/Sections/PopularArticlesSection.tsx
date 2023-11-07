import {
  ProfileSection,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from 'react-intersection-observer';
import { IconPencilMinus, IconTrendingUp } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { ArticleSort } from '~/server/common/enums';
import { useQueryArticles } from '~/components/Article/article.utils';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { Button } from '@mantine/core';
import { NextLink } from '@mantine/next';

const MAX_ARTICLES_DISPLAY = 4;
export const PopularArticlesSection = ({ user }: ProfileSectionProps) => {
  const { ref, inView } = useInView();
  const { articles: _articles, isLoading } = useQueryArticles(
    {
      limit: MAX_ARTICLES_DISPLAY + 1,
      username: user.username,
      sort: ArticleSort.MostBookmarks,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const articles = useMemo(() => _articles.slice(0, MAX_ARTICLES_DISPLAY), [_articles]);

  const { classes } = useProfileSectionStyles({
    count: articles.length,
    rowCount: 2,
    columnCount: 2,
  });

  const isNullState = !isLoading && !articles.length;

  return (
    <div ref={ref}>
      {isNullState ? null : isLoading ? (
        <ProfileSectionPreview />
      ) : (
        <ProfileSection title="Most popular articles" icon={<IconPencilMinus />}>
          <div className={classes.grid}>
            {articles.map((article) => (
              <ArticleCard data={article} aspectRatio="flat" key={article.id} useCSSAspectRatio />
            ))}
          </div>

          {_articles.length > MAX_ARTICLES_DISPLAY && (
            <Button
              href={`/user/${user.username}/articles`}
              component={NextLink}
              rel="nofollow"
              size="md"
              display="inline-block"
              mr="auto"
            >
              View all Articles
            </Button>
          )}
        </ProfileSection>
      )}
    </div>
  );
};
