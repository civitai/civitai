import {
  Group,
  Text,
  Title,
  Rating,
  Grid,
  Stack,
  Button,
  SimpleGrid,
  Image,
  useMantineTheme,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconDownload } from '@tabler/icons';
import dayjs from 'dayjs';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { ModelWithDetails } from '~/server/validators/models/getById';
import { formatBytes } from '~/utils/number-helpers';

const VERSION_IMAGES_LIMIT = 9;

export function ModelVersion({ version }: Props) {
  const theme = useMantineTheme();
  const mobile = useMediaQuery(`(max-width: ${theme.breakpoints.sm - 1}px)`, true, {
    getInitialValueInEffect: false,
  });

  const versionDetails: DescriptionTableProps['items'] = [
    { label: 'Uploaded', value: dayjs(version.createdAt).format('MMM DD, YYYY') },
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
                href={version.trainingDataUrl}
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

  const imagesLimit = mobile ? VERSION_IMAGES_LIMIT - 5 : VERSION_IMAGES_LIMIT;

  return (
    <Grid gutter="xl">
      <Grid.Col xs={12} sm={4} orderSm={2}>
        <Stack spacing="xs">
          <Button
            component="a"
            target="_blank"
            href={version.url}
            leftIcon={<IconDownload size={16} />}
            fullWidth
            download
          >
            {`Download (${formatBytes(version.sizeKB)})`}
          </Button>
          <DescriptionTable title="Version Details" items={versionDetails} />
        </Stack>
      </Grid.Col>
      <Grid.Col xs={12} sm={8} orderSm={1}>
        <Stack>
          <Group align="center" sx={{ justifyContent: 'space-between' }}>
            <Title order={3}>About this version</Title>
            <Rating value={0} fractions={2} readOnly />
          </Group>
          <Text>{version.description}</Text>
          <Title order={3}>Generated with this version</Title>
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
              />
            ))}
            {version.images.length > imagesLimit ? (
              <Button variant="outline" sx={!mobile ? { height: '100%' } : undefined}>
                View more
              </Button>
            ) : null}
          </SimpleGrid>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

type Props = {
  version: ModelWithDetails['modelVersions'][number];
};
