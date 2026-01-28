import { Button, Group, LoadingOverlay, Popover, Stack, Stepper, Text, Title } from '@mantine/core';
import type { NextRouter } from 'next/router';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { FeatureIntroductionHelpButton } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Files, UploadStepActions } from '~/components/Resource/Files';
import { FilesProvider } from '~/components/Resource/FilesProvider';
import { ModelUpsertForm } from '~/components/Resource/Forms/ModelUpsertForm';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { PostUpsertForm2 } from '~/components/Resource/Forms/PostUpsertForm2';
import TrainingSelectFile from '~/components/Resource/Forms/TrainingSelectFile';
import { useIsChangingLocation } from '~/components/RouterTransition/RouterTransition';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ModelUploadType, TrainingStatus } from '~/shared/utils/prisma/enums';
import { useS3UploadStore } from '~/store/s3-upload.store';
import type { ModelById } from '~/types/router';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';
import { TemplateSelect } from './TemplateSelect';
import { ReadOnlyAlert } from '~/components/ReadOnlyAlert/ReadOnlyAlert';

export type ModelWithTags = Omit<ModelById, 'tagsOnModels'> & {
  tagsOnModels: Array<{ isCategory: boolean; id: number; name: string }>;
};

const querySchema = z.object({
  id: z.coerce.number().optional(),
  templateId: z.coerce.number().optional(),
  bountyId: z.coerce.number().optional(),
  modelVersionId: z.coerce.number().optional(),
  src: z.coerce.string().optional(),
});

