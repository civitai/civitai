import { Group, Input, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconInfoCircle } from '@tabler/icons';
import { z } from 'zod';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
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
import { constants } from '~/server/common/constants';
import {
  ModelVersionUpsertInput,
  modelVersionUpsertSchema2,
} from '~/server/schema/model-version.schema';
import { ModelUpsertInput } from '~/server/schema/model.schema';

const schema = modelVersionUpsertSchema2
  .extend({
    skipTrainedWords: z.boolean().default(false),
  })
  .refine((data) => (!data.skipTrainedWords ? data.trainedWords.length > 0 : true), {
    message: 'You need to specify at least one trained word',
    path: ['trainedWords'],
  });

export function ModelVersionUpsertForm({ model, version }: Props) {
  const form = useForm({ schema, defaultValues: version });

  const acceptsTrainedWords = ['Checkpoint', 'TextualInversion', 'LORA'].includes(model.type);
  const isTextualInversion = model.type === 'TextualInversion';
  const name = form.watch('name') ?? '';
  const skipTrainedWords = !isTextualInversion && (form.watch('skipTrainedWords') ?? false);
  const trainedWords = form.watch('trainedWords') ?? [];

  return (
    <Form form={form}>
      <Stack>
        <InputText name="name" label="Name" placeholder="e.g.: v1.0" withAsterisk />
        {name && name.toLowerCase().includes('safetensor') && (
          <AlertWithIcon icon={<IconInfoCircle />}>
            You can attach the SafeTensor file to an existing version, just add a model file 😉
          </AlertWithIcon>
        )}
        {name && (name.toLowerCase().includes('ckpt') || name.toLowerCase().includes('pickle')) && (
          <AlertWithIcon icon={<IconInfoCircle />}>
            You can attach the ckpt file to an existing version, just add a model file 😉
          </AlertWithIcon>
        )}
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
          editorSize="md"
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
                onChange={(e) => (e.target.checked ? form.setValue('trainedWords', []) : undefined)}
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
    </Form>
  );
}

type Props = {
  model: ModelUpsertInput;
  version?: ModelVersionUpsertInput;
};
