import { Box, Center, Group, Stack, Title } from '@mantine/core';
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
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import styles from './[tagname].module.scss';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const tagname = ctx.query.tagname as string;
    if (tagname) await ssg?.tag.getTagWithModelCount.prefetch({ name: tagname });

    return { props: { tagname } };
  },
});

export default function TagPage({
  tagname,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { set, ...queryFilters } = useModelQueryParams();

  const { data = [] } = trpc.tag.getTagWithModelCount.useQuery({ name: tagname });
  const [tag] = data;

  return (
    <>
      <Meta
        title={`${tag?.name} AI Models | Civitai`}
        description={`Browse ${tag?.name} Stable Diffusion & Flux models, LoRAs, checkpoints, embeddings, and more for AI image generation.`}
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL as string}/tag/${tagname}`, rel: 'canonical' }]}
        deIndex={tag?.unfeatured ?? false}
      />
      {tag && (
        <Box className={styles.banner} mb="md">
          <Center>
            <Stack gap="xs">
              <Title order={1} className="text-center">
                {tag.name}
              </Title>
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
