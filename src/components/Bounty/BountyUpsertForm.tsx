import {
  Alert,
  Button,
  Group,
  Stack,
  Text,
  Title,
  Tooltip,
  TooltipProps,
  SimpleGrid,
  Paper,
  ActionIcon,
  Progress,
  Divider,
  Input,
  Radio,
  createStyles,
  Anchor,
  List,
} from '@mantine/core';
import { BountyEntryMode, BountyMode, BountyType, Currency, TagTarget } from '@prisma/client';
import {
  IconCalendar,
  IconCalendarDue,
  IconExclamationMark,
  IconInfoCircle,
  IconTrash,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';

import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { BackButton, NavigateBack } from '~/components/BackButton/BackButton';
import { useFormStorage } from '~/hooks/useFormStorage';
import {
  Form,
  InputCheckbox,
  InputDatePicker,
  InputMultiFileUpload,
  InputNumber,
  InputRTE,
  InputRadioGroup,
  InputSegmentedControl,
  InputSelect,
  InputSwitch,
  InputTags,
  InputText,
  useForm,
  InputMultiSelect,
} from '~/libs/form';
import { upsertBountyInputSchema } from '~/server/schema/bounty.schema';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import dayjs from 'dayjs';
import { getDisplayName } from '~/utils/string-helpers';
import { constants, activeBaseModels } from '~/server/common/constants';
import { z } from 'zod';
import { getMinMaxDates, useMutateBounty } from './bounty.utils';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { numberWithCommas } from '~/utils/number-helpers';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useBuzzTransaction } from '../Buzz/buzz.utils';
import { DaysFromNow } from '../Dates/DaysFromNow';
import { dateWithoutTimezone, endOfDay, startOfDay } from '~/utils/date-helpers';
import { BountyGetById } from '~/types/router';
import { BaseFileSchema } from '~/server/schema/file.schema';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { FeatureIntroductionHelpButton } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { ContentPolicyLink } from '../ContentPolicyLink/ContentPolicyLink';
import { InfoPopover } from '../InfoPopover/InfoPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isDefined } from '~/utils/type-guards';

const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

const bountyModeDescription: Record<BountyMode, string> = {
  [BountyMode.Individual]:
    'Only you will be the supporter of this bounty. This is great if you are offering a good reward for a really specific resource that you want tailored for your specific needs. The number of entries might be limited if the reward you are offering is not enticing enough.',
  [BountyMode.Split]:
    'Other users can become a supporter in your bounty and select other entries to support. This is great for incentivizing a large number of people to contribute to submit entries to your bounty.',
};
const bountyEntryModeDescription: Record<BountyEntryMode, string> = {
  [BountyEntryMode.Open]:
    'Any user, at any time, can support an entry and gain access to its files.',
  [BountyEntryMode.BenefactorsOnly]:
    'Only people who become supporters in your bounty can support an entry and gain access to the files. Each supporter can only select 1 entry they support. So at best, each supporter will have access to 1 set of files.',
};

const formSchema = upsertBountyInputSchema
  .omit({ images: true })
  .refine((data) => !(data.nsfw && data.poi), {
    message: 'Mature content depicting actual people is not permitted.',
  })
  .refine((data) => data.startsAt < data.expiresAt, {
    message: 'Start date must be before expiration date',
    path: ['startsAt'],
  })
  .refine((data) => data.expiresAt > data.startsAt, {
    message: 'Expiration date must be after start date',
    path: ['expiresAt'],
  });

