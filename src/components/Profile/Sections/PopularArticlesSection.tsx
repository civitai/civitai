import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection, ProfileSectionPreview } from '~/components/Profile/ProfileSection';
import { IconArrowRight, IconPencilMinus } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { ArticleSort } from '~/server/common/enums';
import { useQueryArticles } from '~/components/Article/article.utils';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { Button, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import classes from '~/components/Profile/ProfileSection.module.css';

const MAX_ARTICLES_DISPLAY = 32;
export const PopularArticlesSection = ({ user }: ProfileSectionProps) => {
  const [ref, inView] = useInViewDynamic({ id: 'profile-article-section' });
  const { articles: _articles, isLoading } = useQueryArticles(
    {
      limit: MAX_ARTICLES_DISPLAY + 1,
      username: user.username,
      sort: ArticleSort.MostBookmarks,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const articles = useMemo(() => _articles.slice(0, MAX_ARTICLES_DISPLAY), [_articles]);

  const isNullState = !isLoading && !articles.length;

  if (isNullState && inView) {
    return null;
  }

  return (
    <div
      ref={ref}
      className={isNullState ? undefined : classes.profileSection}
      style={
        {
          '--count': articles.length,
          '--row-count': 1,
        } as React.CSSProperties
      }
    >
      {inView &&
        (isLoading ? (
          <ProfileSectionPreview />
        ) : (
          <ProfileSection
            title="Most popular articles"
            icon={<IconPencilMinus />}
            action={
              <Link
                legacyBehavior
                href={`/user/${user.username}/articles?sort=${ArticleSort.Newest}`}
                passHref
              >
                <Button
                  h={34}
                  component="a"
                  variant="subtle"
                  rightSection={<IconArrowRight size={16} />}
                >
                  <Text inherit> View all Articles</Text>
                </Button>
              </Link>
            }
          >
            <ShowcaseGrid itemCount={articles.length} rows={1}>
              {articles.map((article) => (
                <ArticleCard data={article} aspectRatio="square" key={article.id} />
              ))}
            </ShowcaseGrid>
          </ProfileSection>
        ))}
    </div>
  );
};
