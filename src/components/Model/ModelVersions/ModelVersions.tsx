import { Button, Grid, Rating, SimpleGrid, Stack, Tabs, Text, Group } from '@mantine/core';
import { IconDownload } from '@tabler/icons';
import React from 'react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { TrainingWordBadge } from '~/components/TrainingWordBadge/TrainingWordBadge';
import { VerifiedShield } from '~/components/VerifiedShield/VerifiedShield';
import { useImageLightbox } from '~/hooks/useImageLightbox';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ModelById } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { formatKBytes } from '~/utils/number-helpers';

const VERSION_IMAGES_LIMIT = 8;

export function ModelVersions({ items, initialTab, nsfw }: Props) {
  const mobile = useIsMobile();

  return (
    <Tabs defaultValue={initialTab} orientation={mobile ? 'horizontal' : 'vertical'}>
      <Grid gutter="lg" style={{ flex: 1 }}>
        <Grid.Col xs={12} sm={3} md={2}>
          <Tabs.List>
            {items.map((version) => (
              <Tabs.Tab
                key={version.id}
                value={version.id.toString()}
                sx={{ whiteSpace: 'normal' }}
              >
                {version.name}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Grid.Col>
        <Grid.Col xs={12} sm={9} md={10}>
          {items.map((version) => (
            <Tabs.Panel key={version.id} value={version.id.toString()}>
              <TabContent version={version} nsfw={nsfw} />
            </Tabs.Panel>
          ))}
        </Grid.Col>
      </Grid>
    </Tabs>
  );
}

type Props = {
  items: NonNullable<ModelById>['modelVersions'];
  initialTab?: string | null;
  nsfw?: boolean;
};

function TabContent({ version, nsfw }: TabContentProps) {
  const mobile = useIsMobile();
  const { openImageLightbox } = useImageLightbox({
    initialSlide: 0,
    images: version.images.map(({ image }) => image),
  });

  const versionDetails: DescriptionTableProps['items'] = [
    {
      label: 'Rating',
      value: (
        <Group spacing={4}>
          <Rating value={version.rank?.ratingAllTime ?? 0} fractions={2} readOnly />
          <Text size="sm">({version.rank?.ratingCountAllTime.toLocaleString() ?? 0})</Text>
        </Group>
      ),
    },
    { label: 'Downloads', value: (version.rank?.downloadCountAllTime ?? 0).toLocaleString() },
    { label: 'Uploaded', value: formatDate(version.createdAt) },
    { label: 'Steps', value: version.steps?.toLocaleString() ?? 0, visible: !!version.steps },
    { label: 'Epoch', value: version.epochs?.toLocaleString() ?? 0, visible: !!version.epochs },
    {
      label: 'Trained Words',
      visible: !!version.trainedWords?.length,
      value: (
        <Group spacing={4}>
          {version?.trainedWords.map((word, index) => (
            <TrainingWordBadge key={index} word={word} />
          ))}
        </Group>
      ),
    },
    {
      label: 'Training Images',
      value: (
        <Text
          variant="link"
          component="a"
          href={`/api/download/training-data/${version.id}`}
          target="_blank"
          download
        >
          Download
        </Text>
      ),
      visible: !!version.trainingDataFile?.url,
    },
  ];

  const versionImages = version.images.map((x) => x.image);
  const imagesLimit = mobile ? VERSION_IMAGES_LIMIT / 2 : VERSION_IMAGES_LIMIT;

  return (
    <Grid gutter="xl">
      <Grid.Col xs={12} md={4} orderMd={2}>
        <Stack spacing="xs">
          <Group noWrap spacing="xs">
            <Button
              component="a"
              href={`/api/download/models/${version.id}`}
              leftIcon={<IconDownload size={16} />}
              download
              style={{ flex: 1 }}
              variant="light"
            >
              {`Download (${formatKBytes(version.modelFile?.sizeKB ?? 0)})`}
            </Button>
            <VerifiedShield file={version.modelFile} variant="light" />
          </Group>

          <DescriptionTable items={versionDetails} labelWidth="30%" />
          <Text size={16} weight={500}>
            About this version
          </Text>
          {version.description ? (
            <ContentClamp>
              <RenderHtml html={version.description} />
            </ContentClamp>
          ) : null}
        </Stack>
      </Grid.Col>
      <Grid.Col xs={12} md={8} orderMd={1}>
        <SimpleGrid
          breakpoints={[
            { minWidth: 'xs', cols: 1 },
            { minWidth: 'sm', cols: 2 },
            { minWidth: 'md', cols: 3 },
            { minWidth: 'lg', cols: 4 },
          ]}
        >
          {versionImages.slice(0, imagesLimit).map((image, index) => (
            <ImagePreview
              key={index}
              image={image}
              edgeImageProps={{ width: 400 }}
              nsfw={nsfw}
              radius="md"
              aspectRatio={1}
              lightboxImages={versionImages}
              withMeta
              sx={{
                height: '100%',
                width: '100%',
                figure: { height: '100%', display: 'flex' },
                ...(index === 0 && !mobile
                  ? {
                      gridColumn: '1/3',
                      gridRow: '1/3',
                      figure: { height: '100%', display: 'flex' },
                    }
                  : {}),
              }}
            />
          ))}
          {versionImages.length > imagesLimit ? (
            <Button
              variant="outline"
              sx={!mobile ? { height: '100%' } : undefined}
              onClick={() =>
                openImageLightbox({ initialSlide: imagesLimit, images: versionImages })
              }
            >
              View more
            </Button>
          ) : null}
        </SimpleGrid>
      </Grid.Col>
    </Grid>
  );
}

type TabContentProps = { version: Props['items'][number]; nsfw?: boolean };

// const useStyles = createStyles((theme, { index, mobile }: { index: number; mobile: boolean }) => ({
//   image: {
//     figure: { height: '100%', display: 'flex' },
//     ...(index === 0 && !mobile
//       ? {
//           gridColumn: '1/3',
//           gridRow: '1/5',
//           figure: { height: '100%', display: 'flex' },
//         }
//       : {}),
//   },
// }));