const CreateSteps = ({
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
  model?: ModelWithTags;
  modelVersion?: ModelWithTags['modelVersions'][number];
  goBack: () => void;
  goNext: () => void;
  modelId: number | undefined;
  router: NextRouter;
  postId: number | undefined;
}) => {
  const { getStatus: getUploadStatus } = useS3UploadStore();
  const { uploading, error, aborted } = getUploadStatus(
    (file) => file.meta?.versionId === modelVersion?.id
  );
  const editing = !!model;
  const hasVersions = model && model.modelVersions.length > 0;

  const result = querySchema.safeParse(router.query);
  const templateId = result.success ? result.data.templateId : undefined;
  const bountyId = result.success ? result.data.bountyId : undefined;

  const { data: templateFields, isInitialLoading: isTemplateLoading } =
    trpc.model.getTemplateFields.useQuery({ id: templateId as number }, { enabled: !!templateId });
  const { data: bountyFields, isInitialLoading: isBountyLoading } =
    trpc.model.getModelTemplateFieldsFromBounty.useQuery(
      { id: bountyId as number },
      { enabled: !!bountyId }
    );

  // Derived state for template/bounty loading
  const isLoadingTemplateData = isTemplateLoading || isBountyLoading;
  const modelData = model ?? templateFields ?? bountyFields;

  // Form key ensures remount when template source or loading state changes
  // See: https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes
  const formKey = `form-${templateId ?? bountyId ?? 'new'}-${
    isLoadingTemplateData ? 'loading' : 'ready'
  }`;

  return (
    <Stepper
      active={step - 1}
      onStepClick={(step) =>
        router.replace(getWizardUrl({ id: modelId, step: step + 1, templateId }), undefined, {
          shallow: true,
        })
      }
      allowNextStepsSelect={false}
      size="sm"
      classNames={{ steps: 'container max-w-sm' }}
    >
      {/* Step 1: Model Info */}
      <Stepper.Step label={editing ? 'Edit model' : 'Create your model'}>
        <div className="container relative flex max-w-sm flex-col gap-3">
          <LoadingOverlay visible={isLoadingTemplateData} />
          <Title order={3}>{editing ? 'Edit model' : 'Create your model'}</Title>
          <ModelUpsertForm
            key={formKey}
            model={modelData}
            onSubmit={({ id }) => {
              if (editing) return goNext();
              router.replace(getWizardUrl({ id, step: 2, templateId, bountyId })).then();
            }}
          >
            {({ loading }) => (
              <Group mt="xl" justify="flex-end">
                <Button type="submit" loading={loading}>
                  Next
                </Button>
              </Group>
            )}
          </ModelUpsertForm>
        </div>
      </Stepper.Step>

      {/* Step 2: Version Info */}
      <Stepper.Step label={hasVersions ? 'Edit version' : 'Add version'}>
        <div className="container flex max-w-sm flex-col gap-3">
          <Title order={3}>{hasVersions ? 'Edit version' : 'Add version'}</Title>
          <ModelVersionUpsertForm
            model={model ?? templateFields ?? bountyFields}
            version={modelVersion ?? templateFields?.version ?? bountyFields?.version}
            onSubmit={goNext}
          >
            {({ loading, canSave }) => (
              <Group mt="xl" justify="flex-end">
                <Button variant="default" onClick={goBack}>
                  Back
                </Button>
                <Button type="submit" loading={loading} disabled={!canSave}>
                  Next
                </Button>
              </Group>
            )}
          </ModelVersionUpsertForm>
        </div>
      </Stepper.Step>

      {/* Step 3: Upload Files */}
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
        {model && modelVersion && (
          <PostUpsertForm2 postId={postId} modelVersionId={modelVersion.id} modelId={model.id} />
        )}
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
  modelId: number | undefined;
  router: NextRouter;
  postId: number | undefined;
}) => {
  return (
    <Stepper
      active={step - 1}
      onStepClick={(step) =>
        router.replace(getWizardUrl({ id: modelId, step: step + 1 }), undefined, {
          shallow: true,
        })
      }
      allowNextStepsSelect={false}
      size="sm"
      classNames={{ steps: 'container max-w-sm' }}
    >
      {/* Step 1: Select File */}
      <Stepper.Step
        label="Select Model Iteration"
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
          <Title order={3}>Select Model Iteration</Title>
          <Text mb="sm">
            Choose a model iteration from the results of your training run.
            <br />
            Sample images are provided for reference.
          </Text>
          <TrainingSelectFile model={model} modelVersion={modelVersion} onNextClick={goNext} />
        </div>
      </Stepper.Step>

      {/* Step 2: Model Info */}
      <Stepper.Step label="Edit model">
        <div className="container flex max-w-sm flex-col gap-3">
          <Title order={3}>Edit model</Title>
          <ModelUpsertForm model={model} modelVersionId={modelVersion.id} onSubmit={goNext}>
            {({ loading }) => (
              <Group mt="xl" justify="flex-end">
                <Button variant="default" onClick={goBack}>
                  Back
                </Button>
                <Button type="submit" loading={loading}>
                  Next
                </Button>
              </Group>
            )}
          </ModelUpsertForm>
        </div>
      </Stepper.Step>

      {/* Step 3: Version Info */}
      <Stepper.Step label="Edit version">
        <div className="container flex max-w-sm flex-col gap-3">
          <Title order={3}>Edit version</Title>
          <ModelVersionUpsertForm model={model} version={modelVersion} onSubmit={goNext}>
            {({ loading, canSave }) => (
              <Group mt="xl" justify="flex-end">
                <Button variant="default" onClick={goBack}>
                  Back
                </Button>
                <Button type="submit" loading={loading} disabled={!canSave}>
                  Next
                </Button>
              </Group>
            )}
          </ModelVersionUpsertForm>
        </div>
      </Stepper.Step>

      {/* Step 4: Post Info */}
      <Stepper.Step label={postId ? 'Edit post' : 'Create a post'}>
        {model && modelVersion && (
          <PostUpsertForm2 postId={postId} modelVersionId={modelVersion.id} modelId={model.id} />
        )}
      </Stepper.Step>
    </Stepper>
  );
};

function getWizardUrl({
  id,
  step,
  templateId,
  bountyId,
  modelVersionId,
  src,
}: {
  step: number;
  id?: number;
  templateId?: number;
  bountyId?: number;
  modelVersionId?: number;
  src?: string;
}) {
  if (!id) return '';
  const query = QS.stringify({ templateId, bountyId, modelVersionId, step, src });
  return `/models/${id}/wizard?${query}`;
}

const MAX_STEPS = 4;