const useStyles = createStyles((theme) => ({
  radioItemWrapper: {
    '& .mantine-Group-root': {
      alignItems: 'stretch',
      [containerQuery.smallerThan('sm')]: {
        flexDirection: 'column',
      },
    },
  },

  radioItem: {
    border: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
    }`,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.xs,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.white,
    display: 'flex',
    flex: 1,

    '& > .mantine-Radio-body, & .mantine-Radio-label': {
      width: '100%',
    },

    '& > .mantine-Switch-body, & .mantine-Switch-labelWrapper, & .mantine-Switch-label': {
      width: '100%',
    },
  },

  root: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.white,
  },
  label: {
    textTransform: 'capitalize',
  },
  active: {
    border: `2px solid ${theme.colors.blue[5]}`,
    backgroundColor: 'transparent',
  },

  title: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: '24px',
    },
  },
  sectionTitle: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: '18px',
    },
  },
  fluid: {
    [containerQuery.smallerThan('sm')]: {
      maxWidth: '100% !important',
    },
  },
  stickySidebar: {
    position: 'sticky',
    top: `calc(var(--mantine-header-height) + ${theme.spacing.md}px)`,

    [containerQuery.smallerThan('md')]: {
      position: 'relative',
      top: 0,
    },
  },
}));

const lockableProperties = ['nsfw', 'poi'];

export function BountyUpsertForm({ bounty }: { bounty?: BountyGetById }) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { classes } = useStyles();

  const { files: imageFiles, uploadToCF, removeImage } = useCFImageUpload();
  const [bountyImages, setBountyImages] = useState<BountyGetById['images']>(bounty?.images ?? []);

  const handleDropImages = async (droppedFiles: File[]) => {
    for (const file of droppedFiles) {
      uploadToCF(file);
    }
  };

  const { minStartDate, maxStartDate, minExpiresDate, maxExpiresDate } = getMinMaxDates();

  const form = useForm({
    schema: formSchema,
    defaultValues: {
      ...bounty,
      name: bounty?.name ?? '',
      description: bounty?.description ?? '',
      tags: bounty?.tags ?? [],
      unitAmount: bounty?.benefactors[0].unitAmount ?? constants.bounties.minCreateAmount,
      currency: Currency.BUZZ,
      type: bounty?.type ?? BountyType.LoraCreation,
      mode: bounty?.mode ?? BountyMode.Individual,
      entryMode: bounty?.entryMode ?? BountyEntryMode.BenefactorsOnly,
      minBenefactorUnitAmount:
        bounty?.minBenefactorUnitAmount ?? constants.bounties.minCreateAmount,
      entryLimit: bounty?.entryLimit ?? 1,
      files: (bounty?.files as BaseFileSchema[]) ?? [],
      expiresAt: bounty
        ? dateWithoutTimezone(bounty.expiresAt)
        : dayjs().add(7, 'day').endOf('day').toDate(),
      startsAt: bounty ? dateWithoutTimezone(bounty.startsAt) : startOfDay(new Date()),
      details: bounty?.details ?? { baseModel: 'SD 1.5' },
      ownRights:
        !!bounty &&
        bounty.files.length > 0 &&
        bounty.files.every((f) => f.metadata?.ownRights === true),
      nsfw: bounty?.nsfw ?? false,
    },
    shouldUnregister: false,
  });

  const bountyEntryModeEnabled = false;
  const bountyModeEnabled = false;

  const clearStorage = useFormStorage({
    schema: formSchema,
    form,
    timeout: 1000,
    key: `bounty_new`,
    watch: ({ mode, name, type, currency, description, entryMode, unitAmount }) => ({
      mode,
      name,
      currency,
      description,
      entryMode,
      unitAmount,
      type,
    }),
  });
  const type = form.watch('type');
  const mode = form.watch('mode');
  const currency = form.watch('currency');
  const unitAmount = form.watch('unitAmount');
  const [nsfw, poi] = form.watch(['nsfw', 'poi']);
  const hasPoiInNsfw = nsfw && poi;
  const expiresAt = form.watch('expiresAt');
  const files = form.watch('files');

  const requireBaseModelSelection = [
    BountyType.ModelCreation,
    BountyType.LoraCreation,
    BountyType.EmbedCreation,
  ].some((t) => t === type);

  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to create this bounty. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    performTransactionOnPurchase: false,
    purchaseSuccessMessage: (purchasedBalance) => (
      <Stack>
        <Text>Thank you for your purchase!</Text>
        <Text>
          We have added <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasedBalance} /> to
          your account. You can now continue the bounty creation process.
        </Text>
      </Stack>
    ),
  });

  const { upsertBounty, upserting } = useMutateBounty({ bountyId: bounty?.id });

  const alreadyStarted = !!bounty && bounty.startsAt < new Date();
  const images = [...bountyImages, ...imageFiles];

  const handleSubmit = async (data: z.infer<typeof formSchema>) => {
    if (
      data.entryLimit &&
      bounty &&
      bounty._count.entries > 0 &&
      bounty.entryLimit > data.entryLimit
    ) {
      form.setError('entryLimit', {
        type: 'custom',
        message:
          'Bounty has already received entries. You can increase the entry limit but not decrease it.',
      });

      return;
    }

    const completedUploads = imageFiles.filter((file) => file.status === 'success');

    const filteredImages = bounty ? [...bountyImages, ...completedUploads] : completedUploads;

    const performTransaction = async () => {
      try {
        const result = await upsertBounty({
          ...bounty,
          ...data,
          images: filteredImages,
        });

        await router.push(`/bounties/${result?.id}`);

        clearStorage();
      } catch (error) {
        // Do nothing since the query event will show an error notification
      }
    };

    if (currency === Currency.BUZZ && !bounty) {
      conditionalPerformTransaction(data.unitAmount, performTransaction);
    } else {
      performTransaction();
    }
  };

  useEffect(() => {
    const subscription = form.watch((value, { name, type }) => {
      if (
        currentUser?.isModerator &&
        name &&
        lockableProperties.includes(name) &&
        !value.lockedProperties?.includes(name)
      ) {
        const locked = (value.lockedProperties ?? []).filter(isDefined);
        form.setValue('lockedProperties', [...locked, name]);
      }
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []); // eslint-disable-line

  function isLocked(key: string) {
    return !currentUser?.isModerator ? bounty?.lockedProperties?.includes(key) : false;
  }

  function isLockedDescription(key: string, defaultDescription?: string) {
    return bounty?.lockedProperties?.includes(key) ? 'Locked by moderator' : defaultDescription;
  }

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing={32}>
        <Group spacing="md" noWrap>
          <BackButton url="/bounties" />
          <Title className={classes.title}>
            {bounty ? `Editing ${bounty.name} bounty` : 'Create a new bounty'}
          </Title>
          <FeatureIntroductionHelpButton
            feature="bounty-create"
            contentSlug={['feature-introduction', 'bounty-create']}
          />
        </Group>
        {alreadyStarted && (
          <AlertWithIcon icon={<IconExclamationMark size={20} />} iconColor="blue" size="sm">
            Please note that some fields are not editable anymore because the bounty has already
            started or somebody submitted an entry to it.
          </AlertWithIcon>
        )}
        <ContainerGrid gutter="xl">
          <ContainerGrid.Col xs={12} md={8}>
            <Stack spacing={32}>
              <Stack spacing="xl">
                {!alreadyStarted && (
                  <>
                    <InputText
                      name="name"
                      label="Name"
                      placeholder="e.g.:LoRA for XYZ"
                      withAsterisk
                    />
                    <Group spacing="md" grow>
                      <InputSelect
                        className={classes.fluid}
                        name="type"
                        label={
                          <Group spacing={4} noWrap>
                            <Input.Label required>Type</Input.Label>
                            <InfoPopover type="hover" size="xs" iconProps={{ size: 14 }}>
                              <Text>
                                Not sure which type to choose? Learn more about bounties and their
                                types by reading our{' '}
                                <Anchor
                                  href="https://education.civitai.com/civitais-guide-to-bounties/"
                                  target="_blank"
                                  rel="nofollow noreferrer"
                                  span
                                >
                                  Bounty Guide
                                </Anchor>
                                .
                              </Text>
                            </InfoPopover>
                          </Group>
                        }
                        placeholder="Please select a bounty type"
                        data={Object.values(BountyType).map((value) => ({
                          value,
                          label: getDisplayName(value),
                        }))}
                        onChange={(value) => {
                          switch (value) {
                            case BountyType.ModelCreation:
                              form.setValue('details.baseModel', 'SD 1.5');
                              form.setValue('details.modelFormat', 'SafeTensor');
                              form.setValue('details.modelSize', 'full');
                              break;
                            case BountyType.LoraCreation:
                            case BountyType.EmbedCreation:
                              form.setValue('details.baseModel', 'SD 1.5');
                              form.setValue('details.modelFormat', undefined);
                              form.setValue('details.modelSize', undefined);
                              break;
                            default:
                              form.setValue('details', undefined);
                              break;
                          }
                        }}
                      />
                      {requireBaseModelSelection && (
                        <InputSelect
                          className={classes.fluid}
                          name="details.baseModel"
                          label="Base model"
                          placeholder="Please select a base model"
                          withAsterisk
                          data={[...activeBaseModels]}
                        />
                      )}
                    </Group>
                  </>
                )}
                <InputRTE
                  name="description"
                  label="About your bounty"
                  editorSize="xl"
                  includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
                  placeholder="What kind of entries are you looking for? Why did you make this? What's it for? Examples of the best case and worst case outputs from bounty entries"
                  withAsterisk
                  stickyToolbar
                />
                <Input.Wrapper
                  label="Example Images"
                  description="Please add at least 1 reference image to your bounty. This will serve as a reference point for Hunters and will also be used as your cover image."
                  descriptionProps={{ mb: 5 }}
                  withAsterisk
                >
                  <ImageDropzone
                    label="Drag & drop images here or click to browse"
                    onDrop={handleDropImages}
                    count={imageFiles.length}
                    accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
                  />
                </Input.Wrapper>
                {images.length > 0 && (
                  <SimpleGrid
                    spacing="sm"
                    breakpoints={[
                      { minWidth: 'xs', cols: 1 },
                      { minWidth: 'sm', cols: 3 },
                      {
                        minWidth: 'md',
                        cols: images.length > 3 ? 4 : images.length,
                      },
                    ]}
                  >
                    {bountyImages.map((image) => (
                      <Paper
                        key={image.id}
                        radius="sm"
                        p={0}
                        sx={{ position: 'relative', overflow: 'hidden', height: 332 }}
                        withBorder
                      >
                        <EdgeMedia
                          placeholder="empty"
                          src={image.url}
                          alt={undefined}
                          style={{ objectFit: 'cover', height: '100%' }}
                        />
                        <div style={{ position: 'absolute', top: 12, right: 12 }}>
                          <ActionIcon
                            variant="filled"
                            size="lg"
                            color="red"
                            onClick={() => {
                              setBountyImages((current) =>
                                current.filter((i) => i.id !== image.id)
                              );
                            }}
                          >
                            <IconTrash size={26} strokeWidth={2.5} />
                          </ActionIcon>
                        </div>
                        {image.meta && (
                          <div style={{ position: 'absolute', bottom: 12, right: 12 }}>
                            <ImageMetaPopover meta={image.meta}>
                              <ActionIcon variant="light" color="dark" size="lg">
                                <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
                              </ActionIcon>
                            </ImageMetaPopover>
                          </div>
                        )}
                      </Paper>
                    ))}
                    {imageFiles
                      .slice()
                      .reverse()
                      .map((file) => (
                        <Paper
                          key={file.url}
                          radius="sm"
                          p={0}
                          sx={{ position: 'relative', overflow: 'hidden', height: 332 }}
                          withBorder
                        >
                          {file.status === 'success' ? (
                            <>
                              <EdgeMedia
                                placeholder="empty"
                                src={file.url}
                                alt={file.name ?? undefined}
                                style={{ objectFit: 'cover', height: '100%' }}
                              />
                              <div style={{ position: 'absolute', top: 12, right: 12 }}>
                                <ActionIcon
                                  variant="filled"
                                  size="lg"
                                  color="red"
                                  onClick={() => removeImage(file.url)}
                                >
                                  <IconTrash size={26} strokeWidth={2.5} />
                                </ActionIcon>
                              </div>
                              {file.type === 'image' && (
                                <div style={{ position: 'absolute', bottom: 12, right: 12 }}>
                                  <ImageMetaPopover meta={file.meta}>
                                    <ActionIcon variant="light" color="dark" size="lg">
                                      <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
                                    </ActionIcon>
                                  </ImageMetaPopover>
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              <MediaHash {...file} />
                              <Progress
                                size="xl"
                                value={file.progress}
                                label={`${Math.floor(file.progress)}%`}
                                color={file.progress < 100 ? 'blue' : 'green'}
                                striped
                                animate
                              />
                            </>
                          )}
                        </Paper>
                      ))}
                  </SimpleGrid>
                )}
                {!alreadyStarted && (
                  <Stack>
                    <Group spacing="md" grow>
                      <InputDatePicker
                        className={classes.fluid}
                        name="startsAt"
                        label="Start Date"
                        placeholder="Select a start date"
                        icon={<IconCalendar size={16} />}
                        minDate={minStartDate}
                        maxDate={maxStartDate}
                        clearable={false}
                        withAsterisk
                      />
                      <InputDatePicker
                        className={classes.fluid}
                        name="expiresAt"
                        label="Deadline"
                        placeholder="Select an end date"
                        icon={<IconCalendarDue size={16} />}
                        minDate={minExpiresDate}
                        maxDate={maxExpiresDate}
                        dateParser={(dateString) => new Date(Date.parse(dateString))}
                        clearable={false}
                        withAsterisk
                      />
                    </Group>
                    {expiresAt && (
                      <Text weight={590}>
                        With the selected dates, your bounty will expire{' '}
                        <Text weight="bold" color="red.5" span>
                          <DaysFromNow date={endOfDay(expiresAt)} inUtc />
                        </Text>
                        . All times are in{' '}
                        <Text weight="bold" color="red.5" span>
                          UTC
                        </Text>
                        .
                      </Text>
                    )}
                  </Stack>
                )}

                <Stack spacing={4}>
                  <Divider label="Bounty rewards" />
                  <Text size="xs" color="dimmed">
                    Learn more about rewards and buzz system{' '}
                    <Anchor
                      href="https://education.civitai.com/civitais-guide-to-buzz"
                      target="_blank"
                      rel="nofollow noreferrer"
                      span
                    >
                      here
                    </Anchor>
                    .
                  </Text>
                </Stack>
                {!bounty ? (
                  <>
                    {bountyModeEnabled && (
                      <InputRadioGroup
                        name="mode"
                        label="Award Mode"
                        withAsterisk
                        className={classes.radioItemWrapper}
                      >
                        {Object.values(BountyMode).map((value) => (
                          <Radio
                            key={value}
                            className={classes.radioItem}
                            value={value}
                            label={
                              <RadioItem
                                label={getDisplayName(value)}
                                description={bountyModeDescription[value]}
                              />
                            }
                          />
                        ))}
                      </InputRadioGroup>
                    )}
                    <Group spacing="md" grow>
                      <InputNumber
                        className={classes.fluid}
                        name="unitAmount"
                        label="Bounty Amount"
                        placeholder="How much are you willing to reward for this bounty"
                        min={constants.bounties.minCreateAmount}
                        max={constants.bounties.maxCreateAmount}
                        step={100}
                        icon={<CurrencyIcon currency="BUZZ" size={16} />}
                        format={currency !== Currency.BUZZ ? 'currency' : undefined}
                        withAsterisk
                      />
                      <InputNumber
                        className={classes.fluid}
                        name="entryLimit"
                        label="Max entries per hunter"
                        placeholder="How many entries can a hunter submit to your bounty"
                        min={1}
                        max={100000}
                        withAsterisk
                      />
                      {mode === BountyMode.Split && (
                        <InputNumber
                          className={classes.fluid}
                          name="minBenefactorUnitAmount"
                          label="Minimum Benefactor Amount"
                          placeholder="How much does a supporter need to contribute to your bounty to become a supporter"
                          min={0}
                          max={unitAmount}
                          format={currency !== Currency.BUZZ ? 'currency' : undefined}
                        />
                      )}
                    </Group>
                  </>
                ) : (
                  <InputNumber
                    className={classes.fluid}
                    name="entryLimit"
                    label="Max entries per hunter"
                    placeholder="How many entries can a hunter submit to your bounty"
                    min={1}
                    max={100000}
                    withAsterisk
                  />
                )}
              </Stack>
              <Stack spacing="xl">
                {bountyEntryModeEnabled && (
                  <InputRadioGroup name="entryMode" label="Entry Mode" withAsterisk>
                    {Object.values(BountyEntryMode).map((value) => (
                      <Radio
                        key={value}
                        className={classes.radioItem}
                        value={value}
                        label={
                          <RadioItem
                            label={getDisplayName(value)}
                            description={bountyEntryModeDescription[value]}
                          />
                        }
                      />
                    ))}
                  </InputRadioGroup>
                )}
                <Divider label="Additional information" />
                <Alert>
                  If uploading a data set to your bounty you attest that the Images contained within
                  adhere to our{' '}
                  <Anchor href="/content/tos" target="_blank" rel="nofollow" span>
                    TOS
                  </Anchor>
                  .
                </Alert>
                <InputMultiFileUpload
                  name="files"
                  label="Attachments"
                  description="Include any supporting files that you would like to share with the participants. This could be a PDF with more information about your bounty, or a zip file with some sample data."
                  dropzoneProps={{
                    maxSize: 100 * 1024 ** 2, // 100MB
                    maxFiles: 10,
                    accept: {
                      'application/pdf': ['.pdf'],
                      'application/zip': ['.zip'],
                      'application/json': ['.json'],
                      'application/x-yaml': ['.yaml', '.yml'],
                      'text/plain': ['.txt'],
                    },
                  }}
                  renderItem={(file, onRemove) => (
                    <>
                      {file.url ? (
                        <Anchor
                          href={`/api/download/attachments/${file.url}`}
                          size="sm"
                          weight={500}
                          lineClamp={1}
                          download
                        >
                          {file.name}
                        </Anchor>
                      ) : (
                        <Text size="sm" weight={500} lineClamp={1}>
                          {file.name}
                        </Text>
                      )}
                      <Tooltip label="Remove">
                        <ActionIcon
                          size="sm"
                          color="red"
                          variant="transparent"
                          onClick={() => onRemove()}
                        >
                          <IconTrash />
                        </ActionIcon>
                      </Tooltip>
                    </>
                  )}
                />
                {files && files.length > 0 && (
                  <InputCheckbox name="ownRights" label="I own the rights to these files" />
                )}
              </Stack>
            </Stack>
          </ContainerGrid.Col>
          <ContainerGrid.Col xs={12} md={4}>
            <Stack className={classes.stickySidebar}>
              <Divider label="Properties" />
              {type === 'ModelCreation' && (
                <Stack spacing="xl">
                  <Input.Wrapper
                    className={classes.fluid}
                    label="Preferred model format"
                    labelProps={{ w: '100%' }}
                    withAsterisk
                  >
                    <InputSegmentedControl
                      classNames={classes}
                      name="details.modelFormat"
                      radius="sm"
                      data={[...constants.modelFileFormats]}
                      fullWidth
                      orientation="vertical"
                    />
                  </Input.Wrapper>
                  <Input.Wrapper
                    className={classes.fluid}
                    label="Preferred model size"
                    labelProps={{ w: '100%' }}
                    withAsterisk
                  >
                    <InputSegmentedControl
                      classNames={classes}
                      name="details.modelSize"
                      radius="sm"
                      data={[...constants.modelFileSizes]}
                      fullWidth
                    />
                  </Input.Wrapper>
                </Stack>
              )}
              <InputTags
                name="tags"
                label={
                  <Group spacing={4} noWrap>
                    <Input.Label>Tags</Input.Label>
                    <InfoPopover type="hover" size="xs" iconProps={{ size: 14 }}>
                      <Text>
                        Tags are how users filter content on the site. It&apos;s important to
                        correctly tag your content so it can be found by interested users
                      </Text>
                    </InfoPopover>
                  </Group>
                }
                target={[TagTarget.Bounty]}
              />
              <InputSwitch
                name="poi"
                disabled={isLocked('poi')}
                description={isLockedDescription('poi')}
                label={
                  <Stack spacing={4}>
                    <Group spacing={4}>
                      <Text inline>Depicts an actual person</Text>
                    </Group>
                    <Text size="xs" color="dimmed">
                      For example: Tom Cruise or Tom Cruise as Maverick
                    </Text>
                  </Stack>
                }
              />
              <InputSwitch
                disabled={isLocked('nsfw')}
                description={isLockedDescription('nsfw')}
                name="nsfw"
                label="Is intended to produce sexual themes"
              />

              {currentUser?.isModerator && (
                <Paper radius="md" p="xl" withBorder>
                  <InputMultiSelect
                    name="lockedProperties"
                    label="Locked properties"
                    data={lockableProperties}
                  />
                </Paper>
              )}
              {hasPoiInNsfw && (
                <AlertWithIcon color="red" pl={10} iconColor="red" icon={<IconExclamationMark />}>
                  <Text>
                    Mature content depicting actual people is not permitted. Please revise the
                    content of this listing to ensure no actual person is depicted in an mature
                    context out of respect for the individual.
                  </Text>
                </AlertWithIcon>
              )}
              <Text size="xs">
                Bounty requests MUST adhere to the content rules defined in our{' '}
                <Anchor href="/content/tos" target="_blank" rel="nofollow" span>
                  Terms of service
                </Anchor>
                .
              </Text>
              <List size="xs" spacing={8}>
                <List.Item>
                  For Bounty Example images, they should either be:
                  <List size="xs" spacing={4}>
                    <List.Item>AI Generated, or</List.Item>
                    <List.Item>Non-mature (SFW) if real people images.</List.Item>
                  </List>
                </List.Item>
                <List.Item>
                  Bounties cannot be used to farm reviews or image posts on your resources.
                </List.Item>
                <List.Item>
                  <ContentPolicyLink />
                </List.Item>
              </List>
            </Stack>
          </ContainerGrid.Col>
        </ContainerGrid>
        <Group position="right">
          <NavigateBack url="/bounties">
            {({ onClick }) => (
              <Button variant="light" color="gray" onClick={onClick}>
                Discard Changes
              </Button>
            )}
          </NavigateBack>
          {currency === Currency.BUZZ && !bounty ? (
            <BuzzTransactionButton
              loading={upserting}
              type="submit"
              disabled={hasPoiInNsfw}
              label="Save"
              buzzAmount={unitAmount}
              color="yellow.7"
            />
          ) : (
            <Button loading={upserting} type="submit" disabled={hasPoiInNsfw}>
              Save
            </Button>
          )}
        </Group>
      </Stack>
    </Form>
  );
}

type RadioItemProps = { label: string; description: string };
const RadioItem = ({ label, description }: RadioItemProps) => (
  <Stack spacing={4}>
    <Text inline>{label}</Text>
    <Text size="xs" color="dimmed">
      {description}
    </Text>
  </Stack>
);
