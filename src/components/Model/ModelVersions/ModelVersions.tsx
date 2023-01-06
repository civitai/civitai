import {
  Button,
  Grid,
  Rating,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Group,
  Card,
  Menu,
} from '@mantine/core';
import { useRouter } from 'next/router';
import { startCase } from 'lodash';
import React from 'react';

import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { SFW } from '~/components/Media/SFW';
import { MultiActionButton } from '~/components/MultiActionButton/MultiActionButton';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { RunButton } from '~/components/RunStrategy/RunButton';
import { TrainingWordBadge } from '~/components/TrainingWordBadge/TrainingWordBadge';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useRoutedContext } from '~/routed-context/routed-context.provider';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { ModelById } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { ModelFileType } from '~/server/common/constants';
import { ModelHash } from '~/components/Model/ModelHash/ModelHash';
import { getPrimaryFile } from '~/server/utils/model-helpers';

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
  const router = useRouter();
  const modelId = Number(router.query.id);
  const mobile = useIsMobile();
  const { openContext } = useRoutedContext();
  const hashes = getPrimaryFile(version.files)?.hashes;

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
    { label: 'Base Model', value: version.baseModel },
    {
      label: 'Hash',
      value: !!hashes?.length && <ModelHash hashes={hashes} />,
      visible: !!hashes?.length,
    },
    { label: 'Steps', value: version.steps?.toLocaleString() ?? 0, visible: !!version.steps },
    { label: 'Epoch', value: version.epochs?.toLocaleString() ?? 0, visible: !!version.epochs },
    {
      label: 'Trigger Words',
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
      visible: !!version.files?.find((file) => (file.type as ModelFileType) === 'Training Data'),
    },
  ];

  const versionImages = version.images.map((x) => x.image);
  const imagesLimit = mobile ? VERSION_IMAGES_LIMIT / 2 : VERSION_IMAGES_LIMIT;
  const primaryFile = getPrimaryFile(version.files);
  const secondaryFiles = version.files.filter((file) => file != primaryFile);

  return (
    <Grid gutter="xl">
      <Grid.Col xs={12} md={4} orderMd={2}>
        <Stack spacing="xs">
          <Group spacing="xs" align="flex-start">
            <Stack spacing={4} style={{ flex: 1 }}>
              <MultiActionButton
                variant="light"
                component="a"
                href={createModelFileDownloadUrl({ versionId: version.id, primary: true })}
                disabled={!primaryFile}
                menuItems={secondaryFiles.map((file, index) => (
                  <Menu.Item
                    key={index}
                    component="a"
                    py={4}
                    icon={<VerifiedText file={file} iconOnly />}
                    href={createModelFileDownloadUrl({
                      versionId: version.id,
                      type: file.type,
                      format: file.format,
                    })}
                    download
                  >
                    {`${startCase(file.type)}${
                      ['Model', 'Pruned Model'].includes(file.type) ? ' ' + file.format : ''
                    } (${formatKBytes(file.sizeKB)})`}
                  </Menu.Item>
                ))}
                download
              >
                {`Download (${formatKBytes(primaryFile?.sizeKB ?? 0)})`}
              </MultiActionButton>
              {primaryFile && (
                <Group position="apart">
                  <VerifiedText file={primaryFile} />
                  <Text size="xs" color="dimmed">
                    {primaryFile.format}
                  </Text>
                </Group>
              )}
            </Stack>
            <RunButton modelVersionId={version.id} variant="light" />
          </Group>

          <DescriptionTable items={versionDetails} labelWidth="30%" />
          {version.description && (
            <>
              <Text size={16} weight={500}>
                About this version
              </Text>
              <ContentClamp>
                <RenderHtml html={version.description} />
              </ContentClamp>
            </>
          )}
        </Stack>
      </Grid.Col>
      <Grid.Col xs={12} md={8} orderMd={1}>
        <SFW type="model" id={modelId} nsfw={nsfw}>
          {({ nsfw, showNsfw }) => (
            <>
              {nsfw && !showNsfw && (
                <Card
                  p="md"
                  radius="sm"
                  withBorder
                  sx={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%,-50%)',
                    zIndex: 10,
                  }}
                >
                  <Stack>
                    <Text>This model has been marked NSFW</Text>
                    <SFW.Toggle>
                      <Button>Click to view</Button>
                    </SFW.Toggle>
                  </Stack>
                </Card>
              )}
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
                    nsfw={nsfw && !showNsfw}
                    radius="md"
                    aspectRatio={1}
                    onClick={() =>
                      openContext('modelVersionLightbox', {
                        initialSlide: index,
                        modelVersionId: version.id,
                      })
                    }
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
                      openContext('modelVersionLightbox', {
                        initialSlide: imagesLimit,
                        modelVersionId: version.id,
                      })
                    }
                    // disabled={nsfw && !showNsfw}
                  >
                    View more
                  </Button>
                ) : null}
              </SimpleGrid>
            </>
          )}
        </SFW>
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
