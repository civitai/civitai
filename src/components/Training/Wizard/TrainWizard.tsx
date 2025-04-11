import { Container, Group, Stack, Stepper, Title } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo, useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { FeatureIntroductionHelpButton } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { TrainingFormBasic } from '~/components/Training/Form/TrainingBasicInfo';
import { basePath } from '~/components/Training/Form/TrainingCommon';
import { TrainingFormImages } from '~/components/Training/Form/TrainingImages';
import { TrainingFormSubmit } from '~/components/Training/Form/TrainingSubmit';
import { useTrainingServiceStatus } from '~/components/Training/training.utils';
import { hashify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

type WizardState = {
  step: number;
};

export const TrainStatusMessage = () => {
  const status = useTrainingServiceStatus();
  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : null),
    [status.message]
  );

  return !status.available ? (
    <AlertWithIcon color="yellow" icon={<IconAlertTriangle size={20} />} iconColor="yellow">
      <CustomMarkdown allowedElements={['a', 'strong']} unwrapDisallowed>
        {status.message ?? 'Training is currently disabled.'}
      </CustomMarkdown>
    </AlertWithIcon>
  ) : status.available && status.message && messageHash ? (
    <DismissibleAlert color="yellow" title="Status Alert" id={messageHash}>
      <CustomMarkdown allowedElements={['a', 'strong']} unwrapDisallowed>
        {status.message}
      </CustomMarkdown>
    </DismissibleAlert>
  ) : (
    <></>
  );
};

export default function TrainWizard() {
  const router = useRouter();

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
    <Container size="md">
      {modelLoading ? (
        <PageLoader text="Loading resource..." />
      ) : modelError ? (
        <NotFound />
      ) : (
        <Stack pb="xl">
          <Group spacing={8} noWrap>
            <Title order={2}>Train a LoRA</Title>
            <FeatureIntroductionHelpButton
              feature="model-training"
              contentSlug={['feature-introduction', 'model-training']}
            />
          </Group>
          <TrainStatusMessage />
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
            <Stepper.Step label={editing ? 'Edit LoRA' : 'Create your LoRA'}>
              <Stack>
                <Title order={3}>{editing ? 'Edit LoRA' : 'Create your LoRA'}</Title>
                <TrainingFormBasic model={model} />
              </Stack>
            </Stepper.Step>

            {/* == Step 2: Upload images/zip, labeling */}
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
