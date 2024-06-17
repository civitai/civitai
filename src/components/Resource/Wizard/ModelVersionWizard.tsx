import { Anchor, Button, Group, Stepper, Text, Title } from '@mantine/core';
import { ModelUploadType, TrainingStatus } from '@prisma/client';
import { IconArrowLeft } from '@tabler/icons-react';
import Link from 'next/link';
import { NextRouter, useRouter } from 'next/router';
import React, { useEffect } from 'react';
import { PageLoader } from '~/components/PageLoader/PageLoader';

import { Files, UploadStepActions } from '~/components/Resource/Files';
import { FilesProvider } from '~/components/Resource/FilesProvider';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { PostUpsertForm2 } from '~/components/Resource/Forms/PostUpsertForm2';
import TrainingSelectFile from '~/components/Resource/Forms/TrainingSelectFile';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { ModelById, ModelVersionById } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

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
            {({ loading }) => (
              <Group mt="xl" position="right">
                <Button type="submit" loading={loading}>
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
  versionId,
  modelData,
  modelVersion,
  goBack,
  goNext,
  router,
  postId,
}: {
  step: number;
  versionId: string | string[];
  modelData: ModelVersionById['model'];
  modelVersion: ModelVersionById;
  goBack: () => void;
  goNext: () => void;
  router: NextRouter;
  postId: number | undefined;
}) => {
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
          modelVersion.trainingStatus === TrainingStatus.Denied
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
          <ModelVersionUpsertForm model={modelData} version={modelVersion} onSubmit={goNext}>
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
        </div>
      </Stepper.Step>

      {/* Step 3: Post Info */}
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

export function ModelVersionWizard({ data }: Props) {
  const router = useRouter();

  const { id, versionId } = router.query;
  const isNew = router.pathname.includes('/create');
  const parsedStep = router.query.step ? Number(router.query.step) : 1;
  const step = isNumber(parsedStep) ? parsedStep : 1;

  const { data: modelVersion, isInitialLoading } = trpc.modelVersion.getById.useQuery(
    { id: Number(versionId), withFiles: true },
    { enabled: !!versionId }
  );

  const modelData = modelVersion?.model ?? data;

  const goNext = () => {
    if (step < MAX_STEPS)
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

  const postId = modelVersion?.posts?.[0]?.id;
  const isTraining = modelData?.uploadType === ModelUploadType.Trained;

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
      <div className="container max-w-sm pb-4">
        <Link href={`/models/${modelData?.id}`} passHref>
          <Anchor size="xs">
            <Group spacing={4} noWrap>
              <IconArrowLeft size={12} />
              <Text inherit>Back to {modelData?.name} page</Text>
            </Group>
          </Anchor>
        </Link>
      </div>
      {isInitialLoading ? (
        <PageLoader text="Loading model..." />
      ) : isTraining ? (
        <TrainSteps
          step={step}
          versionId={versionId!}
          modelData={modelData}
          modelVersion={modelVersion!}
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
