import {
  ActionIcon,
  Button,
  Container,
  createStyles,
  Group,
  Stack,
  Stepper,
  Title,
} from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { IconX } from '@tabler/icons';
import isEqual from 'lodash/isEqual';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

import { PostEditWrapper } from '~/components/Post/Edit/PostEditLayout';
import { Files } from '~/components/Resource/Files';
import { ModelUpsertForm } from '~/components/Resource/Forms/ModelUpsertForm';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { ModelById } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

import { PostUpsertForm } from '../Forms/PostUpsertForm';

type ModelWithTags = Omit<ModelById, 'tagsOnModels'> & {
  tagsOnModels: Array<{ id: number; name: string }>;
};

type WizardState = {
  step: number;
  model?: ModelWithTags;
  modelVersion?: ModelWithTags['modelVersions'][number];
};

const useStyles = createStyles((theme) => ({
  closeButton: {
    position: 'absolute',
    top: theme.spacing.md,
    right: theme.spacing.md,
  },
}));

export function ModelWizard() {
  const { classes } = useStyles();
  const router = useRouter();
  const getUploadStatus = useS3UploadStore((state) => state.getStatus);

  const { id, step = '1' } = router.query;
  const parsedStep = Array.isArray(step) ? Number(step[0]) : Number(step);

  const [state, setState] = useState<WizardState>({
    step: isNumber(parsedStep) ? parsedStep : 1,
  });

  const { data: model } = trpc.model.getById.useQuery({ id: Number(id) }, { enabled: !!id });

  useDidUpdate(() => {
    router.push(`/models/v2/${id}/wizard?step=${state.step}`, undefined, { shallow: true });
  }, [id, state.step]);

  useEffect(() => {
    if (model) {
      const parsedModel = {
        ...model,
        tagsOnModels: model.tagsOnModels.map(({ tag }) => tag) ?? [],
      };

      if (!isEqual(parsedModel, state.model))
        setState((current) => ({
          ...current,
          model: parsedModel,
          modelVersion: parsedModel.modelVersions.at(0),
        }));
    }
  }, [model, state.model]);

  const goNext = () => {
    if (state.step < 4) {
      setState((current) => ({
        ...current,
        step: current.step + 1,
      }));
    }
  };

  const goBack = () => {
    if (state.step > 1) {
      setState((current) => ({
        ...current,
        step: current.step - 1,
      }));
    }
  };

  const editing = !!model;
  const hasVersions = model && model.modelVersions.length > 0;
  const hasFiles = model && model.modelVersions.some((version) => version.files.length > 0);

  const { uploading, error, aborted } = getUploadStatus(
    (file) => file.meta?.versionId === state.modelVersion?.id
  );

  return (
    <Container size="sm">
      <ActionIcon
        className={classes.closeButton}
        size="xl"
        radius="xl"
        variant="light"
        onClick={() =>
          editing && hasVersions && hasFiles ? router.push(`/models/v2/${id}`) : router.back()
        }
      >
        <IconX />
      </ActionIcon>
      <Stack py="xl">
        <Stepper
          active={state.step - 1}
          onStepClick={(step) => setState((current) => ({ ...current, step: step + 1 }))}
          allowNextStepsSelect={false}
          size="sm"
        >
          <Stepper.Step label={editing ? 'Edit model' : 'Create your model'}>
            <Stack>
              <Title order={3}>{editing ? 'Edit model' : 'Create your model'}</Title>
              <ModelUpsertForm
                model={state.model}
                onSubmit={({ id }) => {
                  if (editing) return goNext();
                  router.replace(`/models/v2/${id}/wizard?step=2`);
                }}
              >
                {({ loading }) => (
                  <Group mt="xl" position="right">
                    <Button type="submit" loading={loading}>
                      Next
                    </Button>
                  </Group>
                )}
              </ModelUpsertForm>
            </Stack>
          </Stepper.Step>
          <Stepper.Step label={hasVersions ? 'Edit version' : 'Add version'}>
            <Stack>
              <Title order={3}>{hasVersions ? 'Edit version' : 'Add version'}</Title>
              <ModelVersionUpsertForm
                model={state.model}
                version={state.modelVersion}
                onSubmit={goNext}
              >
                {({ loading }) => (
                  <Group mt="xl" position="right">
                    <Button variant="default" onClick={goBack}>
                      Back
                    </Button>
                    <Button type="submit" loading={loading}>
                      Next
                    </Button>
                  </Group>
                )}
              </ModelVersionUpsertForm>
            </Stack>
          </Stepper.Step>
          <Stepper.Step
            label="Upload files"
            loading={uploading > 0}
            color={error + aborted > 0 ? 'red' : undefined}
          >
            <Stack>
              <Title order={3}>Upload files</Title>
              <Files
                model={state.model}
                version={state.modelVersion}
                onStartUploadClick={() => goNext()}
              />
              <Group mt="xl" position="right">
                <Button variant="default" onClick={goBack}>
                  Back
                </Button>
                <Button onClick={goNext}>Next</Button>
              </Group>
            </Stack>
          </Stepper.Step>
          <Stepper.Step label="Create a post">
            <Stack>
              <Title order={3}>Create your post</Title>
              {state.model && state.modelVersion && (
                <PostEditWrapper postId={state.modelVersion.posts[0]?.id}>
                  <PostUpsertForm modelVersionId={state.modelVersion.id} modelId={state.model.id} />
                </PostEditWrapper>
              )}

              <Group mt="xl" position="right">
                <Button variant="default" onClick={goBack}>
                  Back
                </Button>
              </Group>
            </Stack>
          </Stepper.Step>
        </Stepper>
      </Stack>
    </Container>
  );
}
