import {
  Badge,
  Button,
  Grid,
  Group,
  Menu,
  Modal,
  Rating,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { ModelStatus } from '@prisma/client';
import { IconDownload, IconLicense, IconMessageCircle2 } from '@tabler/icons';
import { startCase } from 'lodash';
import { SessionUser } from 'next-auth';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { CivitiaLinkManageButton } from '~/components/CivitaiLink/CivitiaLinkManageButton';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { JoinPopover } from '~/components/JoinPopover/JoinPopover';
import { EarlyAccessAlert } from '~/components/Model/EarlyAccessAlert/EarlyAccessAlert';
import { HowToUseModel } from '~/components/Model/HowToUseModel/HowToUseModel';
import { ModelCarousel } from '~/components/Model/ModelCarousel/ModelCarousel';
import { ModelFileAlert } from '~/components/Model/ModelFileAlert/ModelFileAlert';
import { ModelHash } from '~/components/Model/ModelHash/ModelHash';
import { MultiActionButton } from '~/components/MultiActionButton/MultiActionButton';
import { PermissionIndicator } from '~/components/PermissionIndicator/PermissionIndicator';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { RunButton } from '~/components/RunStrategy/RunButton';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import { ModelFileType } from '~/server/common/constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { ModelById } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { removeTags, splitUppercase } from '~/utils/string-helpers';

export function ModelVersionDetails({ model, version, user }: Props) {
  const { connected: civitaiLinked } = useCivitaiLink();

  const [opened, { toggle }] = useDisclosure(false);

  const primaryFile = getPrimaryFile(version.files, {
    metadata: user?.filePreferences,
  });
  const hashes = primaryFile?.hashes ?? [];

  const displayCivitaiLink = civitaiLinked && version.hashes.length > 0;
  const hasPendingClaimReport = model.reportStats && model.reportStats.ownershipProcessing > 0;

  const modelDetails: DescriptionTableProps['items'] = [
    {
      label: 'Type',
      value: (
        <Group spacing={0} noWrap position="apart">
          <Badge radius="sm" px={5}>
            {splitUppercase(model.type)} {model.checkpointType}
          </Badge>
          {model?.status !== ModelStatus.Published ? (
            <Badge color="yellow" radius="sm">
              {model.status}
            </Badge>
          ) : (
            <HowToUseModel type={model.type} />
          )}
        </Group>
      ),
    },

    {
      label: 'Rating',
      value: (
        <Group spacing={4}>
          <Rating value={version.rank?.ratingAllTime ?? 0} fractions={4} readOnly />
          <Text size="sm">({version.rank?.ratingCountAllTime.toLocaleString() ?? 0})</Text>
        </Group>
      ),
      visible: !model.locked,
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

  const primaryFileDetails = primaryFile && (
    <Group position="apart" noWrap spacing={0}>
      <VerifiedText file={primaryFile} />
      <Text size="xs" color="dimmed">
        {primaryFile.type === 'Pruned Model' ? 'Pruned ' : ''}
        {primaryFile.metadata.format}
      </Text>
    </Group>
  );

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

  const cleanDescription = version.description ? removeTags(version.description) : '';

  return (
    <Grid gutter="xl" mt="xs">
      <Grid.Col xs={12} md={4} orderMd={2}>
        <Stack>
          <ModelCarousel
            modelId={model.id}
            nsfw={model.nsfw}
            modelVersionId={version.id}
            images={version.images}
            mobile
          />
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
                  <MultiActionButton
                    component="a"
                    href={createModelFileDownloadUrl({
                      versionId: version.id,
                      primary: true,
                    })}
                    leftIcon={<IconDownload size={16} />}
                    disabled={!primaryFile}
                    menuItems={downloadMenuItems.length > 1 ? downloadMenuItems : []}
                    menuTooltip="Other Downloads"
                    download
                  >
                    <Text align="center">
                      {`Download (${formatKBytes(primaryFile?.sizeKB ?? 0)})`}
                    </Text>
                  </MultiActionButton>
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
          </Group>
          <EarlyAccessAlert
            versionId={version.id}
            modelType={model.type}
            deadline={version.earlyAccessDeadline}
          />
          <ModelFileAlert versionId={version.id} modelType={model.type} files={version.files} />
          <DescriptionTable items={modelDetails} labelWidth="30%" />
          <CreatorCard user={model.user} />

          <Group position="apart" align="flex-start" style={{ flexWrap: 'nowrap' }}>
            {model?.type === 'Checkpoint' && (
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
                  License{model?.licenses.length > 0 ? 's' : ''}:
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
                  {model?.licenses.map(({ url, name }) => (
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
          {version.description && (
            <Stack spacing={0}>
              <Text size="lg" weight={500}>
                About this version
              </Text>
              <Group spacing={4}>
                <Text lineClamp={3}>{cleanDescription}</Text>
                {cleanDescription.length > 150 ? (
                  <Button variant="subtle" size="xs" onClick={toggle} compact>
                    Show more
                  </Button>
                ) : null}
              </Group>
            </Stack>
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
        <ModelCarousel
          modelId={model.id}
          nsfw={model.nsfw}
          modelVersionId={version.id}
          images={version.images}
        />
      </Grid.Col>
      {version.description && (
        <Modal
          opened={opened}
          title="About this version"
          overflow="inside"
          onClose={toggle}
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
  user?: SessionUser | null;
};
