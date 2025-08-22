import {
  Alert,
  Anchor,
  Button,
  Divider,
  Group,
  Input,
  List,
  Paper,
  Progress,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconCalendar,
  IconCalendarDue,
  IconExclamationMark,
  IconInfoCircle,
  IconTrash,
} from '@tabler/icons-react';
import dayjs from '~/shared/utils/dayjs';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';
import * as z from 'zod';
import { BackButton, NavigateBack } from '~/components/BackButton/BackButton';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';

import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { FeatureIntroductionHelpButton } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFormStorage } from '~/hooks/useFormStorage';
import {
  Form,
  InputCheckbox,
  InputDatePicker,
  InputMultiFileUpload,
  InputMultiSelect,
  InputNumber,
  InputRadioGroup,
  InputRTE,
  InputSegmentedControl,
  InputSelect,
  InputSwitch,
  InputTags,
  InputText,
  useForm,
} from '~/libs/form';
import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { upsertBountyInputSchema } from '~/server/schema/bounty.schema';
import type { BaseFileSchema } from '~/server/schema/file.schema';
import {
  BountyEntryMode,
  BountyMode,
  BountyType,
  Currency,
  TagTarget,
} from '~/shared/utils/prisma/enums';
import type { BountyGetById } from '~/types/router';
import { dateWithoutTimezone, stripTime } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { useBuzzTransaction } from '../Buzz/buzz.utils';
import { ContentPolicyLink } from '../ContentPolicyLink/ContentPolicyLink';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import { DaysFromNow } from '../Dates/DaysFromNow';
import { InfoPopover } from '../InfoPopover/InfoPopover';
import { getMinMaxDates, useMutateBounty } from './bounty.utils';
import { ReadOnlyAlert } from '~/components/ReadOnlyAlert/ReadOnlyAlert';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import classes from './BountyUpsertForm.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { stringToDate } from '~/utils/zod-helpers';
import { activeBaseModels } from '~/shared/constants/base-model.constants';

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
  .extend({
    startsAt: stringToDate(
      z.date().min(dayjs().startOf('day').toDate(), 'Start date must be in the future')
    ),
    expiresAt: stringToDate(
      z
        .date()
        .min(dayjs().add(1, 'day').startOf('day').toDate(), 'Expiration date must be in the future')
    ),
  })
  .refine((data) => data.poi !== true, {
    error: 'The creation of bounties intended to depict an actual person is prohibited',
    path: ['poi'],
  })
  .refine((data) => !(data.nsfw && data.poi), {
    error: 'Mature content depicting actual people is not permitted.',
    path: ['nsfw'],
  })
  .refine((data) => data.startsAt < data.expiresAt, {
    error: 'Start date must be before expiration date',
    path: ['startsAt'],
  })
  .refine((data) => data.expiresAt > data.startsAt, {
    error: 'Expiration date must be after start date',
    path: ['expiresAt'],
  });

const lockableProperties = ['nsfw', 'poi'];

