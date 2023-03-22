import { Group, Input, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { useEffect } from 'react';
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
import { BaseModel, constants } from '~/server/common/constants';
import {
  ModelVersionUpsertInput,
  modelVersionUpsertSchema2,
} from '~/server/schema/model-version.schema';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

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

export function ModelVersionUpsertForm({ model, version, children, onSubmit }: Props) {
  const features = useFeatureFlags();
  const queryUtils = trpc.useContext();

  const acceptsTrainedWords = ['Checkpoint', 'TextualInversion', 'LORA'].includes(
    model?.type ?? ''
  );
  const isTextualInversion = model?.type === 'TextualInversion';

  const defaultValues: Schema = {
    ...version,
    name: version?.name ?? '',
    baseModel: (version?.baseModel as BaseModel) ?? 'SD 1.5',
    trainedWords: version?.trainedWords ?? [],
    skipTrainedWords: version?.trainedWords ? !version.trainedWords.length : !acceptsTrainedWords,
    earlyAccessTimeFrame:
      version?.earlyAccessTimeFrame && features.earlyAccessModel
        ? String(version.earlyAccessTimeFrame)
        : '0',
    modelId: model?.id ?? -1,
    description: version?.description ?? null,
    epochs: version?.epochs ?? null,
    steps: version?.steps ?? null,
  };
  const form = useForm({ schema, defaultValues, shouldUnregister: false, mode: 'onChange' });

  const skipTrainedWords = !isTextualInversion && (form.watch('skipTrainedWords') ?? false);
  const trainedWords = form.watch('trainedWords') ?? [];
  const { isDirty } = form.formState;

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation({
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to saved model version',
      });
    },
  });
  const handleSubmit = async (data: Schema) => {
    if (isDirty) {
      const result = await upsertVersionMutation.mutateAsync({
        ...data,
        modelId: model?.id ?? -1,
        earlyAccessTimeFrame: Number(data.earlyAccessTimeFrame),
        trainedWords: skipTrainedWords ? [] : trainedWords,
      });
      await queryUtils.model.getById.invalidate({ id: result.modelId });
      onSubmit(result as ModelVersionUpsertInput);
    } else {
      onSubmit(version as ModelVersionUpsertInput);
    }
  };

  useEffect(() => {
    if (version)
      form.reset({
        ...version,
        modelId: version?.modelId ?? model?.id ?? -1,
        baseModel: version.baseModel as BaseModel,
        skipTrainedWords: version.trainedWords
          ? !version.trainedWords.length
          : !acceptsTrainedWords,
        earlyAccessTimeFrame:
          version.earlyAccessTimeFrame && features.earlyAccessModel
            ? String(version.earlyAccessTimeFrame)
            : '0',
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return (
    <>
      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          <InputText name="name" label="Name" placeholder="e.g.: v1.0" withAsterisk />
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
          <InputSelect
            name="baseModel"
            label="Base Model"
            placeholder="Base Model"
            withAsterisk
            style={{ flex: 1 }}
            data={constants.baseModels.map((x) => ({ value: x, label: x }))}
          />
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
          <Group spacing="xs" grow noWrap>
            <InputNumber
              name="epochs"
              label="Training Epochs"
              placeholder="Training Epochs"
              min={0}
              max={100000}
            />
            <InputNumber
              name="steps"
              label="Training Steps"
              placeholder="Training Steps"
              min={0}
              step={500}
            />
          </Group>
        </Stack>
        {children({ loading: upsertVersionMutation.isLoading })}
      </Form>
    </>
  );
}

type Props = {
  onSubmit: (version?: ModelVersionUpsertInput) => void;
  children: (data: { loading: boolean }) => React.ReactNode;
  model?: Partial<ModelUpsertInput>;
  version?: Partial<ModelVersionUpsertInput>;
};
