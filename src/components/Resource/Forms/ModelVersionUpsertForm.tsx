import { Divider, Group, Input, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { useEffect, useMemo } from 'react';
import { z } from 'zod';

import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import {
  Form,
  InputMultiSelect,
  InputNumber,
  InputRTE,
  InputSegmentedControl,
  InputSelect,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  constants,
  modelVersionMonetizationTypeOptions,
  modelVersionSponsorshipSettingsTypeOptions,
} from '~/server/common/constants';
import {
  ModelVersionUpsertInput,
  modelVersionUpsertSchema2,
} from '~/server/schema/model-version.schema';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import { isEarlyAccess } from '~/server/utils/early-access-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { IconCash, IconCurrency, IconInfoCircle } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ModelVersionMonetizationType } from '@prisma/client';

const schema = modelVersionUpsertSchema2
  .extend({
    skipTrainedWords: z.boolean().default(false),
    earlyAccessTimeFrame: z
      .string()
      .refine((value) => ['0', '1', '2', '3', '4', '5'].includes(value), {
        message: 'Invalid value',
      }),
  })
  .refine((data) => (!data.skipTrainedWords ? data.trainedWords.length > 0 : true), {
    message: 'You need to specify at least one trained word',
    path: ['trainedWords'],
  });
type Schema = z.infer<typeof schema>;

const baseModelTypeOptions = constants.baseModelTypes.map((x) => ({ label: x, value: x }));

export function ModelVersionUpsertForm({ model, version, children, onSubmit }: Props) {
  const features = useFeatureFlags();
  const queryUtils = trpc.useContext();

  const acceptsTrainedWords = [
    'Checkpoint',
    'TextualInversion',
    'LORA',
    'LoCon',
    'Wildcards',
  ].includes(model?.type ?? '');
  const isTextualInversion = model?.type === 'TextualInversion';
  const hasBaseModelType = ['Checkpoint'].includes(model?.type ?? '');
  const hasVAE = ['Checkpoint'].includes(model?.type ?? '');

  // Get VAE options
  const { data: vaes } = trpc.modelVersion.getModelVersionsByModelType.useQuery(
    { type: 'VAE' },
    {
      cacheTime: 60 * 1000,
      enabled: hasVAE,
    }
  );
  const vaeOptions = useMemo(() => {
    if (!vaes) return [];
    return vaes.map((x) => ({ label: x.modelName, value: x.id }));
  }, [vaes]);

  const defaultValues: Schema = {
    ...version,
    name: version?.name ?? 'v1.0',
    baseModel: version?.baseModel ?? 'SD 1.5',
    baseModelType: hasBaseModelType ? version?.baseModelType ?? 'Standard' : undefined,
    vaeId: hasVAE ? version?.vaeId ?? null : null,
    trainedWords: version?.trainedWords ?? [],
    skipTrainedWords: acceptsTrainedWords
      ? version?.trainedWords
        ? !version.trainedWords.length
        : false
      : true,
    earlyAccessTimeFrame:
      version?.earlyAccessTimeFrame && features.earlyAccessModel
        ? String(version.earlyAccessTimeFrame)
        : '0',
    modelId: model?.id ?? -1,
    description: version?.description ?? null,
    epochs: version?.epochs ?? null,
    steps: version?.steps ?? null,
    monetization: version?.monetization ?? null,
    // @ts-ignore: we only need this for the toggle
    _monetization: !!version?.monetization,
  };

  const form = useForm({ schema, defaultValues, shouldUnregister: false, mode: 'onChange' });

  const skipTrainedWords = !isTextualInversion && (form.watch('skipTrainedWords') ?? false);
  const trainedWords = form.watch('trainedWords') ?? [];
  const monetization = form.watch('monetization') ?? null;
  const sponsorshipSettings = form.watch('monetization.sponsorshipSettings') ?? null;
  const { isDirty } = form.formState;

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation({
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to save model version',
      });
    },
  });
  const handleSubmit = async (data: Schema) => {
    if (isDirty || !version?.id) {
      const result = await upsertVersionMutation.mutateAsync({
        ...data,
        clipSkip: data.clipSkip ?? null,
        epochs: data.epochs ?? null,
        steps: data.steps ?? null,
        modelId: model?.id ?? -1,
        earlyAccessTimeFrame: Number(data.earlyAccessTimeFrame),
        trainedWords: skipTrainedWords ? [] : trainedWords,
        baseModelType: hasBaseModelType ? data.baseModelType : undefined,
        vaeId: hasVAE ? data.vaeId : undefined,
        monetization: data.monetization,
      });
      await queryUtils.modelVersion.getById.invalidate();
      if (model) await queryUtils.model.getById.invalidate({ id: model.id });
      onSubmit(result as ModelVersionUpsertInput);
    } else {
      onSubmit(version as ModelVersionUpsertInput);
    }
  };

  useEffect(() => {
    if (version)
      form.reset({
        ...version,
        modelId: version.modelId ?? model?.id ?? -1,
        baseModel: version.baseModel,
        skipTrainedWords: isTextualInversion
          ? false
          : acceptsTrainedWords
          ? version?.trainedWords
            ? !version.trainedWords.length
            : false
          : true,
        earlyAccessTimeFrame:
          version.earlyAccessTimeFrame && features.earlyAccessModel
            ? String(version.earlyAccessTimeFrame)
            : '0',
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptsTrainedWords, isTextualInversion, model?.id, version]);

  const atEarlyAccess = isEarlyAccess({
    publishedAt: model?.publishedAt ?? new Date(),
    earlyAccessTimeframe: version?.earlyAccessTimeFrame ?? 0,
    versionCreatedAt: version?.createdAt ?? new Date(),
  });
  const showEarlyAccessInput = version?.status !== 'Published' || atEarlyAccess;

  return (
    <>
      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          <InputText
            name="name"
            label="Name"
            placeholder="e.g.: v1.0"
            withAsterisk
            maxLength={25}
          />
          {showEarlyAccessInput && (
            <Input.Wrapper
              label="Early Access"
              description={
                <DismissibleAlert
                  id="ea-info"
                  size="sm"
                  title="Get feedback on your model before full release"
                  content={
                    <>
                      {`This puts your model in the "Early Access" list of models
                  available to `}
                      <Text component={NextLink} href="/pricing" variant="link" target="_blank">
                        Supporter Tier members
                      </Text>
                      {
                        ' of the community. This can be a great way to get feedback from an engaged community before your model is available to the general public. If you choose to enable Early Access, your model will be released to the public after the selected time frame.'
                      }
                    </>
                  }
                  mb="xs"
                />
              }
              error={form.formState.errors.earlyAccessTimeFrame?.message}
            >
              <InputSegmentedControl
                name="earlyAccessTimeFrame"
                data={[
                  { label: 'None', value: '0' },
                  { label: '1 day', value: '1' },
                  { label: '2 days', value: '2' },
                  { label: '3 days', value: '3' },
                  { label: '4 days', value: '4' },
                  { label: '5 days', value: '5' },
                ]}
                color="blue"
                size="xs"
                styles={(theme) => ({
                  root: {
                    border: `1px solid ${
                      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
                    }`,
                    background: 'none',
                    marginTop: theme.spacing.xs * 0.5, // 5px
                  },
                })}
                fullWidth
              />
            </Input.Wrapper>
          )}
          <Group spacing="xs" grow>
            <InputSelect
              name="baseModel"
              label="Base Model"
              placeholder="Base Model"
              withAsterisk
              style={{ flex: 1 }}
              data={constants.baseModels.map((x) => ({ value: x, label: x }))}
            />
            {hasBaseModelType && (
              <InputSelect
                name="baseModelType"
                label="Base Model Type"
                placeholder="Base Model Type"
                data={baseModelTypeOptions}
              />
            )}
          </Group>
          <InputRTE
            key="description"
            name="description"
            label="Version changes or notes"
            description="Tell us about this version"
            includeControls={['formatting', 'list', 'link']}
            editorSize="xl"
          />
          {acceptsTrainedWords && (
            <Stack spacing="xs">
              {!skipTrainedWords && (
                <InputMultiSelect
                  name="trainedWords"
                  label="Trigger Words"
                  placeholder="e.g.: Master Chief"
                  description={`Please input the words you have trained your model with${
                    isTextualInversion ? ' (max 1 word)' : ''
                  }`}
                  data={trainedWords}
                  getCreateLabel={(query) => `+ Create ${query}`}
                  maxSelectedValues={isTextualInversion ? 1 : undefined}
                  creatable
                  clearable
                  searchable
                  required
                />
              )}
              {!isTextualInversion && (
                <InputSwitch
                  name="skipTrainedWords"
                  label="This version doesn't require any trigger words"
                  onChange={(e) =>
                    e.target.checked ? form.setValue('trainedWords', []) : undefined
                  }
                />
              )}
            </Stack>
          )}
          <Stack spacing={4}>
            <Divider label="Training Params" />
            <Group spacing="xs" grow>
              <InputNumber
                name="epochs"
                label="Epochs"
                placeholder="Training Epochs"
                min={0}
                max={100000}
                sx={{ flexGrow: 1 }}
              />
              <InputNumber
                name="steps"
                label="Steps"
                placeholder="Training Steps"
                min={0}
                step={500}
                sx={{ flexGrow: 1 }}
              />
            </Group>
          </Stack>
          <Stack spacing={4}>
            <Divider label="Recommended Settings" />
            <Group spacing="xs" grow>
              <InputNumber
                name="clipSkip"
                label="Clip Skip"
                placeholder="Clip Skip"
                min={1}
                max={12}
              />
              {hasVAE && (
                <InputSelect
                  name="vaeId"
                  label="VAE"
                  placeholder="VAE"
                  data={vaeOptions}
                  clearable
                  searchable
                />
              )}
            </Group>
          </Stack>
          <Stack spacing={4}>
            <Divider label="Monetization options" />
            <AlertWithIcon
              icon={<IconInfoCircle size={16} />}
              iconColor="blue"
              radius={0}
              size="xs"
              mb="sm"
            >
              <Text size="xs">
                Monetization feature is not yet available but we have started collecting user
                preferences so that when the time comes, we can readily apply your settings.
              </Text>
            </AlertWithIcon>
            <Stack spacing="xs">
              <InputSwitch
                name="_monetization"
                label="I want to monetize this model"
                onChange={(e) => {
                  return e.target.checked
                    ? form.setValue('monetization', {
                        type: ModelVersionMonetizationType.PaidAccess,
                      })
                    : form.setValue('monetization', null);
                }}
              />
              {monetization && (
                <InputSelect
                  name="monetization.type"
                  label="Monetization Type"
                  placeholder="Please select monetization type"
                  withAsterisk
                  onChange={(type) =>
                    type !== ModelVersionMonetizationType.Sponsored
                      ? form.setValue('monetization.sponsorshipSettings', null)
                      : undefined
                  }
                  style={{ flex: 1 }}
                  data={Object.keys(modelVersionMonetizationTypeOptions).map((k) => {
                    const key = k as keyof typeof modelVersionMonetizationTypeOptions;

                    return {
                      value: k,
                      label: modelVersionMonetizationTypeOptions[key],
                    };
                  })}
                />
              )}

              {monetization?.type === ModelVersionMonetizationType.Sponsored && (
                <Group spacing="xs" grow>
                  <InputSelect
                    name="monetization.sponsorshipSettings.type"
                    label="Sponsorship Type"
                    placeholder="Please select sponsorship type"
                    withAsterisk
                    sx={{ flexGrow: 1 }}
                    data={Object.keys(modelVersionSponsorshipSettingsTypeOptions).map((k) => {
                      const key = k as keyof typeof modelVersionSponsorshipSettingsTypeOptions;

                      return {
                        value: k,
                        label: modelVersionSponsorshipSettingsTypeOptions[key],
                      };
                    })}
                  />
                  <InputNumber
                    name="monetization.sponsorshipSettings.unitAmount"
                    label="Price"
                    placeholder="Price"
                    withAsterisk
                    min={0}
                    max={100000}
                    sx={{ flexGrow: 1 }}
                    precision={2}
                    step={0.01}
                    icon={<IconCash size={18} />}
                    format="currency"
                  />
                </Group>
              )}
            </Stack>
          </Stack>
        </Stack>
        {children({ loading: upsertVersionMutation.isLoading })}
      </Form>
    </>
  );
}

type Props = {
  onSubmit: (version?: ModelVersionUpsertInput) => void;
  children: (data: { loading: boolean }) => React.ReactNode;
  model?: Partial<ModelUpsertInput & { publishedAt: Date | null }>;
  version?: Partial<ModelVersionUpsertInput & { createdAt: Date | null }>;
};
