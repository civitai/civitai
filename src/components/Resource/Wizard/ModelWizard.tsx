import { Button, Container, Group, Stack, Stepper, Title } from '@mantine/core';
import { ModelUploadType, TrainingStatus } from '@prisma/client';
import produce from 'immer';
import { NextRouter, useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PostEditWrapper } from '~/components/Post/Edit/PostEditLayout';
import { Files, UploadStepActions } from '~/components/Resource/Files';
import { FilesProvider } from '~/components/Resource/FilesProvider';
import { ModelUpsertForm } from '~/components/Resource/Forms/ModelUpsertForm';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { PostUpsertForm } from '~/components/Resource/Forms/PostUpsertForm';
import TrainingSelectFile from '~/components/Resource/Forms/TrainingSelectFile';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { TrainingUpdateSignalSchema } from '~/server/schema/signals.schema';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { ModelById } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

export type ModelWithTags = Omit<ModelById, 'tagsOnModels'> & {
  tagsOnModels: Array<{ isCategory: boolean; id: number; name: string }>;
};

type WizardState = {
  step: number;
};

const TrainingSignals = () => {
  const queryUtils = trpc.useContext();

  const onUpdate = useCallback((updated: TrainingUpdateSignalSchema) => {
    queryUtils.model.getById.setData(
      { id: updated.modelId },
      produce((old) => {
        if (!old) return old;
        const mv = old.modelVersions[0];
        if (mv) {
          mv.trainingStatus = updated.status;
          const mFile = mv.files.find((f) => f.type === 'Training Data');
          if (mFile) {
            // TODO [bw] why is this complaining about null in ModelFileFormat?
            // @ts-ignore
            mFile.metadata = updated.fileMetadata;
          }
        }
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useSignalConnection(SignalMessages.TrainingUpdate, onUpdate);

  return null;
};

const CreateSteps = ({
  step,
  model,
  modelVersion,
  hasVersions,
  goBack,
  goNext,
  modelId,
  router,
  postId,
}: {
  step: number;
  model?: ModelWithTags;
  modelVersion?: ModelWithTags['modelVersions'][number];
  hasVersions: boolean | undefined;
  goBack: () => void;
  goNext: () => void;
  modelId: string | string[] | undefined;
  router: NextRouter;
  postId: number | undefined;
}) => {
  const { getStatus: getUploadStatus } = useS3UploadStore();
  const { uploading, error, aborted } = getUploadStatus(
    (file) => file.meta?.versionId === modelVersion?.id
  );
  const editing = !!model;

  return (
    <Stepper
      active={step - 1}
      onStepClick={(step) =>
        router.replace(`/models/${modelId}/wizard?step=${step + 1}`, undefined, { shallow: true })
      }
      allowNextStepsSelect={false}
      size="sm"
    >
      {/* Step 1: Model Info */}
      <Stepper.Step label={editing ? 'Edit model' : 'Create your model'}>
        <Stack>
          <Title order={3}>{editing ? 'Edit model' : 'Create your model'}</Title>
          <ModelUpsertForm
            model={model}
            onSubmit={({ id }) => {
              if (editing) return goNext();
              router.replace(`/models/${id}/wizard?step=2`);
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

      {/* Step 2: Version Info */}
      <Stepper.Step label={hasVersions ? 'Edit version' : 'Add version'}>
        <Stack>
          <Title order={3}>{hasVersions ? 'Edit version' : 'Add version'}</Title>
          <ModelVersionUpsertForm model={model} version={modelVersion} onSubmit={goNext}>
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

      {/* Step 3: Upload Files */}
      <Stepper.Step
        label="Upload files"
        loading={uploading > 0}
        color={error + aborted > 0 ? 'red' : undefined}
      >
        <Stack>
          <Title order={3}>Upload files</Title>
          <Files />
          <UploadStepActions onBackClick={goBack} onNextClick={goNext} />
        </Stack>
      </Stepper.Step>

      <Stepper.Step label={postId ? 'Edit post' : 'Create a post'}>
        <Stack>
          <Title order={3}>{postId ? 'Edit post' : 'Create your post'}</Title>
          {model && modelVersion && (
            <PostEditWrapper postId={postId}>
              <PostUpsertForm modelVersionId={modelVersion.id} modelId={model.id} />
            </PostEditWrapper>
          )}
        </Stack>
      </Stepper.Step>
    </Stepper>
  );
};

const TrainSteps = ({
  step,
  model,
  modelVersion,
  goBack,
  goNext,
  modelId,
  router,
  postId,
}: {
  step: number;
  model: ModelWithTags;
  modelVersion: ModelWithTags['modelVersions'][number];
  goBack: () => void;
  goNext: () => void;
  modelId: string | string[] | undefined;
  router: NextRouter;
  postId: number | undefined;
}) => {
  return (
    <Stepper
      active={step - 1}
      onStepClick={(step) =>
        router.replace(`/models/${modelId}/wizard?step=${step + 1}`, undefined, { shallow: true })
      }
      allowNextStepsSelect={false}
      size="sm"
    >
      {/* Step 1: Select File */}
      <Stepper.Step
        label="Select Model File"
        loading={
          modelVersion.trainingStatus === TrainingStatus.Pending ||
          modelVersion.trainingStatus === TrainingStatus.Submitted ||
          modelVersion.trainingStatus === TrainingStatus.Processing
        }
        color={modelVersion.trainingStatus === TrainingStatus.Failed ? 'red' : undefined}
      >
        <Stack>
          <Title order={3}>Select Model File</Title>
          <Title mb="sm" order={5}>
            Choose a model file from the results of your training run.
            <br />
            Sample images are provided for reference.
          </Title>
          <TrainingSelectFile model={model} onNextClick={goNext} />
        </Stack>
      </Stepper.Step>

      {/* Step 2: Model Info */}
      <Stepper.Step label="Edit model">
        <Stack>
          <Title order={3}>Edit model</Title>
          <ModelUpsertForm model={model} onSubmit={goNext}>
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
          </ModelUpsertForm>
        </Stack>
      </Stepper.Step>

      {/* Step 3: Version Info */}
      <Stepper.Step label="Edit version">
        <Stack>
          <Title order={3}>Edit version</Title>
          <ModelVersionUpsertForm model={model} version={modelVersion} onSubmit={goNext}>
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
      <Stepper.Step label={postId ? 'Edit post' : 'Create a post'}>
        <Stack>
          <Title order={3}>{postId ? 'Edit post' : 'Create your post'}</Title>
          {model && modelVersion && (
            <PostEditWrapper postId={postId}>
              <PostUpsertForm modelVersionId={modelVersion.id} modelId={model.id} />
            </PostEditWrapper>
          )}
        </Stack>
      </Stepper.Step>
    </Stepper>
  );
};

export function ModelWizard() {
  const router = useRouter();

  const { id } = router.query;
  const isNew = router.pathname.includes('/create');
  const [state, setState] = useState<WizardState>({ step: 1 });

  const {
    data: model,
    isInitialLoading: modelLoading,
    isError: modelError,
  } = trpc.model.getById.useQuery({ id: Number(id) }, { enabled: !!id });

  const maxSteps = 4;

  const hasVersions = model && model.modelVersions.length > 0;
  const modelVersion = hasVersions ? model.modelVersions[0] : undefined;
  const hasFiles =
    model &&
    model.modelVersions.some((version) =>
      model.uploadType === ModelUploadType.Trained
        ? version.files.filter((f) => f.type === 'Model' || f.type === 'Pruned Model').length > 0
        : version.files.length > 0
    );

  const goNext = () => {
    if (state.step < maxSteps)
      router.replace(`/models/${id}/wizard?step=${state.step + 1}`, undefined, {
        shallow: true,
        scroll: true,
      });
  };

  const goBack = () => {
    if (state.step > 1)
      router.replace(`/models/${id}/wizard?step=${state.step - 1}`, undefined, {
        shallow: true,
        scroll: true,
      });
  };

  useEffect(() => {
    // redirect to correct step if missing values
    if (!isNew) {
      // don't redirect for Trained type
      if (model?.uploadType === ModelUploadType.Trained) return;

      if (!hasVersions) router.replace(`/models/${id}/wizard?step=2`, undefined, { shallow: true });
      else if (!hasFiles)
        router.replace(`/models/${id}/wizard?step=3`, undefined, { shallow: true });
      else router.replace(`/models/${id}/wizard?step=4`, undefined, { shallow: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFiles, hasVersions, id, isNew, model]);

  useEffect(() => {
    // set current step based on query param
    if (state.step.toString() !== router.query.step) {
      const rawStep = router.query.step;
      const step = Number(rawStep);
      const validStep = isNumber(step) && step >= 1 && step <= maxSteps;

      setState((current) => ({ ...current, step: validStep ? step : 1 }));
    }
  }, [isNew, router.query.step, state.step]);

  const postId = modelVersion?.posts[0]?.id;

  const modelFlatTags = !!model
    ? {
        ...model,
        tagsOnModels: model.tagsOnModels.map(({ tag }) => tag),
      }
    : undefined;

  return (
    <FilesProvider model={modelFlatTags} version={modelVersion}>
      <Container size="sm">
        {modelLoading ? (
          <PageLoader text="Loading model..." />
        ) : modelError ? (
          <NotFound />
        ) : (
          <Stack pb="xl">
            <Title mb="sm" order={2}>
              Publish a Model
            </Title>

            {model?.uploadType === ModelUploadType.Trained ? (
              <>
                <TrainSteps
                  model={modelFlatTags!}
                  modelVersion={modelVersion!}
                  goBack={goBack}
                  goNext={goNext}
                  modelId={id}
                  step={state.step}
                  router={router}
                  postId={postId}
                />
                <TrainingSignals />
              </>
            ) : (
              <CreateSteps
                model={modelFlatTags}
                modelVersion={modelVersion}
                hasVersions={hasVersions}
                goBack={goBack}
                goNext={goNext}
                modelId={id}
                step={state.step}
                router={router}
                postId={postId}
              />
            )}
          </Stack>
        )}
      </Container>
    </FilesProvider>
  );
}
