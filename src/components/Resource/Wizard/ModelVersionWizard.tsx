import { Alert, Anchor, Button, Group, Stack, Stepper, Text, Title } from '@mantine/core';
import { Availability, ModelUploadType, TrainingStatus } from '~/shared/utils/prisma/enums';
import { IconArrowLeft } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { NextRouter } from 'next/router';
import { useRouter } from 'next/router';
import React, { useEffect } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';

import { Files, UploadStepActions } from '~/components/Resource/Files';
import { FilesProvider } from '~/components/Resource/FilesProvider';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { PostUpsertForm2 } from '~/components/Resource/Forms/PostUpsertForm2';
import TrainingSelectFile from '~/components/Resource/Forms/TrainingSelectFile';
import { useS3UploadStore } from '~/store/s3-upload.store';
import type { ModelById, ModelVersionById } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';
import { showErrorNotification } from '~/utils/notifications';
import { ReadOnlyAlert } from '~/components/ReadOnlyAlert/ReadOnlyAlert';

const MAX_STEPS = 3;

const CreateSteps = ({
  step,
  versionId,
  modelData,
  modelVersion,
  goBack,
  goNext,
  router,
  postId,
}: {
  step: number;
  versionId?: string | string[];
  modelData?: ModelVersionById['model'];
  modelVersion?: ModelVersionById;
  goBack: () => void;
  goNext: () => void;
  router: NextRouter;
  postId: number | undefined;
}) => {
  const { getStatus: getUploadStatus } = useS3UploadStore();
  const { uploading, error, aborted } = getUploadStatus(
    (file) => file.meta?.versionId === modelVersion?.id
  );
  const editing = !!modelVersion?.id;

  return (
    <Stepper
      active={step - 1}
      onStepClick={(step) =>
        router.replace(
          `/models/${modelData?.id}/model-versions/${versionId}/wizard?step=${step + 1}`
        )
      }
      allowNextStepsSelect={false}
      size="sm"
      classNames={{ steps: 'container max-w-sm' }}
    >
      <Stepper.Step label={editing ? 'Edit version' : 'Add version'}>
        <div className="container flex max-w-sm flex-col gap-3">
          <Title order={3}>{editing ? 'Edit version' : 'Add version'}</Title>
          <ModelVersionUpsertForm
            model={modelData}
            version={modelVersion}
            onSubmit={(result) => {
              if (editing) return goNext();
              router
                .replace(`/models/${result?.modelId}/model-versions/${result?.id}/wizard?step=2`)
                .then();
            }}
          >
            {({ loading, canSave }) => (
              <Group mt="xl" justify="flex-end">
                <Button type="submit" loading={loading} disabled={!canSave}>
                  Next
                </Button>
              </Group>
            )}
          </ModelVersionUpsertForm>
        </div>
      </Stepper.Step>
      <Stepper.Step
        label="Upload files"
        loading={uploading > 0}
        color={error + aborted > 0 ? 'red' : undefined}
      >
        <div className="container flex max-w-sm flex-col gap-3">
          <Title order={3}>Upload files</Title>
          <Files />
          <UploadStepActions onBackClick={goBack} onNextClick={goNext} />
        </div>
      </Stepper.Step>
      <Stepper.Step label={postId ? 'Edit post' : 'Create a post'}>
        {modelVersion && modelData && (
          <PostUpsertForm2
            postId={postId}
            modelVersionId={modelVersion.id}
            modelId={modelData.id}
          />
        )}
      </Stepper.Step>
    </Stepper>
  );
};

