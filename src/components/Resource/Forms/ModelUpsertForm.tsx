import { Stack, Group, Input } from '@mantine/core';
import { CheckpointType, ModelType, TagTarget } from '@prisma/client';
import { z } from 'zod';
import {
  useForm,
  Form,
  InputText,
  InputSelect,
  InputSegmentedControl,
  InputRTE,
  InputTags,
} from '~/libs/form';
import { ModelUpsertInput, modelUpsertSchema } from '~/server/schema/model.schema';
import { splitUppercase } from '~/utils/string-helpers';

const schema = modelUpsertSchema.refine(
  (data) => (data.type === 'Checkpoint' ? !!data.checkpointType : true),
  {
    message: 'Please select the checkpoint type',
    path: ['checkpointType'],
  }
);

export function ModelUpsertForm({ model }: Props) {
  const editing = !!model;

  const form = useForm({ schema });
  const { errors } = form.formState;
  const [type, allowDerivatives, status] = form.watch(['type', 'allowDerivatives', 'status']);

  const handleModelTypeChange = (value: ModelType) => {
    // TODO.post - uncomment this code if useForm({ shouldUnregister:false })
    // form.setValue('checkpointType', null);
    switch (value) {
      case 'Checkpoint':
        form.setValue('checkpointType', CheckpointType.Merge);
        break;
      default:
        break;
    }
  };

  return (
    <Form form={form}>
      <Stack>
        <InputText name="name" label="Name" placeholder="Name" withAsterisk />
        <Stack spacing={5}>
          <Group spacing={8} grow>
            <InputSelect
              name="type"
              label="Type"
              placeholder="Type"
              data={Object.values(ModelType).map((type) => ({
                label: splitUppercase(type),
                value: type,
              }))}
              onChange={handleModelTypeChange}
              disabled={editing}
              withAsterisk
            />
            {type === 'Checkpoint' && (
              <Input.Wrapper label="Checkpoint Type" withAsterisk>
                <InputSegmentedControl
                  name="checkpointType"
                  data={Object.values(CheckpointType).map((type) => ({
                    label: splitUppercase(type),
                    value: type,
                  }))}
                  color="blue"
                  styles={(theme) => ({
                    root: {
                      border: `1px solid ${
                        errors.checkpointType
                          ? theme.colors.red[theme.fn.primaryShade()]
                          : theme.colorScheme === 'dark'
                          ? theme.colors.dark[4]
                          : theme.colors.gray[4]
                      }`,
                      background: 'none',
                      height: 36,
                    },
                    label: {
                      padding: '2px 10px',
                    },
                  })}
                  fullWidth
                />
              </Input.Wrapper>
            )}
          </Group>
          {errors.checkpointType && <Input.Error>{errors.checkpointType.message}</Input.Error>}
        </Stack>
        <InputTags name="tagsOnModels" label="Tags" target={[TagTarget.Model]} />
        <InputRTE
          name="description"
          label="About your model"
          description="Tell us what your model does"
          includeControls={['heading', 'formatting', 'list', 'link', 'media', 'mentions']}
          editorSize="md"
        />
      </Stack>
    </Form>
  );
}

type Props = {
  model?: ModelUpsertInput;
};
