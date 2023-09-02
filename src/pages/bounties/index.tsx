import { Group, Stack, Title } from '@mantine/core';
import { useRouter } from 'next/router';

import { Announcements } from '~/components/Announcements/Announcements';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ArticleCategoriesInfinite } from '~/components/Article/Categories/ArticleCategoriesInfinite';
import { ArticleCategories } from '~/components/Article/Infinite/ArticleCategories';
import { BountiesInfinite } from '~/components/Bounties/Infinite/BountiesInfinite';
import { PeriodFilter, SortFilter, ViewToggle } from '~/components/Filters';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function BountiesPage() {
  const currentUser = useCurrentUser();

  return (
    <>
      {/* TODO.bounty: update meta title and description accordingly */}
      <Meta
        title={`Civitai${
          !currentUser
            ? ` Bounties | Discover AI-Generated Images with Prompts and Resource Details`
            : ''
        }`}
        description="Browse Civitai Bounties, featuring AI-generated images along with prompts and resources used for their creation, showcasing the creativity of our talented community."
      />
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs">
            <Announcements
              sx={(theme) => ({
                marginBottom: -35,
                [theme.fn.smallerThan('md')]: {
                  marginBottom: -5,
                },
              })}
            />
            <Group position="left">
              <FullHomeContentToggle />
            </Group>
            <Group position="apart" spacing={0}>
              <SortFilter type="articles" />
              <Group spacing={4}>
                <PeriodFilter type="articles" />
                <ViewToggle type="articles" />
              </Group>
            </Group>
            <ArticleCategories />
            <BountiesInfinite />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}
