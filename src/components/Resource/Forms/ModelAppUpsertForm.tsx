import { Grid, Input, SegmentedControl, Select, Stack } from '@mantine/core';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { Form, InputText, useForm } from '~/libs/form';
import {
  ModelAppUpsertInput,
  modelAppUpsertSchema,
  ModelUpsertInput,
} from '~/server/schema/model.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

enum UpsertRepoMode {
  Select = 'Select Existed',
  Import = 'Import From GitHub',
}

const schema = modelAppUpsertSchema.refine((data) => (data?.url ? !!data?.url : true), {
  message: 'Please select a repository or input a GitHub repository URL',
  path: ['url'],
});

export function ModelAppUpsertForm({ model, children, onSubmit }: Props) {
  const [upsertRepoMode, setUpsertRepoMode] = useState<UpsertRepoMode>(UpsertRepoMode.Select);
  const defaultValues: ModelAppUpsertInput = {
    id: model?.app?.id,
    name: model?.app?.name ?? '',
    url: model?.app?.url ?? '',
  };
  const form = useForm({ schema, mode: 'onChange', defaultValues, shouldUnregister: false });
  const queryUtils = trpc.useContext();

  const { isDirty, errors } = form.formState;

  const upsertModelMutation = trpc.model.upsert.useMutation({
    onSuccess: async (data, payload) => {
      await queryUtils.model.getById.invalidate({ id: data.id });
      if (!payload.id) await queryUtils.model.getMyDraftModels.invalidate();
      onSubmit(data);
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message), title: 'Failed to save model' });
    },
  });
  const handleSubmit = (data: z.infer<typeof schema>) => {
    if (isDirty) upsertModelMutation.mutate({ ...model, app: data } as ModelUpsertInput);
    else onSubmit(defaultValues);
  };

  useEffect(() => {
    if (model?.app) form.reset(model?.app);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.app]);

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Grid gutter="xl">
        <Grid.Col span={12}>
          <Stack>
            <SegmentedControl
              my={5}
              value={upsertRepoMode}
              size="xs"
              color="blue"
              styles={(theme) => ({
                root: {
                  border: `1px solid ${
                    theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
                  }`,
                  background: 'none',
                },
              })}
              data={Object.values(UpsertRepoMode).map((el) => ({
                label: el,
                value: el,
              }))}
              onChange={(value: UpsertRepoMode) => {
                setUpsertRepoMode(value);
              }}
            />
            {upsertRepoMode === UpsertRepoMode.Select ? (
              <Select
                label="Choose an existed repository"
                // defaultValue={<select by model?.app?.id>}
                data={[]}
                withAsterisk
                onChange={() => alert('Not implemented')}
              />
            ) : (
              <Stack spacing={5}>
                <InputText
                  name="name"
                  description="Enter a name for your model."
                  label="Name"
                  placeholder="Name"
                  withAsterisk
                />
                <InputText
                  name="url"
                  description="Enter a GitHub repository URL."
                  label="Github URL"
                  placeholder="Github URL"
                  withAsterisk
                />
                {errors.url && <Input.Error>{errors.url.message}</Input.Error>}
              </Stack>
            )}
          </Stack>
        </Grid.Col>
      </Grid>
      {typeof children === 'function'
        ? children({ loading: upsertModelMutation.isLoading })
        : children}
    </Form>
  );
}

type Props = {
  onSubmit: (data: { id?: number }) => void;
  children: React.ReactNode | ((data: { loading: boolean }) => React.ReactNode);
  model?: Partial<ModelUpsertInput>;
};
