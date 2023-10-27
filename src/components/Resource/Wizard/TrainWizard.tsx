import { Container, Stack, Stepper, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { TrainingFormBasic } from '~/components/Resource/Forms/Training/TrainingBasicInfo';
import { basePath } from '~/components/Resource/Forms/Training/TrainingCommon';
import { TrainingFormImages } from '~/components/Resource/Forms/Training/TrainingImages';
import { TrainingFormSubmit } from '~/components/Resource/Forms/Training/TrainingSubmit';
import { usePostHog } from '~/hooks/usePostHog';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

type WizardState = {
  step: number;
};

export default function TrainWizard() {
  const router = useRouter();

  const posthog = usePostHog();
  useEffect(() => {
    posthog?.startSessionRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { modelId } = router.query;
  const pathWithId = `${basePath}?modelId=${modelId}`;
  const isNew = router.pathname === basePath;
  const [state, setState] = useState<WizardState>({ step: 1 });

  const {
    data: model,
    isInitialLoading: modelLoading,
    isError: modelError,
  } = trpc.training.getModelBasic.useQuery({ id: Number(modelId) }, { enabled: !!modelId });

  const editing = !!model;
  const hasFiles = model && model.modelVersions[0]?.files?.length > 0;

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

  return (
    <Container size="sm">
      {modelLoading ? (
        <PageLoader text="Loading model..." />
      ) : modelError ? (
        <NotFound />
      ) : (
        <Stack pb="xl">
          <Title mb="sm" order={2}>
            Train a Model
          </Title>
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
                {model ? <TrainingFormImages model={model} /> : <NotFound />}
              </Stack>
            </Stepper.Step>

            {/* == Step 3: Review and submit for training */}
            <Stepper.Step label="Review and Submit">
              <Stack>
                <Title order={3}>Review and Submit</Title>
                {model ? <TrainingFormSubmit model={model} /> : <NotFound />}
              </Stack>
            </Stepper.Step>
          </Stepper>
        </Stack>
      )}
    </Container>
  );
}
