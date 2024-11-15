import {
  Stack,
  Text,
  Box,
  Center,
  Loader,
  Title,
  ThemeIcon,
  Card,
  Image,
  Avatar,
  Badge,
  Button,
} from '@mantine/core';
import { useInstantSearch } from 'react-instantsearch';

import {
  ClearRefinements,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { ToolSearchIndexRecord } from '~/server/search-index/tools.search-index';
import { IconCloudOff, IconUser } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { TOOLS_SEARCH_INDEX } from '~/server/common/constants';
import { ToolsSearchIndexSortBy } from '~/components/Search/parsers/tool.parser';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { slugit } from '~/utils/string-helpers';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { generationPanel, generationStore } from '~/store/generation.store';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { ToolType } from '@prisma/client';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.toolSearch)
      return {
        redirect: { destination: '/', permanent: false },
      };

    return { props: {} };
  },
});

export default function ToolSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Content>
        <SearchHeader />
        <ToolHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

const RenderFilters = () => {
  return (
    <>
      <SortBy
        title="Sort tools by"
        items={[
          { label: 'Relevancy', value: ToolsSearchIndexSortBy[0] as string },
          { label: 'Name (A - Z)', value: ToolsSearchIndexSortBy[1] as string },
          { label: 'Name (Z - A)', value: ToolsSearchIndexSortBy[2] as string },
          { label: 'Date Added (Oldest - Newest)', value: ToolsSearchIndexSortBy[3] as string },
          { label: 'Date Added (Newest - Oldest)', value: ToolsSearchIndexSortBy[4] as string },
        ]}
      />
      <SearchableMultiSelectRefinementList title="Type" attribute="type" searchable />
      <SearchableMultiSelectRefinementList title="Company" attribute="company" searchable />
      <ClearRefinements />
    </>
  );
};

export function ToolHitList() {
  const { items, showMore, isLastPage } = useInfiniteHitsTransformed<'tools'>();
  const { status } = useInstantSearch();
  const { classes, cx } = useSearchLayoutStyles();

  if (items.length === 0) {
    const NotFound = (
      <Box>
        <Center>
          <Stack spacing="md" align="center" maw={800}>
            <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} inline>
              No tools found
            </Title>
            <Text align="center">
              We have a bunch of tools, but it looks like we couldn&rsquo;t find any matching your
              query.
            </Text>
          </Stack>
        </Center>
      </Box>
    );

    const loading = status === 'loading' || status === 'stalled';

    if (loading) {
      return (
        <Box>
          <Center mt="md">
            <Loader />
          </Center>
        </Box>
      );
    }

    return (
      <Box>
        <Center mt="md">
          {/* Just enough time to avoid blank random page */}
          <TimeoutLoader renderTimeout={() => <>{NotFound}</>} delay={150} />
        </Center>
      </Box>
    );
  }

  return (
    <Stack>
      <Box
        className={cx(classes.grid)}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(350px, 1fr))`,
        }}
      >
        {items.map((hit) => {
          return <ToolCard key={hit.id} data={hit} />;
        })}
      </Box>
      {items.length > 0 && !isLastPage && (
        <InViewLoader
          loadFn={showMore}
          loadCondition={status === 'idle'}
          style={{ gridColumn: '1/-1' }}
        >
          <Center p="xl" sx={{ height: 36 }} mt="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Stack>
  );
}

export function ToolCard({ data }: { data: ToolSearchIndexRecord }) {
  if (!data) return null;

  const sluggifiedName = slugit(data.name);

  return (
    <Link
      href={`/tools/${sluggifiedName}?tools=${data.id}`}
      as={`/tools/${sluggifiedName}`}
      passHref
    >
      <Card component="a" radius="md" withBorder>
        <Card.Section className="h-48">
          {data.bannerUrl ? (
            <EdgeMedia2
              className="size-full max-w-full object-cover"
              src={data.bannerUrl}
              width={1920}
              type="image"
            />
          ) : (
            <Image
              src="/images/civitai-default-account-bg.png"
              alt="default creator card background decoration"
              w="100%"
              h="100%"
              styles={{
                figure: { height: '100%' },
                imageWrapper: { height: '100%' },
                image: { objectFit: 'cover', height: '100% !important' },
              }}
            />
          )}
        </Card.Section>
        <div className="mt-4 flex flex-col items-start gap-4">
          <div className="flex flex-1 items-center gap-4">
            {data.icon ? (
              <Avatar
                src={getEdgeUrl(data.icon ?? undefined, { type: 'image', width: 40 })}
                size={40}
                radius="xl"
              />
            ) : (
              <ThemeIcon size="xl" radius="xl" variant="light">
                <IconUser />
              </ThemeIcon>
            )}
            <div className="flex flex-col">
              <Text size="lg" weight={600}>
                {data.name}
              </Text>
              <Text size="sm" color="dimmed">
                {data.company}
              </Text>
            </div>
          </div>
          <Badge size="sm" radius="xl">
            {data.type}
          </Badge>
          {data.description && (
            <Text lineClamp={3}>
              <CustomMarkdown allowedElements={[]} unwrapDisallowed>
                {data.description}
              </CustomMarkdown>
            </Text>
          )}
          {data.supported && (
            <Button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();

                const isVideo = data.type === ToolType.Video;
                generationStore.setData({
                  resources: [],
                  params: {},
                  type: isVideo ? 'video' : 'image',
                  // TODO.gen: have to think this through on how to get the right workflow
                  workflow: isVideo ? `${data.name.toLowerCase}-txt2vid` : undefined,
                });
                generationPanel.open();
              }}
              fullWidth
            >
              Generate
            </Button>
          )}
        </div>
      </Card>
    </Link>
  );
}

ToolSearch.getLayout = function getLayout(page: React.ReactNode) {
  return (
    <SearchLayout
      indexName={TOOLS_SEARCH_INDEX}
      leftSidebar={
        <SearchLayout.Filters>
          <RenderFilters />
        </SearchLayout.Filters>
      }
    >
      {page}
    </SearchLayout>
  );
};
