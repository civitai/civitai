import { Button, Image, Grid, Rating, SimpleGrid, Stack, Tabs, Text, Title } from '@mantine/core';
import { IconDownload } from '@tabler/icons';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { useImageLightbox } from '~/hooks/useImageLightbox';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ModelWithDetails } from '~/server/validators/models/getById';
import { formatDate } from '~/utils/date-helpers';
import { formatBytes } from '~/utils/number-helpers';

const VERSION_IMAGES_LIMIT = 8;

export function ModelVersions({ items, initialTab }: Props) {
  const mobile = useIsMobile();

  return (
    <Tabs defaultValue={initialTab} orientation={mobile ? 'horizontal' : 'vertical'}>
      <Grid gutter="lg">
        <Grid.Col xs={12} sm={3} md={2}>
          <Tabs.List sx={{ flexDirection: mobile ? 'row-reverse' : 'column-reverse' }}>
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
              <TabContent version={version} />
            </Tabs.Panel>
          ))}
        </Grid.Col>
      </Grid>
    </Tabs>
  );
}

type Props = {
  items: ModelWithDetails['modelVersions'];
  initialTab?: string | null;
};

function TabContent({ version }: TabContentProps) {
  const mobile = useIsMobile();
  const { openImageLightbox } = useImageLightbox({
    initialSlide: 0,
    images: version.images.map(({ image }) => image),
  });

  const versionDetails: DescriptionTableProps['items'] = [
    { label: 'Rating', value: <Rating value={0} fractions={2} readOnly /> },
    { label: 'Uploaded', value: formatDate(version.createdAt) },
    { label: 'Steps', value: version.steps?.toLocaleString() ?? 0 },
    { label: 'Epoch', value: version.epochs?.toLocaleString() ?? 0 },
    ...(version.trainingDataUrl
      ? [
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
          },
        ]
      : []),
  ];

  const imagesLimit = mobile ? VERSION_IMAGES_LIMIT / 2 : VERSION_IMAGES_LIMIT;

  return (
    <Grid gutter="xl">
      <Grid.Col xs={12} md={4} orderMd={2}>
        <Stack spacing="xs">
          <Button
            component="a"
            target="_blank"
            href={`/api/download/models/${version.id}`}
            leftIcon={<IconDownload size={16} />}
            fullWidth
            download
          >
            {`Download (${formatBytes(version.sizeKB)})`}
          </Button>
          <DescriptionTable items={versionDetails} labelWidth="30%" />
          <Title order={3}>About this version</Title>
          <ContentClamp>
            <Text>{version.description}</Text>
          </ContentClamp>
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
          {version.images.slice(0, imagesLimit).map(({ image }, index) => (
            <Image
              key={index}
              src={image.url}
              radius="md"
              width="100%"
              height="100%"
              alt={
                image.name ??
                'Visual representation of the output after running the model using this version'
              }
              sx={{
                figure: { height: '100%', display: 'flex' },
                ...(index === 0 && !mobile
                  ? {
                      gridColumn: '1/3',
                      gridRow: '1/5',
                      figure: { height: '100%', display: 'flex' },
                    }
                  : {}),
              }}
              onClick={() => openImageLightbox({ initialSlide: index })}
            />
          ))}
          {version.images.length > imagesLimit ? (
            <Button
              variant="outline"
              sx={!mobile ? { height: '100%' } : undefined}
              onClick={() => openImageLightbox({ initialSlide: imagesLimit })}
            >
              View more
            </Button>
          ) : null}
        </SimpleGrid>
      </Grid.Col>
    </Grid>
  );
}

type TabContentProps = { version: Props['items'][number] };