export function ModelWizard() {
  const currentUser = useCurrentUser();
  const router = useRouter();

  const result = querySchema.safeParse(router.query);
  const id = result.success ? result.data.id : undefined;
  const templateId = result.success ? result.data.templateId : undefined;
  const bountyId = result.success ? result.data.bountyId : undefined;
  const modelVersionId = result.success ? result.data.modelVersionId : undefined;
  const src = result.success ? result.data.src : undefined;
  // Not using zod schema here cause we don't want it failing if step is not a number
  const routeStep = router.query.step ? Number(router.query.step) : 1;
  const step = isNumber(routeStep) && routeStep >= 1 && routeStep <= MAX_STEPS ? routeStep : 1;

  const isNew = router.pathname.includes('/create');
  const [opened, setOpened] = useState(false);
  const isTransitioning = useIsChangingLocation();

  const {
    data: model,
    isInitialLoading: modelLoading,
    isError: modelError,
  } = trpc.model.getById.useQuery({ id: Number(id) }, { enabled: !!id });

  const isTraining = model?.uploadType === ModelUploadType.Trained;

  const modelVersions = model?.modelVersions;
  const modelVersion =
    isTraining && !!modelVersionId
      ? modelVersions?.find((mv) => mv.id === modelVersionId) ?? modelVersions?.[0]
      : modelVersions?.[0];

  const goNext = () => {
    if (isTransitioning) return;
    if (step < MAX_STEPS) {
      router
        .replace(
          getWizardUrl({ id, step: step + 1, templateId, bountyId, modelVersionId, src }),
          undefined,
          {
            shallow: !isNew,
          }
        )
        .then();
    }
  };

  const goBack = () => {
    if (step > 1) {
      router
        .replace(
          getWizardUrl({ id, step: step - 1, templateId, bountyId, modelVersionId, src }),
          undefined,
          {
            shallow: !isNew,
          }
        )
        .then();
    }
  };

  useEffect(() => {
    // redirect to correct step if missing values
    if (!isNew) {
      // don't redirect for trained type or if model is not loaded
      if (isTraining || !model) return;

      const hasVersions = model.modelVersions.length > 0;
      const hasFiles = model.modelVersions.some((version) => version.files.length > 0);

      if (!hasVersions)
        router
          .replace(getWizardUrl({ id, step: 2, templateId, bountyId, src }), undefined, {
            shallow: true,
          })
          .then();
      else if (!hasFiles)
        router
          .replace(getWizardUrl({ id, step: 3, templateId, bountyId, src }), undefined, {
            shallow: true,
          })
          .then();
      else
        router
          .replace(getWizardUrl({ id, step: 4, templateId, bountyId, src }), undefined, {
            shallow: true,
          })
          .then();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew, model, templateId, bountyId, src]);

  const postId = modelVersion?.posts[0]?.id;

  const modelFlatTags = !!model
    ? {
        ...model,
        tagsOnModels: model.tagsOnModels.map(({ tag }) => tag),
      }
    : undefined;

  return (
    <FilesProvider model={modelFlatTags} version={modelVersion}>
      <div className="container flex max-w-sm flex-col gap-3">
        <ReadOnlyAlert
          message={
            "Civitai is currently in read-only mode and you won't be able to edit your model. Please try again later."
          }
        />
        {modelLoading ? (
          <PageLoader text="Loading model..." />
        ) : modelError ? (
          <NotFound />
        ) : (
          <Stack pb="xl">
            <Group justify="space-between" wrap="nowrap">
              <Group gap={8} wrap="nowrap">
                <Title order={2}>{isTraining ? 'Review your Model' : 'Publish a Model'}</Title>
                <FeatureIntroductionHelpButton
                  feature="model-upload"
                  contentSlug={['feature-introduction', 'model-upload']}
                />
              </Group>
              {isNew && !isTraining && currentUser && (
                <Popover
                  opened={opened}
                  width={400}
                  position="bottom-end"
                  onChange={setOpened}
                  withArrow
                >
                  <Popover.Target>
                    <Button variant="subtle" onClick={() => setOpened(true)}>
                      {templateId ? 'Swap template' : 'Use a template'}
                    </Button>
                  </Popover.Target>
                  <Popover.Dropdown p={4}>
                    <TemplateSelect
                      username={currentUser.username!}
                      onSelect={() => setOpened(false)}
                    />
                  </Popover.Dropdown>
                </Popover>
              )}
            </Group>
          </Stack>
        )}
      </div>
      {!modelLoading && !modelError && (
        <>
          {isTraining ? (
            <TrainSteps
              model={modelFlatTags!}
              modelVersion={modelVersion!}
              goBack={goBack}
              goNext={goNext}
              modelId={id}
              step={step}
              router={router}
              postId={postId}
            />
          ) : (
            <CreateSteps
              model={modelFlatTags}
              modelVersion={modelVersion}
              goBack={goBack}
              goNext={goNext}
              modelId={id}
              step={step}
              router={router}
              postId={postId}
            />
          )}
        </>
      )}
    </FilesProvider>
  );
}
