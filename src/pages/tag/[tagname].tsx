import { Box, Center, Group, Stack, Text, Title } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next/types';
import { SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { env } from '~/env/client';
import { constants } from '~/server/common/constants';
import type { TagPageSeoData } from '~/server/services/tag.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import styles from './[tagname].module.scss';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const tagname = ctx.query.tagname as string;
    if (tagname) await ssg?.tag.getTagWithModelCount.prefetch({ name: tagname });

    let seoData: TagPageSeoData = { count: 0, models: [] };
    if (tagname) {
      const { getTagPageSeoData } = await import('~/server/services/tag.service');
      seoData = await getTagPageSeoData({ name: tagname });
    }

    return { props: { tagname, seoData } };
  },
});

export default function TagPage({
  tagname,
  seoData,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { set, ...queryFilters } = useModelQueryParams();

  const { data = [] } = trpc.tag.getTagWithModelCount.useQuery({ name: tagname });
  const [tag] = data;

  const baseUrl = env.NEXT_PUBLIC_BASE_URL ?? 'https://civitai.com';
  const schema =
    tag && seoData.models.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: `${tag.name} AI Models`,
          description: `Browse ${seoData.count.toLocaleString()} Stable Diffusion & Flux models, LoRAs, checkpoints, and embeddings tagged with ${
            tag.name
          }.`,
          url: `${baseUrl}/tag/${tagname}`,
          numberOfItems: seoData.count,
          hasPart: seoData.models.map((m) => ({
            '@type': 'SoftwareApplication',
            name: m.name,
            applicationCategory: m.type,
            url: `${baseUrl}/models/${m.id}/${slugit(m.name)}`,
            author: { '@type': 'Person', name: m.creator },
            interactionStatistic: [
              {
                '@type': 'InteractionCounter',
                interactionType: 'http://schema.org/DownloadAction',
                userInteractionCount: m.stats.downloadCount,
              },
              {
                '@type': 'InteractionCounter',
                interactionType: 'http://schema.org/LikeAction',
                userInteractionCount: m.stats.thumbsUpCount,
              },
            ],
          })),
        }
      : undefined;

  const description =
    seoData.count > 0
      ? `Browse ${seoData.count.toLocaleString()} Stable Diffusion & Flux models, LoRAs, checkpoints, and embeddings tagged with ${
          tag?.name ?? tagname
        }.`
      : `Browse ${
          tag?.name ?? tagname
        } Stable Diffusion & Flux models, LoRAs, checkpoints, embeddings, and more for AI image generation.`;

  return (
    <>
      <Meta
        title={`${tag?.name ?? tagname} AI Models | Civitai`}
        description={description}
        canonical={`/tag/${tagname}`}
        deIndex={tag?.unfeatured ?? false}
        schema={schema}
      />
      {tag && (
        <Box className={styles.banner} mb="md">
          <Center>
            <Stack gap="xs">
              <Title order={1} className="text-center">
                {tag.name}
              </Title>
              <Text className="text-center" color="dimmed">
                {description}
              </Text>
            </Stack>
          </Center>
        </Box>
      )}
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer>
          <Stack gap="xs">
            <Group justify="flex-end">
              <SortFilter type="models" />
              <ModelFiltersDropdown size="compact-sm" />
            </Group>
            <ModelsInfinite
              filters={{ ...queryFilters, followed: false, hidden: false }}
              showEof
              showAds
            />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}