export function BountyUpsertForm({ bounty }: { bounty?: BountyGetById }) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const features = useFeatureFlags();

  const { files: imageFiles, uploadToCF, removeImage } = useCFImageUpload();
  const [bountyImages, setBountyImages] = useState<BountyGetById['images']>(bounty?.images ?? []);
  const [imagesError, setImagesError] = useState('');

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
        : dayjs().add(7, 'day').startOf('day').toDate(),
      startsAt: bounty ? dateWithoutTimezone(bounty.startsAt) : dayjs().startOf('day').toDate(),
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
      )}. Buy or earn more Buzz to perform this action.`,
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
    setImagesError('');

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
    const { startsAt, expiresAt, ...rest } = data;

    if (filteredImages.length === 0) {
      return setImagesError('At least one example image must be uploaded');
    }

    const performTransaction = async () => {
      try {
        const result = await upsertBounty({
          ...bounty,
          ...rest,
          startsAt: stripTime(startsAt),
          expiresAt: stripTime(expiresAt),
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
    const subscription = form.watch((value, { name }) => {
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
      <ReadOnlyAlert
        message={
          "Civitai is currently in read-only mode and you won't be able to publish or see changes made to this bounty."
        }
      />
      <Stack gap={32}>
        <Group gap="md" wrap="nowrap">
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
        <ContainerGrid2 gutter="xl">
          <ContainerGrid2.Col span={{ base: 12, sm: 8 }}>
            <Stack gap={32}>
              <Stack gap="xl">
                {!alreadyStarted && (
                  <>
                    <InputText
                      name="name"
                      label="Name"
                      placeholder="e.g.:LoRA for XYZ"
                      withAsterisk
                    />
                    <Group gap="md" grow>
                      <InputSelect
                        className={classes.fluid}
                        name="type"
                        label={
                          <Group gap={4} wrap="nowrap">
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
                  error={imagesError}
                  classNames={{ error: 'mt-1.5' }}
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
                    cols={{
                      base: 1,
                      sm: 3,
                      md: images.length > 3 ? 4 : images.length,
                    }}
                  >
                    {bountyImages.map((image) => (
                      <Paper
                        key={image.id}
                        radius="sm"
                        p={0}
                        style={{ position: 'relative', overflow: 'hidden', height: 332 }}
                        withBorder
                      >
                        <EdgeMedia
                          placeholder="empty"
                          src={image.url}
                          alt={undefined}
                          style={{ objectFit: 'cover', height: '100%' }}
                        />
                        <div style={{ position: 'absolute', top: 12, right: 12 }}>
                          <LegacyActionIcon
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
                          </LegacyActionIcon>
                        </div>
                        {image.meta && (
                          <div style={{ position: 'absolute', bottom: 12, right: 12 }}>
                            <ImageMetaPopover meta={image.meta}>
                              <LegacyActionIcon variant="light" color="dark" size="lg">
                                <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
                              </LegacyActionIcon>
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
                          style={{ position: 'relative', overflow: 'hidden', height: 332 }}
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
                                <LegacyActionIcon
                                  variant="filled"
                                  size="lg"
                                  color="red"
                                  onClick={() => removeImage(file.url)}
                                >
                                  <IconTrash size={26} strokeWidth={2.5} />
                                </LegacyActionIcon>
                              </div>
                              {file.type === 'image' && (
                                <div style={{ position: 'absolute', bottom: 12, right: 12 }}>
                                  <ImageMetaPopover meta={file.meta}>
                                    <LegacyActionIcon variant="light" color="dark" size="lg">
                                      <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
                                    </LegacyActionIcon>
                                  </ImageMetaPopover>
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              <MediaHash {...file} />
                              <Progress.Root size="xl">
                                <Progress.Section
                                  value={file.progress}
                                  color={file.progress < 100 ? 'blue' : 'green'}
                                  striped
                                  animated
                                >
                                  <Progress.Label>{Math.floor(file.progress)}%</Progress.Label>
                                </Progress.Section>
                              </Progress.Root>
                            </>
                          )}
                        </Paper>
                      ))}
                  </SimpleGrid>
                )}
                {!alreadyStarted && (
                  <Stack>
                    <Group gap="md" grow>
                      <InputDatePicker
                        className={classes.fluid}
                        name="startsAt"
                        label="Start Date"
                        placeholder="Select a start date"
                        leftSection={<IconCalendar size={16} />}
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
                        leftSection={<IconCalendarDue size={16} />}
                        minDate={minExpiresDate}
                        maxDate={maxExpiresDate}
                        // dateParser={(dateString) => new Date(Date.parse(dateString))}
                        clearable={false}
                        withAsterisk
                      />
                    </Group>
                    {expiresAt && (
                      <Text fw={590}>
                        With the selected dates, your bounty will expire{' '}
                        <Text fw="bold" c="red.5" span>
                          <DaysFromNow date={stripTime(expiresAt)} inUtc />
                        </Text>
                        . All times are in{' '}
                        <Text fw="bold" c="red.5" span>
                          UTC
                        </Text>
                        .
                      </Text>
                    )}
                  </Stack>
                )}

                <Stack gap={4}>
                  <Divider label="Bounty rewards" />
                  <Text size="xs" c="dimmed">
                    Learn more about the rewards and Buzz system{' '}
                    <Anchor
                      href="https://education.civitai.com/civitais-guide-to-on-site-currency-buzz-%e2%9a%a1/"
                      target="_blank"
                      rel="nofollow noreferrer"
                      span
                      inherit
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
                    <Group gap="md" grow>
                      <InputNumber
                        className={classes.fluid}
                        name="unitAmount"
                        label="Bounty Amount"
                        placeholder="How much are you willing to reward for this bounty"
                        min={constants.bounties.minCreateAmount}
                        max={constants.bounties.maxCreateAmount}
                        step={100}
                        leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                        format={currency !== Currency.BUZZ ? 'currency' : undefined}
                        withAsterisk
                      />
                      <InputNumber
                        className={classes.fluid}
                        name="entryLimit"
                        label="Max entries per hunter"
                        placeholder="How many entries can a hunter submit to your bounty"
                        min={1}
                        max={200}
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
              <Stack gap="xl">
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
                  <Anchor href="/content/tos" target="_blank" rel="nofollow" span inherit>
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
                          fw={500}
                          lineClamp={1}
                          download
                        >
                          {file.name}
                        </Anchor>
                      ) : (
                        <Text size="sm" fw={500} lineClamp={1}>
                          {file.name}
                        </Text>
                      )}
                      <Tooltip label="Remove">
                        <LegacyActionIcon
                          size="sm"
                          color="red"
                          variant="transparent"
                          onClick={() => onRemove()}
                        >
                          <IconTrash />
                        </LegacyActionIcon>
                      </Tooltip>
                    </>
                  )}
                />
                {files && files.length > 0 && (
                  <InputCheckbox name="ownRights" label="I own the rights to these files" />
                )}
              </Stack>
            </Stack>
          </ContainerGrid2.Col>
          <ContainerGrid2.Col span={{ base: 12, sm: 4 }}>
            <Stack className={classes.stickySidebar}>
              <Divider label="Properties" />
              {type === 'ModelCreation' && (
                <Stack gap="xl">
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
                  <Group gap={4} wrap="nowrap">
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
                  <Stack gap={4}>
                    <Group gap={4}>
                      <Text inline>Depicts an actual person</Text>
                    </Group>
                    <Text size="xs" c="dimmed">
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
                <Paper radius="md" p="lg" withBorder>
                  <InputMultiSelect
                    name="lockedProperties"
                    label="Locked properties"
                    data={lockableProperties}
                  />
                </Paper>
              )}
              {poi && (
                <AlertWithIcon color="red" pl={10} iconColor="red" icon={<IconExclamationMark />}>
                  <Text>
                    {hasPoiInNsfw
                      ? 'Mature content depicting actual people is not permitted. Please revise the content of this listing to ensure no actual person is depicted in an mature context out of respect for the individual.'
                      : 'The creation of bounties intended to depict an actual person is prohibited. Please revise the content of this listing to ensure no actual person is depicted out of respect for the individual.'}
                  </Text>
                </AlertWithIcon>
              )}
              <Text size="xs">
                Bounty requests MUST adhere to the content rules defined in our{' '}
                <Anchor href="/content/tos" target="_blank" rel="nofollow" span inherit>
                  Terms of service
                </Anchor>
                .<br />
                Illegal or exploitative content will be removed and reported.
              </Text>
              <List size="xs" spacing={8}>
                <List.Item>
                  <b>Real People Images</b>: Images of real people are not permitted.
                </List.Item>
                <List.Item>
                  <b>AI-Generated Images</b>: Only AI-generated images are allowed.
                </List.Item>
                <List.Item>
                  <b>Review Farming</b>: Bounties cannot be used to solicit reviews or encourage
                  image posts on your resources.
                </List.Item>
                <List.Item>
                  <ContentPolicyLink inherit />
                </List.Item>
              </List>
            </Stack>
          </ContainerGrid2.Col>
        </ContainerGrid2>
        <Group justify="flex-end">
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
              disabled={poi || hasPoiInNsfw || !features.canWrite}
              label="Save"
              buzzAmount={unitAmount}
              color="yellow.7"
            />
          ) : (
            <Button
              loading={upserting}
              type="submit"
              disabled={poi || hasPoiInNsfw || !features.canWrite}
            >
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
  <Stack gap={4}>
    <Text inline>{label}</Text>
    <Text size="xs" c="dimmed">
      {description}
    </Text>
  </Stack>
);