const TrainSteps = ({
  step,
  modelData,
  modelVersion,
  goBack,
  goNext,
  router,
  postId,
}: {
  step: number;
  modelData: ModelVersionById['model'];
  modelVersion: ModelVersionById;
  goBack: () => void;
  goNext: () => void;
  router: NextRouter;
  postId: number | undefined;
}) => {
  const isPrivateModel = modelData?.availability === Availability.Private;
  const publishPrivateModelVersionMutation =
    trpc.modelVersion.publishPrivateModelVersion.useMutation();
  const utils = trpc.useUtils();

  const onPublish = async () => {
    try {
      await publishPrivateModelVersionMutation.mutateAsync({ id: modelVersion.id });

      utils.modelVersion.getById.invalidate({ id: modelVersion.id });
      utils.model.getById.invalidate({ id: modelData.id });

      router.replace(`/models/${modelData.id}?modelVersionId=${modelVersion.id}`);
    } catch (error) {
      showErrorNotification({
        title: 'Failed to publish private model',
        error: new Error((error as Error).message),
      });
    }
  };

  return (
    <Stepper
      active={step - 1}
      onStepClick={(step) =>
        router.replace(
          `/models/${modelData?.id}/model-versions/${modelVersion.id}/wizard?step=${step + 1}`
        )
      }
      allowNextStepsSelect={false}
      size="sm"
      classNames={{ steps: 'container max-w-sm' }}
    >
      {/* Step 1: Select File */}
      <Stepper.Step
        label="Select Model File"
        loading={
          modelVersion.trainingStatus === TrainingStatus.Pending ||
          modelVersion.trainingStatus === TrainingStatus.Submitted ||
          modelVersion.trainingStatus === TrainingStatus.Paused ||
          modelVersion.trainingStatus === TrainingStatus.Processing
        }
        color={
          modelVersion.trainingStatus === TrainingStatus.Failed ||
          modelVersion.trainingStatus === TrainingStatus.Denied ||
          modelVersion.trainingStatus === TrainingStatus.Expired
            ? 'red'
            : undefined
        }
      >
        <div className="container flex max-w-sm flex-col gap-3">
          <Title order={3}>Select Model File</Title>
          <Title mb="sm" order={5}>
            Choose a model file from the results of your training run.
            <br />
            Sample images are provided for reference.
          </Title>
          <TrainingSelectFile model={modelData} modelVersion={modelVersion} onNextClick={goNext} />
        </div>
      </Stepper.Step>

      {/* Step 2: Version Info */}
      <Stepper.Step label="Edit version">
        <div className="container flex max-w-sm flex-col gap-3">
          <Title order={3}>Edit version</Title>
          <ModelVersionUpsertForm
            model={modelData}
            version={modelVersion}
            onSubmit={isPrivateModel ? onPublish : goNext}
          >
            {({ loading, canSave }) => (
              <Stack gap="xs" mt="xl">
                {isPrivateModel && (
                  <Alert color="yellow" title="Private model version">
                    This model version will be marked as private because of the model&rsquo;s
                    privacy. A post will be automatically created based off of the selected epoch.
                  </Alert>
                )}
                <Group justify="flex-end">
                  <Button variant="default" onClick={goBack}>
                    Back
                  </Button>
                  <Button
                    type="submit"
                    loading={loading || publishPrivateModelVersionMutation.isLoading}
                    disabled={!canSave}
                  >
                    {isPrivateModel ? 'Complete' : 'Next'}
                  </Button>
                </Group>
              </Stack>
            )}
          </ModelVersionUpsertForm>
        </div>
      </Stepper.Step>

      {/* Step 3: Post Info - Not required for private models. */}
      {(!isPrivateModel || step === 3) && (
        <Stepper.Step label={postId ? 'Edit post' : 'Create a post'}>
          {modelVersion && modelData && (
            <PostUpsertForm2
              postId={postId}
              modelVersionId={modelVersion.id}
              modelId={modelData.id}
            />
          )}
        </Stepper.Step>
      )}
    </Stepper>
  );
};

export function ModelVersionWizard({ data }: Props) {
  const router = useRouter();

  const { id, versionId } = router.query;
  const isNew = router.pathname.includes('/create');
  const parsedStep = router.query.step ? Number(router.query.step) : 1;
  const step = isNumber(parsedStep) ? parsedStep : 1;

  const {
    data: modelVersion,
    isInitialLoading,
    isError,
  } = trpc.modelVersion.getById.useQuery(
    { id: Number(versionId), withFiles: true },
    { enabled: !!versionId }
  );

  const modelData = modelVersion?.model ?? data;
  const isPrivateModel = modelData?.availability === Availability.Private;
  const totalSteps = isPrivateModel ? 2 : MAX_STEPS; // @luis: This whole thing requires a refactor, but anyway.

  const goNext = () => {
    if (step < totalSteps)
      router
        .replace(`/models/${id}/model-versions/${versionId}/wizard?step=${step + 1}`, undefined, {
          shallow: !isNew,
        })
        .then();
  };

  const goBack = () => {
    if (step > 1)
      router
        .replace(`/models/${id}/model-versions/${versionId}/wizard?step=${step - 1}`, undefined, {
          shallow: !isNew,
        })
        .then();
  };

  const hasFiles = modelVersion && !!modelVersion.files?.length;

  // Filter to posts belonging to the owner of the model
  const postId = modelVersion?.posts?.filter((post) => post.userId === modelData?.user.id)?.[0]?.id;
  const isTraining = modelVersion?.uploadType === ModelUploadType.Trained;

  useEffect(() => {
    if (isTraining || isInitialLoading) return;

    // redirect to correct step if missing values
    if (!isNew) {
      if (!hasFiles)
        router
          .replace(`/models/${id}/model-versions/${versionId}/wizard?step=2`, undefined, {
            shallow: true,
          })
          .then();
      else
        router
          .replace(`/models/${id}/model-versions/${versionId}/wizard?step=3`, undefined, {
            shallow: true,
          })
          .then();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFiles, id, isNew, versionId]);

  return (
    <FilesProvider model={modelData} version={modelVersion}>
      <ReadOnlyAlert
        message={
          "Civitai is currently in read-only mode and you won't be able to edit your model version. Please try again later."
        }
      />
      <div className="container max-w-sm pb-4">
        <Link legacyBehavior href={`/models/${modelData?.id}`} passHref>
          <Anchor size="xs">
            <Group gap={4} wrap="nowrap">
              <IconArrowLeft size={12} />
              <Text inherit>Back to {modelData?.name} page</Text>
            </Group>
          </Anchor>
        </Link>
      </div>
      {isInitialLoading ? (
        <PageLoader text="Loading model..." />
      ) : isError || !modelData ? (
        <NotFound />
      ) : isTraining ? (
        <TrainSteps
          step={step}
          modelData={modelData}
          modelVersion={modelVersion}
          goBack={goBack}
          goNext={goNext}
          router={router}
          postId={postId}
        />
      ) : (
        <CreateSteps
          step={step}
          versionId={versionId}
          modelData={modelData}
          modelVersion={modelVersion}
          goBack={goBack}
          goNext={goNext}
          router={router}
          postId={postId}
        />
      )}
    </FilesProvider>
  );
}

type Props = {
  data?: ModelById;
};
