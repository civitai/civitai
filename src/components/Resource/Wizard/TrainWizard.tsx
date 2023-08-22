import { ActionIcon, Container, createStyles, Stack, Stepper, Title } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { TrainingFormBasic } from '~/components/Resource/Forms/Training/TrainingBasicInfo';
import { basePath } from '~/components/Resource/Forms/Training/TrainingCommon';
import { TrainingFormImages } from '~/components/Resource/Forms/Training/TrainingImages';
import { TrainingFormSubmit } from '~/components/Resource/Forms/Training/TrainingSubmit';
import { ModelById } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

type ModelWithTags = Omit<ModelById, 'tagsOnModels'> & {
  tagsOnModels: Array<{ id: number; name: string }>;
};

// TODO [bw] change this to just step
type WizardState = {
  step: number;
  // model?: ModelWithTags;
  // modelVersion?: ModelWithTags['modelVersions'][number];
};

const useStyles = createStyles((theme) => ({
  closeButton: {
    position: 'absolute',
    top: theme.spacing.md,
    right: theme.spacing.md,
  },
}));

export default function TrainWizard() {
  const { classes } = useStyles();
  const router = useRouter();

  console.log(router.query);

  const { modelId } = router.query;
  const pathWithId = `${basePath}?modelId=${modelId}`;
  console.log(pathWithId);
  const isNew = router.pathname === basePath;
  const [state, setState] = useState<WizardState>({ step: 1 });

  const {
    data: model,
    isInitialLoading: modelLoading,
    isError: modelError,
  } = trpc.model.getById.useQuery({ id: Number(modelId) }, { enabled: !!modelId });

  const editing = !!model;
  const hasFiles = model && model.modelVersions[0].files.length > 0;

  useEffect(() => {
    if (!isNew) {
      if (!hasFiles) router.replace(`${pathWithId}&step=2`, undefined, { shallow: true });
      else router.replace(`${pathWithId}&step=3`, undefined, { shallow: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFiles, pathWithId, isNew]);

  useEffect(() => {
    // set current step based on query param
    if (state.step.toString() !== router.query.step) {
      const rawStep = router.query.step;
      const step = Number(rawStep);
      const validStep = isNumber(step) && step >= 1 && step <= 4;

      setState((current) => ({ ...current, step: validStep ? step : 1 }));
    }
  }, [isNew, router.query.step, state.step]);
  //
  // useEffect(() => {
  //   // set state model data when query has finished and there's data
  //   if (model) {
  //     const parsedModel = {
  //       ...model,
  //       tagsOnModels: model.tagsOnModels.map(({ tag }) => tag) ?? [],
  //     };
  //
  //     if (!isEqual(parsedModel, state.model))
  //       setState((current) => ({
  //         ...current,
  //         model: parsedModel,
  //         modelVersion: parsedModel.modelVersions[0],
  //       }));
  //   }
  // }, [model, state.model]);

  // const postId = state.modelVersion?.posts[0]?.id;

  return (
    // <FilesProvider model={state.model} version={state.modelVersion}>
    <Container size="sm">
      <ActionIcon
        className={classes.closeButton}
        size="xl"
        radius="xl"
        variant="light"
        // onClick={() => router.back()}
        // TODO go back to user training page
        onClick={() => {
          isNew
            ? typeof window !== 'undefined' && window.history.length <= 1
              ? router.replace(`/`)
              : router.back()
            : router.replace(`/`);
        }}
      >
        <IconX />
      </ActionIcon>
      {/*<LoadingOverlay visible={modelLoading} overlayBlur={2} />*/}
      {modelLoading ? (
        <PageLoader text="Loading model..." />
      ) : //   todo move this !model check to the other components
      modelError || (editing && !model) ? (
        <NotFound />
      ) : (
        <Stack py="xl">
          <Stepper
            active={state.step - 1}
            onStepClick={(step) =>
              router.replace(`${pathWithId}&step=${step + 1}`, undefined, {
                shallow: true,
              })
            }
            allowNextStepsSelect={false}
            size="sm"
          >
            {/* == Step 1: Model type selection + name */}
            <Stepper.Step label={editing ? 'Edit model' : 'Create your model'}>
              <Stack>
                <Title order={3}>{editing ? 'Edit model' : 'Create your model'}</Title>
                <TrainingFormBasic model={model} />
              </Stack>
            </Stepper.Step>

            {/* == Step 2: Upload images/zip, captioning */}
            {/*
                loading={uploading > 0}
                color={error + aborted > 0 ? 'red' : undefined}
              */}
            <Stepper.Step label={hasFiles ? 'Edit training data' : 'Add training data'}>
              <Stack>
                <Title order={3}>{hasFiles ? 'Edit training data' : 'Add training data'}</Title>
                <TrainingFormImages model={model} />
              </Stack>
            </Stepper.Step>

            {/* == Step 3: Review and submit for training */}
            <Stepper.Step label="Review and Submit">
              <Stack>
                <Title order={3}>Review and Submit</Title>
                <TrainingFormSubmit model={model} />
              </Stack>
            </Stepper.Step>
          </Stepper>
        </Stack>
      )}
    </Container>
    // </FilesProvider>
  );
}
