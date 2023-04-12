import {
  Accordion,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Grid,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { ModelStatus } from '@prisma/client';
import {
  IconChevronDown,
  IconDownload,
  IconHeart,
  IconLicense,
  IconMessageCircle2,
} from '@tabler/icons';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import { startCase } from 'lodash';
import { SessionUser } from 'next-auth';
import { useRouter } from 'next/router';
import { useRef } from 'react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { CivitiaLinkManageButton } from '~/components/CivitaiLink/CivitiaLinkManageButton';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { FileInfo } from '~/components/FileInfo/FileInfo';
import { JoinPopover } from '~/components/JoinPopover/JoinPopover';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { EarlyAccessAlert } from '~/components/Model/EarlyAccessAlert/EarlyAccessAlert';
import { HowToUseModel } from '~/components/Model/HowToUseModel/HowToUseModel';
import { ModelCarousel } from '~/components/Model/ModelCarousel/ModelCarousel';
import { ModelFileAlert } from '~/components/Model/ModelFileAlert/ModelFileAlert';
import { ModelHash } from '~/components/Model/ModelHash/ModelHash';
import { PermissionIndicator } from '~/components/PermissionIndicator/PermissionIndicator';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ResourceReviewSummary } from '~/components/ResourceReview/Summary/ResourceReviewSummary';
import { RunButton } from '~/components/RunStrategy/RunButton';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import { RoutedContextLink, openRoutedContext } from '~/providers/RoutedContextProvider';
import { CAROUSEL_LIMIT, ModelFileType } from '~/server/common/constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getPrimaryFile, getFileDisplayName } from '~/server/utils/model-helpers';
import { ModelById } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { formatKBytes } from '~/utils/number-helpers';
import { getDisplayName, removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function ModelVersionDetails({
  model,
  version,
  user,
  isFavorite,
  onFavoriteClick,
  onBrowseClick,
}: Props) {
  const { connected: civitaiLinked } = useCivitaiLink();
  const queryUtils = trpc.useContext();

  // TODO.manuel: use control ref to display the show more button
  const controlRef = useRef<HTMLButtonElement | null>(null);
  const [opened, { toggle }] = useDisclosure(false);

  const primaryFile = getPrimaryFile(version.files, {
    metadata: user?.filePreferences,
  });
  const hashes = primaryFile?.hashes ?? [];

  const displayCivitaiLink = civitaiLinked && version.hashes.length > 0;
  const hasPendingClaimReport = model.reportStats && model.reportStats.ownershipProcessing > 0;

  const publishVersionMutation = trpc.modelVersion.publish.useMutation();
  const publishModelMutation = trpc.model.publish.useMutation();
  const requestReviewMutation = trpc.model.requestReview.useMutation({
    async onSuccess() {
      await queryUtils.model.getById.invalidate({ id: model.id });
    },
  });

  const handlePublishClick = async () => {
    try {
      if (model.status !== ModelStatus.Published) {
        // Publish model, version and all of its posts
        const versionIds =
          model.status === ModelStatus.UnpublishedViolation && user?.isModerator
            ? model.modelVersions.map(({ id }) => id)
            : [version.id];
        await publishModelMutation.mutateAsync({ id: model.id, versionIds });
      } else {
        // Just publish the version and its posts
        await publishVersionMutation.mutateAsync({ id: version.id });
      }
    } catch (e) {
      const error = e as TRPCClientErrorBase<DefaultErrorShape>;
      showErrorNotification({
        error: new Error(error.message),
        title: 'Error publishing model',
        reason: 'Something went wrong while publishing your model. Please try again later.',
      });
    }

    await queryUtils.model.getById.invalidate({ id: model.id });
    await queryUtils.modelVersion.getById.invalidate({ id: version.id });
    await queryUtils.image.getInfinite.invalidate();
  };

  const modelDetails: DescriptionTableProps['items'] = [
    {
      label: 'Type',
      value: (
        <Group spacing={0} noWrap position="apart">
          <Badge radius="sm" px={5}>
            {getDisplayName(model.type)} {model.checkpointType}
          </Badge>
          {version.status !== ModelStatus.Published ? (
            <Badge color="yellow" radius="sm">
              {version.status}
            </Badge>
          ) : (
            <HowToUseModel type={model.type} />
          )}
        </Group>
      ),
    },
    {
      label: 'Downloads',
      value: (version.rank?.downloadCountAllTime ?? 0).toLocaleString(),
    },
    { label: 'Uploaded', value: formatDate(version.createdAt) },
    {
      label: 'Base Model',
      value: <Text>{version.baseModel}</Text>,
    },
    { label: 'Steps', value: version.steps?.toLocaleString() ?? 0, visible: !!version.steps },
    { label: 'Epoch', value: version.epochs?.toLocaleString() ?? 0, visible: !!version.epochs },
    {
      label: 'Trigger Words',
      visible: !!version.trainedWords?.length,
      value: (
        <TrainedWords trainedWords={version.trainedWords} files={version.files} type={model.type} />
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
    {
      label: 'Hash',
      value: <ModelHash hashes={hashes} />,
      visible: !!hashes.length,
    },
  ];

  const getFileDetails = (file: ModelById['modelVersions'][number]['files'][number]) => (
    <Group position="apart" noWrap spacing={0}>
      <VerifiedText file={file} />
      <Group spacing={4}>
        <Text size="xs" color="dimmed">
          {file.type === 'Pruned Model' ? 'Pruned ' : ''}
          {file.metadata.format}
        </Text>
        <FileInfo file={file} />
      </Group>
    </Group>
  );
  const primaryFileDetails = primaryFile && getFileDetails(primaryFile);

  const downloadMenuItems = version.files.map((file) => (
    <Menu.Item
      key={file.id}
      component="a"
      py={4}
      icon={<VerifiedText file={file} iconOnly />}
      href={createModelFileDownloadUrl({
        versionId: version.id,
        type: file.type,
        format: file.metadata.format,
      })}
      download
    >
      {`${startCase(file.type)}${
        ['Model', 'Pruned Model'].includes(file.type) ? ' ' + file.metadata.format : ''
      } (${formatKBytes(file.sizeKB)})`}
    </Menu.Item>
  ));
  const downloadFileItems = version.files.map((file) => (
    <Card
      key={file.id}
      radius={0}
      py="xs"
      sx={(theme) => ({
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
      })}
    >
      <Stack spacing={4}>
        <Group position="apart" noWrap>
          <Text size="xs" weight={500} lineClamp={2}>
            {getFileDisplayName({ file, modelType: model.type })} ({formatKBytes(file.sizeKB)})
          </Text>
          <Button
            component="a"
            variant="subtle"
            size="xs"
            href={createModelFileDownloadUrl({
              versionId: version.id,
              type: file.type,
              format: file.metadata.format,
            })}
            download
            compact
          >
            Download
          </Button>
        </Group>
        {getFileDetails(file)}
      </Stack>
    </Card>
  ));

  const cleanDescription = version.description ? removeTags(version.description) : '';

  const isOwner = model.user?.id === user?.id;
  const isOwnerOrMod = isOwner || user?.isModerator;
  const filesCount = version.files.length;
  const hasFiles = filesCount > 0;
  const hasPosts = !!version.posts?.length;
  const showPublishButton =
    isOwnerOrMod &&
    (version.status !== ModelStatus.Published || model.status !== ModelStatus.Published) &&
    hasFiles &&
    hasPosts;
  const publishing = publishModelMutation.isLoading || publishVersionMutation.isLoading;
  const showRequestReview =
    isOwner && !user?.isModerator && model.status === ModelStatus.UnpublishedViolation;
  const deleted = !!model.deletedAt && model.status === ModelStatus.Deleted;
  const showEditButton = isOwnerOrMod && !deleted && !showRequestReview;

  return (
    <Grid gutter="xl">
      <Grid.Col xs={12} md={4} orderMd={2}>
        <Stack>
          <ModelCarousel
            modelId={model.id}
            nsfw={model.nsfw}
            modelVersionId={version.id}
            modelUserId={model.user.id}
            limit={CAROUSEL_LIMIT}
            mobile
          />
          {showRequestReview ? (
            <Button
              color="yellow"
              onClick={() => requestReviewMutation.mutate({ id: model.id })}
              loading={requestReviewMutation.isLoading}
              fullWidth
            >
              Request a Review
            </Button>
          ) : showPublishButton ? (
            <Button color="green" onClick={handlePublishClick} loading={publishing} fullWidth>
              Publish this version
            </Button>
          ) : (
            <Group spacing="xs" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              {version.canDownload ? (
                displayCivitaiLink ? (
                  <Stack sx={{ flex: 1 }} spacing={4}>
                    <CivitiaLinkManageButton
                      modelId={model.id}
                      modelVersionId={version.id}
                      modelName={model.name}
                      modelType={model.type}
                      hashes={version.hashes}
                      noTooltip
                    >
                      {({ color, onClick, ref, icon, label }) => (
                        <Button
                          ref={ref}
                          color={color}
                          onClick={onClick}
                          leftIcon={icon}
                          disabled={!primaryFile}
                        >
                          {label}
                        </Button>
                      )}
                    </CivitiaLinkManageButton>
                    {primaryFileDetails}
                  </Stack>
                ) : (
                  <Stack sx={{ flex: 1 }} spacing={4}>
                    <Button
                      component="a"
                      href={createModelFileDownloadUrl({
                        versionId: version.id,
                        primary: true,
                      })}
                      leftIcon={<IconDownload size={16} />}
                      disabled={!primaryFile}
                      download
                    >
                      <Text align="center">
                        {primaryFile ? `Download (${formatKBytes(primaryFile.sizeKB)})` : 'No file'}
                      </Text>
                    </Button>
                    {primaryFileDetails}
                  </Stack>
                )
              ) : (
                <Stack sx={{ flex: 1 }} spacing={4}>
                  <JoinPopover>
                    <Button leftIcon={<IconDownload size={16} />}>
                      <Text align="center">
                        {`Download (${formatKBytes(primaryFile?.sizeKB ?? 0)})`}
                      </Text>
                    </Button>
                  </JoinPopover>
                  {primaryFileDetails}
                </Stack>
              )}
              {displayCivitaiLink ? (
                version.canDownload ? (
                  <Menu position="bottom-end">
                    <Menu.Target>
                      <Tooltip label="Download options" withArrow>
                        <Button px={0} w={36} variant="light">
                          <IconDownload />
                        </Button>
                      </Tooltip>
                    </Menu.Target>
                    <Menu.Dropdown>{downloadMenuItems}</Menu.Dropdown>
                  </Menu>
                ) : (
                  <JoinPopover>
                    <Tooltip label="Download options" withArrow>
                      <Button px={0} w={36} variant="light">
                        <IconDownload />
                      </Button>
                    </Tooltip>
                  </JoinPopover>
                )
              ) : (
                <RunButton modelVersionId={version.id} />
              )}
              <Tooltip label={isFavorite ? 'Unlike' : 'Like'} position="top" withArrow>
                <div>
                  <LoginRedirect reason="favorite-model">
                    <Button
                      onClick={onFavoriteClick}
                      color={isFavorite ? 'red' : 'gray'}
                      sx={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px' }}
                    >
                      <IconHeart color="#fff" />
                    </Button>
                  </LoginRedirect>
                </div>
              </Tooltip>
            </Group>
          )}
          <EarlyAccessAlert
            versionId={version.id}
            modelType={model.type}
            deadline={version.earlyAccessDeadline}
          />
          <ModelFileAlert versionId={version.id} modelType={model.type} files={version.files} />
          <Accordion
            variant="separated"
            multiple
            defaultValue={['version-details']}
            styles={(theme) => ({
              content: { padding: 0 },
              item: {
                overflow: 'hidden',
                borderColor:
                  theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
                boxShadow: theme.shadows.sm,
              },
              control: {
                padding: theme.spacing.sm,
              },
            })}
          >
            <Accordion.Item value="version-details">
              <Accordion.Control>
                <Group position="apart">
                  Details
                  {showEditButton && (
                    <Menu withinPortal>
                      <Menu.Target>
                        <Anchor size="sm" onClick={(e) => e.stopPropagation()}>
                          Edit
                        </Anchor>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          onClick={async (e) => {
                            e.stopPropagation();
                            await openRoutedContext('modelEdit', { modelId: model.id });
                          }}
                        >
                          Edit Model Details
                        </Menu.Item>
                        <Menu.Item
                          onClick={async (e) => {
                            e.stopPropagation();
                            await openRoutedContext('modelVersionEdit', {
                              modelVersionId: version.id,
                            });
                          }}
                        >
                          Edit Version Details
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  )}
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <DescriptionTable
                  items={modelDetails}
                  labelWidth="30%"
                  withBorder
                  paperProps={{
                    sx: {
                      borderLeft: 0,
                      borderRight: 0,
                      borderBottom: 0,
                    },
                    radius: 0,
                  }}
                />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item
              value="version-files"
              sx={(theme) => ({
                margin: `${theme.spacing.md}px 0`,
                borderColor: !filesCount ? `${theme.colors.red[4]} !important` : undefined,
              })}
            >
              <Accordion.Control>
                <Group position="apart">
                  {filesCount ? `${filesCount === 1 ? '1 File' : `${filesCount} Files`}` : 'Files'}
                  {isOwnerOrMod && (
                    <RoutedContextLink
                      modal="filesEdit"
                      modelVersionId={version.id}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Text variant="link" size="sm">
                        Manage Files
                      </Text>
                    </RoutedContextLink>
                  )}
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack spacing={2}>
                  {hasFiles ? (
                    downloadFileItems
                  ) : (
                    <Center p="xl">
                      <Text size="md" color="dimmed">
                        This version is missing files
                      </Text>
                    </Center>
                  )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
            {!model.locked && (
              <ResourceReviewSummary modelId={model.id} modelVersionId={version.id}>
                <Accordion.Item value="resource-reviews">
                  <Accordion.Control>
                    <Group position="apart">
                      <ResourceReviewSummary.Header
                        rating={version.rank?.ratingAllTime}
                        count={version.rank?.ratingCountAllTime}
                      />
                      <Text
                        component={NextLink}
                        href={`/models/${model.id}/reviews?modelVersionId=${version.id}`}
                        variant="link"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        See Reviews
                      </Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel px="sm" pb="sm">
                    <ResourceReviewSummary.Totals />
                  </Accordion.Panel>
                </Accordion.Item>
              </ResourceReviewSummary>
            )}
            {version.description && (
              <Accordion.Item value="version-description">
                <Accordion.Control>{`About this version`}</Accordion.Control>
                <Accordion.Panel px="sm" pb="sm">
                  <Stack spacing={4}>
                    {version.description && (
                      <Box sx={{ p: { fontSize: 14, marginBottom: 10 } }}>
                        <ContentClamp
                          maxHeight={200}
                          controlRef={controlRef}
                          styles={{ control: { display: 'none' } }}
                        >
                          <RenderHtml html={version.description} />
                        </ContentClamp>
                      </Box>
                    )}
                    {cleanDescription.length > 150 ? (
                      <Text
                        variant="link"
                        size="xs"
                        onClick={toggle}
                        tabIndex={0}
                        sx={{ cursor: 'pointer' }}
                      >
                        Show more
                      </Text>
                    ) : null}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            )}
          </Accordion>
          <CreatorCard user={model.user} />

          <Group position="apart" align="flex-start" style={{ flexWrap: 'nowrap' }}>
            {model.type === 'Checkpoint' && (
              <Group spacing={4} noWrap style={{ flex: 1, overflow: 'hidden' }} align="flex-start">
                <IconLicense size={16} />
                <Text
                  size="xs"
                  color="dimmed"
                  sx={{
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    lineHeight: 1.1,
                  }}
                >
                  License{model.licenses.length > 0 ? 's' : ''}:
                </Text>
                <Stack spacing={0}>
                  <Text
                    component="a"
                    href="https://huggingface.co/spaces/CompVis/stable-diffusion-license"
                    rel="nofollow"
                    td="underline"
                    target="_blank"
                    size="xs"
                    color="dimmed"
                    sx={{ lineHeight: 1.1 }}
                  >
                    creativeml-openrail-m
                  </Text>
                  {model.licenses.map(({ url, name }) => (
                    <Text
                      key={name}
                      component="a"
                      rel="nofollow"
                      href={url}
                      td="underline"
                      size="xs"
                      color="dimmed"
                      target="_blank"
                      sx={{ lineHeight: 1.1 }}
                    >
                      {name}
                    </Text>
                  ))}
                </Stack>
              </Group>
            )}
            <PermissionIndicator spacing={5} size={28} permissions={model} ml="auto" />
          </Group>
          {hasPendingClaimReport && (
            <AlertWithIcon icon={<IconMessageCircle2 />}>
              {`A verified artist believes this model was fine-tuned on their art. We're discussing this with the model creator and artist`}
            </AlertWithIcon>
          )}
        </Stack>
      </Grid.Col>

      <Grid.Col
        xs={12}
        md={8}
        orderMd={1}
        sx={(theme) => ({
          [theme.fn.largerThan('xs')]: {
            padding: `0 ${theme.spacing.sm}px`,
            margin: `${theme.spacing.sm}px 0`,
          },
        })}
      >
        <Stack>
          <ModelCarousel
            modelId={model.id}
            nsfw={model.nsfw}
            modelVersionId={version.id}
            modelUserId={model.user.id}
            limit={CAROUSEL_LIMIT}
            onBrowseClick={onBrowseClick}
          />
          {model.description ? (
            <ContentClamp maxHeight={300}>
              <RenderHtml html={model.description} withMentions />
            </ContentClamp>
          ) : null}
        </Stack>
      </Grid.Col>
      {version.description && (
        <Modal
          opened={opened}
          title="About this version"
          overflow="inside"
          onClose={toggle}
          size="lg"
          centered
        >
          <RenderHtml html={version.description} />
        </Modal>
      )}
    </Grid>
  );
}

type Props = {
  version: ModelById['modelVersions'][number];
  model: ModelById;
  onFavoriteClick: VoidFunction;
  user?: SessionUser | null;
  isFavorite?: boolean;
  onBrowseClick?: VoidFunction;
};
