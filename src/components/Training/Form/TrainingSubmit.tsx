import {
  Accordion,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { showNotification } from '@mantine/notifications';
import { IconAlertTriangle, IconConfetti, IconCopy, IconPlus, IconX } from '@tabler/icons-react';
import type { TRPCClientErrorBase } from '@trpc/client';
import type { DefaultErrorShape } from '@trpc/server';
import clsx from 'clsx';
import dayjs from '~/shared/utils/dayjs';
import { capitalize } from 'lodash-es';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo, useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import {
  blockedCustomModels,
  goBack,
  minsToHours,
} from '~/components/Training/Form/TrainingCommon';
import {
  type NumberTrainingSettingsType,
  trainingSettings,
} from '~/components/Training/Form/TrainingParams';
import { AdvancedSettings } from '~/components/Training/Form/TrainingSubmitAdvancedSettings';
import { ModelSelect } from '~/components/Training/Form/TrainingSubmitModelSelect';
import { useTrainingServiceStatus } from '~/components/Training/training.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import type { ModelFileCreateInput } from '~/server/schema/model-file.schema';
import type {
  ModelVersionUpsertInput,
  TrainingDetailsBaseModelList,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import type { ImageTrainingRouterWhatIfSchema } from '~/server/schema/orchestrator/training.schema';
import { Currency, ModelUploadType, TrainingStatus } from '~/shared/utils/prisma/enums';
import {
  defaultRun,
  defaultRunVideo,
  defaultTrainingState,
  defaultTrainingStateVideo,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import type { TrainingModelData } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import {
  getTrainingFields,
  getAiToolkitEcosystem,
  getAiToolkitModelVariant,
  isInvalidRapid,
  isInvalidAiToolkit,
  isSamplePromptsRequired,
  isValidRapid,
  rapidEta,
  type TrainingBaseModelType,
  trainingModelInfo,
} from '~/utils/training';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';

const maxRuns = 5;

const prefersCaptions: TrainingBaseModelType[] = [
  'flux',
  'flux2',
  'sd35',
  'hunyuan',
  'wan',
  'chroma',
  'zimage',
];

export const TrainingFormSubmit = ({ model }: { model: NonNullable<TrainingModelData> }) => {
  const thisModelVersion = model.modelVersions[0];
  const thisTrainingDetails = thisModelVersion.trainingDetails as TrainingDetailsObj | undefined;
  const thisFile = thisModelVersion.files[0];
  const thisMetadata = thisFile?.metadata as FileMetadata | null;
  const thisNumImages = thisMetadata?.numImages;
  const thisMediaType = thisTrainingDetails?.mediaType ?? 'image';
  const availableBuzzTypes = useAvailableBuzz(['blue']);

  const { addRun, removeRun, updateRun } = trainingStore;
  const { runs } = useTrainingImageStore(
    (state) =>
      state[model.id] ?? {
        ...(thisMediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
      }
  );

  const [selectedRunIndex, setSelectedRunIndex] = useState<number>(0);
  const selectedRun =
    runs[selectedRunIndex] ?? (thisMediaType === 'video' ? defaultRunVideo : defaultRun);

  const allLabeled =
    thisMediaType === 'video' ? (thisMetadata?.numCaptions ?? 0) >= (thisNumImages ?? 0) : true;

  const [multiMode, setMultiMode] = useState(runs.length > 1);
  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);

  const status = useTrainingServiceStatus();
  const blockedModels = status.blockedModels ?? blockedCustomModels;

  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to train this model. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to complete the training process.`,
    performTransactionOnPurchase: false,
    purchaseSuccessMessage: (purchasedBalance) => (
      <Stack>
        <Text>Thank you for your purchase!</Text>
        <Text>
          We have added <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasedBalance} /> to
          your account. You can now continue the training process.
        </Text>
      </Stack>
    ),
    accountTypes: availableBuzzTypes,
  });

  const thisStep = 3;
  let finishedRuns = 0;

  const formBaseModel = selectedRun.base;

  const targetStepsSetting = trainingSettings.find((ts) => ts.name === 'targetSteps') as
    | NumberTrainingSettingsType
    | undefined;
  const override =
    targetStepsSetting?.overrides?.[formBaseModel]?.all ??
    targetStepsSetting?.overrides?.[formBaseModel]?.[selectedRun.params.engine];
  const maxSteps = override?.max ?? targetStepsSetting?.max ?? 10000;

  const hasIssue = runs.some((r) => r.hasIssue);
  const totalBuzzCost = hasIssue ? -1 : runs.map((r) => r.buzzCost).reduce((s, a) => s + a, 0);

  const whatIfData = useMemo(() => {
    const baseData = {
      model: getTrainingFields.getModel(formBaseModel),
      priority: getTrainingFields.getPriority(selectedRun.highPriority),
      engine: getTrainingFields.getEngine(selectedRun.params.engine),
      trainingDataImagesCount: thisNumImages ?? 1,
    };

    // Transform parameters for AI Toolkit
    if (selectedRun.params.engine === 'ai-toolkit') {
      const ecosystem = getAiToolkitEcosystem(formBaseModel);
      const modelVariant = getAiToolkitModelVariant(formBaseModel as TrainingDetailsBaseModelList);

      if (!ecosystem) {
        console.error('Failed to determine ecosystem for AI Toolkt whatIf query');
        return null;
      }

      // Transform lrScheduler: 'cosine_with_restarts' -> 'cosine' (AI Toolkit doesn't support restarts)
      let lrScheduler = selectedRun.params.lrScheduler;
      if (lrScheduler === 'cosine_with_restarts') {
        lrScheduler = 'cosine';
      }

      // Transform optimizerType: 'AdamW8Bit' -> 'adamw8bit', 'Prodigy' -> 'prodigy', etc.
      const optimizerTypeMap: Record<string, string> = {
        AdamW8Bit: 'adamw8bit',
        Adafactor: 'adafactor',
        Prodigy: 'prodigy',
      };
      const optimizerType =
        optimizerTypeMap[selectedRun.params.optimizerType] ||
        selectedRun.params.optimizerType.toLowerCase();

      const retData: ImageTrainingRouterWhatIfSchema = {
        ...baseData,
        ecosystem,
        ...(modelVariant && { modelVariant }),
        epochs: selectedRun.params.maxTrainEpochs,
        resolution: selectedRun.params.resolution,
        lr: selectedRun.params.unetLR,
        textEncoderLr: selectedRun.params.textEncoderLR || null,
        trainTextEncoder: !!selectedRun.params.textEncoderLR,
        lrScheduler: lrScheduler as any,
        optimizerType: optimizerType as any,
        networkDim: selectedRun.params.networkDim,
        networkAlpha: selectedRun.params.networkAlpha,
        noiseOffset: selectedRun.params.noiseOffset || null,
        minSnrGamma: selectedRun.params.minSnrGamma || null,
        flipAugmentation: selectedRun.params.flipAugmentation || false,
        shuffleTokens: selectedRun.params.shuffleCaption,
        keepTokens: selectedRun.params.keepTokens,
      } as any;
      return retData;
    }

    // Kohya-style parameters for other engines
    const retData: ImageTrainingRouterWhatIfSchema = {
      model: baseData.model,
      priority: baseData.priority,
      engine: baseData.engine as any, // Type assertion for discriminated union
      trainingDataImagesCount: baseData.trainingDataImagesCount,
      resolution: selectedRun.params.resolution,
      trainBatchSize: selectedRun.params.trainBatchSize,
      maxTrainEpochs: selectedRun.params.maxTrainEpochs,
      numRepeats: selectedRun.params.numRepeats ?? 200,
    };
    return retData;
  }, [
    formBaseModel,
    selectedRun.highPriority,
    selectedRun.params.engine,
    thisNumImages,
    selectedRun.params.resolution,
    selectedRun.params.trainBatchSize,
    selectedRun.params.maxTrainEpochs,
    selectedRun.params.numRepeats,
    selectedRun.params.unetLR,
    selectedRun.params.textEncoderLR,
    selectedRun.params.lrScheduler,
    selectedRun.params.optimizerType,
    selectedRun.params.networkDim,
    selectedRun.params.networkAlpha,
    selectedRun.params.noiseOffset,
    selectedRun.params.minSnrGamma,
    selectedRun.params.flipAugmentation,
    selectedRun.params.shuffleCaption,
    selectedRun.params.keepTokens,
  ]);

  const [debounced] = useDebouncedValue(whatIfData, 100);

  const dryRunResult = trpc.orchestrator.createTrainingWhatif.useQuery(debounced!, {
    enabled: !!debounced,
  });

  useEffect(() => {
    if (dryRunResult.isLoading) return;
    const cost = dryRunResult.data?.cost;
    if (!isDefined(cost) || cost < 0) {
      if (!selectedRun.hasIssue) {
        updateRun(model.id, thisMediaType, selectedRun.id, { hasIssue: true, buzzCost: -1 });
        showErrorNotification({
          title: 'Error computing cost',
          error: new Error(
            'There was an issue computing the cost for these settings. Please change your settings or contact us if this persists.'
          ),
          autoClose: false,
        });
      }
    } else if (cost !== selectedRun.buzzCost) {
      updateRun(model.id, thisMediaType, selectedRun.id, { hasIssue: false, buzzCost: cost });
    }
  }, [
    dryRunResult.data?.cost,
    dryRunResult.isLoading,
    runs.length,
    selectedRun.hasIssue,
    selectedRun.buzzCost,
    model.id,
    thisMediaType,
    selectedRun.id,
    updateRun,
  ]);

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation();
  const deleteVersionMutation = trpc.modelVersion.delete.useMutation();
  const createFileMutation = trpc.modelFile.create.useMutation();

  const doTraining = trpc.orchestrator.createTraining.useMutation();

  const doTrainingMut = async (modelVersionId: number, idx: number, runId: number) => {
    try {
      await doTraining.mutateAsync({ modelVersionId });

      finishedRuns++;

      // TODO update notification instead
      showSuccessNotification({
        message: `Submitted ${finishedRuns}/${runs.length} runs...`,
      });

      // TODO re-enable this, but for now it messes with the length
      // removeRun(model.id, runId);

      if (finishedRuns === runs.length) {
        showSuccessNotification({
          title: 'Successfully submitted for training!',
          message: 'You will be emailed when training is complete.',
        });
        // TODO make this a setInfiniteData, too much work right now
        await queryUtils.model.getMyTrainingModels.invalidate();
        await queryUtils.model.getAvailableTrainingModels.invalidate();

        await router.replace(userTrainingDashboardURL);
        setAwaitInvalidate(false);
      }
    } catch (e) {
      const error = e as TRPCClientErrorBase<DefaultErrorShape>;
      showErrorNotification({
        title: `Failed to submit run #${idx + 1} for training`,
        error: new Error(error.message),
        reason: error.message ?? 'An unexpected error occurred. Please try again later.',
        autoClose: false,
      });

      if (idx > 0) {
        await deleteVersionMutation.mutateAsync({ id: modelVersionId });
      }

      finishedRuns++;
      if (finishedRuns === runs.length) {
        setAwaitInvalidate(false);
      }
    }
  };

  const userTrainingDashboardURL = `/user/${currentUser?.username}/models?section=training`;

  const handleSubmit = () => {
    // TODO [bw] we should probably disallow people to get to the training wizard at all when it's not pending
    if (thisModelVersion.trainingStatus !== TrainingStatus.Pending) {
      showNotification({
        message: 'Model was already submitted for training.',
      });
      router.replace(userTrainingDashboardURL).then();
      return;
    }

    if (!thisFile) {
      showErrorNotification({
        error: new Error('Missing file data, please reupload your files.'),
        autoClose: false,
      });
      return;
    }

    if (runs.length > maxRuns) {
      showErrorNotification({
        error: new Error(`Too many runs selected (max of ${maxRuns})`),
        autoClose: false,
      });
      return;
    }

    for (const r of runs) {
      if (!r.base) {
        showErrorNotification({
          error: new Error('A base model must be chosen.'),
          autoClose: false,
        });
        return;
      }

      if (blockedModels.includes(r.base)) {
        showErrorNotification({
          error: new Error('This model has been blocked from training - please try another one.'),
          autoClose: false,
        });
        return;
      }

      if (r.baseType === 'chroma' && (!r.negativePrompt || !r.negativePrompt.trim())) {
        showErrorNotification({
          error: new Error('A negative prompt is required for Chroma training.'),
          autoClose: false,
        });
        return;
      }

      if (isSamplePromptsRequired(r.baseType, r.params.engine)) {
        const numPromptsNeeded = 1;
        const filledPrompts = r.samplePrompts.filter((p) => p && p.trim().length > 0);

        if (filledPrompts.length < numPromptsNeeded) {
          showErrorNotification({
            error: new Error(
              `This model requires at least ${numPromptsNeeded} sample prompt(s) to train.`
            ),
            title: 'Sample prompts required',
            autoClose: false,
          });
          return;
        }
      }

      if (r.params.targetSteps > maxSteps) {
        showErrorNotification({
          error: new Error(
            `Steps are beyond the maximum (${numberWithCommas(
              maxSteps
            )}). Please lower Epochs or Num Repeats, or increase Train Batch Size.`
          ),
          title: 'Too many steps',
          autoClose: false,
        });
        return;
      }

      // specific check for batch
      if (
        ['flux', 'sd35'].includes(r.baseType) &&
        r.params.engine === 'kohya' &&
        r.params.trainBatchSize > 2 &&
        r.params.resolution > 512
      ) {
        showErrorNotification({
          error: new Error(
            `Due to hardware constraints, batch sizes >2 are not supported for resolutions >512. Please lower the batch size (this will affect steps) or decrease the resolution.`
          ),
          title: 'Batch size too high',
          autoClose: false,
        });
        return;
      }
    }

    const performTransaction = () => {
      return openConfirmModal({
        title: 'Confirm Buzz Transaction',
        children: (
          <Stack pt="md">
            <Group>
              <Text span inline>
                {`The total cost for ${
                  runs.length > 1 ? 'these training runs' : 'this training run'
                } is: `}
              </Text>
              <Group gap={2}>
                <CurrencyIcon currency={Currency.BUZZ} size={12} />
                <Text span inline>
                  {totalBuzzCost.toLocaleString()}
                </Text>
              </Group>
            </Group>
            <Text mt="md">Proceed?</Text>
          </Stack>
        ),
        labels: { cancel: 'Cancel', confirm: 'Confirm' },
        centered: true,
        onConfirm: () => {
          handleConfirm();
        },
      });
    };

    conditionalPerformTransaction(totalBuzzCost, performTransaction);
  };

  const handleConfirm = () => {
    setAwaitInvalidate(true);
    finishedRuns = 0;

    runs.forEach(async (run, idx) => {
      const {
        base,
        baseType,
        params,
        customModel,
        samplePrompts,
        negativePrompt,
        staging,
        highPriority,
      } = run;
      const { optimizerArgs, ...paramData } = params;

      if (isInvalidRapid(baseType, paramData.engine)) {
        showErrorNotification({
          error: new Error('Cannot use Rapid Training with a non-flux base model.'),
          title: `Parameter error`,
          autoClose: false,
        });
        // TODO ideally, mark this as errored and don't leave the screen
        finishedRuns++;
        if (finishedRuns === runs.length) setAwaitInvalidate(false);
        return;
      }

      if (isInvalidAiToolkit(baseType, paramData.engine)) {
        showErrorNotification({
          error: new Error('AI Toolkit training is not supported for this model.'),
          title: `Parameter error`,
          autoClose: false,
        });
        finishedRuns++;
        if (finishedRuns === runs.length) setAwaitInvalidate(false);
        return;
      }

      // Transform params for AI Toolkit if needed
      let finalParams: any = paramData;
      if (paramData.engine === 'ai-toolkit') {
        const ecosystem = getAiToolkitEcosystem(base);
        const modelVariant = getAiToolkitModelVariant(base as TrainingDetailsBaseModelList);

        if (!ecosystem) {
          showErrorNotification({
            error: new Error('Failed to determine ecosystem for AI Toolkit training.'),
            title: `Parameter error`,
            autoClose: false,
          });
          finishedRuns++;
          if (finishedRuns === runs.length) setAwaitInvalidate(false);
          return;
        }

        // Transform lrScheduler
        let lrScheduler = paramData.lrScheduler;
        if (lrScheduler === 'cosine_with_restarts') {
          lrScheduler = 'cosine';
        }

        // Transform optimizerType
        const optimizerTypeMap: Record<string, string> = {
          AdamW8Bit: 'adamw8bit',
          Adafactor: 'adafactor',
          Prodigy: 'prodigy',
        };
        const optimizerType =
          optimizerTypeMap[paramData.optimizerType] || paramData.optimizerType.toLowerCase();

        finalParams = {
          engine: 'ai-toolkit',
          ecosystem,
          ...(modelVariant && { modelVariant }),
          epochs: paramData.maxTrainEpochs,
          resolution: paramData.resolution,
          lr: paramData.unetLR,
          textEncoderLr: paramData.textEncoderLR || null,
          trainTextEncoder: !!paramData.textEncoderLR,
          lrScheduler: lrScheduler as any,
          optimizerType: optimizerType as any,
          networkDim: paramData.networkDim,
          networkAlpha: paramData.networkAlpha,
          noiseOffset: paramData.noiseOffset || null,
          minSnrGamma: paramData.minSnrGamma || null,
          flipAugmentation: paramData.flipAugmentation || false,
          shuffleTokens: paramData.shuffleCaption,
          keepTokens: paramData.keepTokens,
        };
      }

      const baseModelConvert: BaseModel =
        (customModel?.baseModel as BaseModel | undefined) ??
        trainingModelInfo[base as TrainingDetailsBaseModelList]?.baseModel ??
        'SD 1.5';

      // TODO there is a bug here where if >1 fails and then get resubmitted, the idx will be 0
      //  and thus overwrites the first version...

      // update the first one since it exists, or create for others
      const versionMutateData: ModelVersionUpsertInput = {
        ...(idx === 0 && { id: thisModelVersion.id }),
        name: `V${idx + 1}`,
        modelId: model.id,
        baseModel: baseModelConvert,
        trainedWords: thisModelVersion.trainedWords ?? [],
        // ---
        epochs: paramData.maxTrainEpochs,
        steps: paramData.targetSteps,
        clipSkip: paramData.clipSkip || undefined,
        trainingDetails: {
          ...((thisModelVersion.trainingDetails as TrainingDetailsObj) ?? {}),
          baseModel: base,
          baseModelType: baseType,
          params: finalParams, // Store in the native format (Kohya or AI Toolkit)
          samplePrompts,
          ...(negativePrompt && { negativePrompt }),
          staging,
          highPriority,
        },
        uploadType: ModelUploadType.Trained,
      };

      try {
        const response = await upsertVersionMutation.mutateAsync(versionMutateData);
        const newVersionId = response.id;

        if (idx === 0) {
          await doTrainingMut(newVersionId, idx, run.id);
        } else {
          try {
            const fileMutateData: ModelFileCreateInput = {
              name: `${newVersionId}_training_data.zip`,
              url: thisFile.url,
              sizeKB: thisFile.sizeKB,
              type: 'Training Data',
              modelVersionId: newVersionId,
              visibility: thisFile.visibility,
              metadata: thisMetadata!,
            };

            const fileResponse = await createFileMutation.mutateAsync(fileMutateData);
            const fileModelVersionId = fileResponse.modelVersion.id;

            await doTrainingMut(fileModelVersionId, idx, run.id);
          } catch (e) {
            const error = e as TRPCClientErrorBase<DefaultErrorShape>;
            showErrorNotification({
              error: new Error(error.message),
              title: `Failed to create model file for run #${idx + 1}`,
              autoClose: false,
            });
            // TODO ideally, mark this as errored and don't leave the screen
            finishedRuns++;
            if (finishedRuns === runs.length) setAwaitInvalidate(false);
          }
        }
      } catch (e) {
        const error = e as TRPCClientErrorBase<DefaultErrorShape>;
        showErrorNotification({
          error: new Error(error.message),
          title: `Failed to save model version info for run #${idx + 1}`,
          autoClose: false,
        });
        // TODO ideally, mark this as errored and don't leave the screen
        finishedRuns++;
        if (finishedRuns === runs.length) setAwaitInvalidate(false);
      }
    });
  };

  // HARD CODED FOR THIS RUN:
  const discountEndDate = dayjs().month(9).year(2024).endOf('month');

  return (
    <Stack>
      {/* {discountInfo.amt !== 0 && ( */}
      {discountEndDate.isAfter(dayjs()) && (
        <DismissibleAlert
          id={`training-discount`}
          icon={<IconConfetti />}
          color="pink"
          content={
            <Text>
              Flux-Dev Rapid is currently <b>25%</b> off! (Ends on{' '}
              {discountEndDate.toDate().toLocaleDateString('en-us', {
                weekday: 'long',
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
              )
            </Text>
          }
        />
      )}
      {/* )} */}
      <Accordion
        variant="separated"
        defaultValue={'model-details'}
        classNames={{
          content: 'p-0',
          item: 'overflow-hidden shadow-sm border-gray-3 dark:border-dark-4',
          control: 'p-2',
        }}
      >
        <Accordion.Item value="model-details">
          <Accordion.Control>Model Details</Accordion.Control>
          <Accordion.Panel>
            <DescriptionTable
              labelWidth="150px"
              items={[
                { label: 'Name', value: model.name },
                { label: 'Type', value: thisTrainingDetails?.type ?? '(unknown)' },
                {
                  label: 'Files',
                  value: thisNumImages || 0,
                },
                {
                  label: 'Labels',
                  value: thisMetadata?.numCaptions || 0,
                },
                {
                  label: 'Label Type',
                  value: capitalize(thisMetadata?.labelType ?? 'tag'),
                },
              ]}
            />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <Switch
        label={
          <Group gap={4}>
            <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
              Submit up to {maxRuns} training runs at once.
              <br />
              You can use different base models and/or parameters, all trained on the same dataset.
              Each will be created as their own version.
            </InfoPopover>
            <Text inherit>Show Multi Training</Text>
          </Group>
        }
        labelPosition="left"
        checked={multiMode}
        mt="md"
        disabled={runs.length > 1}
        onChange={(event) => setMultiMode(event.currentTarget.checked)}
      />

      <Stack
        className={clsx(
          'sticky top-0 z-10 mb-[-5px] bg-white pb-[5px] dark:bg-dark-7',
          !multiMode && 'hidden'
        )}
      >
        <Group mt="md" justify="space-between" wrap="nowrap">
          <Title order={5}>Training Runs</Title>
          <Group gap="xs" ml="sm">
            <Button
              color="green"
              variant="light"
              size="compact-sm"
              leftSection={<IconPlus size={16} />}
              disabled={runs.length >= maxRuns}
              onClick={() => {
                addRun(model.id, thisMediaType);
                setSelectedRunIndex(runs.length);
              }}
              classNames={{ section: 'mr-2' }}
            >
              Add
            </Button>
            <Button
              color="cyan"
              variant="light"
              size="compact-sm"
              leftSection={<IconCopy size={16} />}
              disabled={runs.length >= maxRuns}
              onClick={() => {
                addRun(model.id, thisMediaType, selectedRun);
                setSelectedRunIndex(runs.length);
              }}
              classNames={{ section: 'mr-2' }}
            >
              Duplicate
            </Button>
            <Button
              color="red"
              variant="light"
              size="compact-sm"
              leftSection={<IconX size={16} />}
              disabled={runs.length <= 1}
              onClick={() => {
                removeRun(model.id, thisMediaType, selectedRun.id);
                setSelectedRunIndex(0);
              }}
              classNames={{ section: 'mr-2' }}
            >
              Remove
            </Button>
          </Group>
        </Group>

        <SegmentedControl
          className="overflow-auto"
          data={runs.map((run, idx) => ({
            label: `Run #${idx + 1} (${
              !!run.customModel
                ? 'Custom'
                : trainingModelInfo[run.base as TrainingDetailsBaseModelList]?.pretty ?? 'Unknown'
            })`,
            // value: run.id.toString(),
            value: idx.toString(),
          }))}
          value={selectedRunIndex.toString()}
          onChange={(value) => {
            // const run = runs.find((r) => r.id === Number(value));
            setSelectedRunIndex(Number(value));
          }}
        />

        <Divider />
      </Stack>

      <ModelSelect
        selectedRun={selectedRun}
        modelId={model.id}
        mediaType={thisMediaType}
        numImages={thisNumImages}
      />

      {prefersCaptions.includes(selectedRun.baseType) &&
        thisMetadata?.labelType !== 'caption' &&
        (thisMetadata?.numCaptions ?? 0) > 0 && (
          <AlertWithIcon
            icon={<IconAlertTriangle size={16} />}
            iconColor="yellow"
            radius={0}
            size="md"
            color="yellow"
            mt="sm"
          >
            <Group gap="sm" justify="space-between" wrap="nowrap">
              <Text>
                You have &quot;tagged&quot; files, but{' '}
                {selectedRun.base in trainingModelInfo ? (
                  <Badge color="red">
                    {trainingModelInfo[selectedRun.base as TrainingDetailsBaseModelList]?.pretty ??
                      'this model'}
                  </Badge>
                ) : (
                  'this model'
                )}{' '}
                works best with &quot;captions&quot;.
              </Text>
              <Button onClick={() => goBack(model.id, thisStep)}>Go back and fix</Button>
            </Group>
          </AlertWithIcon>
        )}

      {!prefersCaptions.includes(selectedRun.baseType) &&
        thisMetadata?.labelType !== 'tag' &&
        (thisMetadata?.numCaptions ?? 0) > 0 && (
          <AlertWithIcon
            icon={<IconAlertTriangle size={16} />}
            iconColor="yellow"
            radius={0}
            size="md"
            color="yellow"
            mt="sm"
          >
            <Group gap="sm" justify="space-between" wrap="nowrap">
              <Text>
                You have &quot;captioned&quot; files, but{' '}
                {selectedRun.base in trainingModelInfo ? (
                  <Badge color="violet">
                    {trainingModelInfo[selectedRun.base as TrainingDetailsBaseModelList]?.pretty ??
                      'this model'}
                  </Badge>
                ) : (
                  'this model'
                )}{' '}
                works best with &quot;tags&quot;.
              </Text>
              <Button onClick={() => goBack(model.id, thisStep)}>Go back and fix</Button>
            </Group>
          </AlertWithIcon>
        )}

      {!allLabeled && (
        <AlertWithIcon
          icon={<IconAlertTriangle size={16} />}
          iconColor="yellow"
          radius={0}
          size="md"
          color="yellow"
          mt="sm"
        >
          <Group gap="sm" justify="space-between" wrap="nowrap">
            <Text>Video training requires that all files are labeled.</Text>
            <Button onClick={() => goBack(model.id, thisStep)}>Go back and fix</Button>
          </Group>
        </AlertWithIcon>
      )}

      {selectedRun.baseType === 'zimage' && (
        <AlertWithIcon
          icon={<IconAlertTriangle size={16} />}
          iconColor="yellow"
          radius={0}
          size="md"
          color="yellow"
          mt="sm"
        >
          <Group gap="sm" justify="space-between" wrap="nowrap">
            <Text>
              Z&ndash;Image training is experimental, and we're still fine-tuning things behind the
              scenes{' '}
            </Text>
          </Group>
        </AlertWithIcon>
      )}

      {formBaseModel && (
        <>
          <AdvancedSettings
            modelId={model.id}
            mediaType={thisMediaType}
            selectedRun={selectedRun}
            maxSteps={maxSteps}
            numImages={thisNumImages}
          />

          {(!isValidRapid(selectedRun.baseType, selectedRun.params.engine) ||
            currentUser?.isModerator) && (
            <Group mt="lg">
              {!isValidRapid(selectedRun.baseType, selectedRun.params.engine) && (
                <Switch
                  label={
                    <Group gap={4} wrap="nowrap">
                      <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
                        Jump to the front of the training queue and ensure that your training run is
                        uninterrupted.
                      </InfoPopover>
                      <Text inherit>High Priority</Text>
                    </Group>
                  }
                  labelPosition="left"
                  checked={selectedRun.highPriority}
                  onChange={(event) =>
                    updateRun(model.id, thisMediaType, selectedRun.id, {
                      highPriority: event.currentTarget.checked,
                    })
                  }
                />
              )}
              {currentUser?.isModerator && (
                <Switch
                  label="Test Mode"
                  labelPosition="left"
                  checked={selectedRun.staging}
                  onChange={(event) =>
                    updateRun(model.id, thisMediaType, selectedRun.id, {
                      staging: event.currentTarget.checked,
                    })
                  }
                />
              )}
            </Group>
          )}
          <Paper
            shadow="xs"
            radius="sm"
            mt="md"
            w="fit-content"
            px="md"
            py="xs"
            className="self-end bg-gray-0 dark:bg-dark-6"
          >
            <Group gap="sm">
              <Badge>
                <Group gap={4} wrap="nowrap">
                  <Text inherit>Queue</Text>
                  <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }} withinPortal>
                    <Text size="sm">How many jobs are in the queue before you</Text>
                  </InfoPopover>
                </Group>
              </Badge>

              {dryRunResult.isLoading ? (
                <Loader size="sm" />
              ) : (
                <Text>{dryRunResult.data?.precedingJobs ?? 'Unknown'}</Text>
              )}

              <Divider orientation="vertical" />

              <Badge>
                <Group gap={4} wrap="nowrap">
                  <Text inherit>ETA</Text>
                  <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }} withinPortal>
                    <Text size="sm">How long your job is expected to run</Text>
                  </InfoPopover>
                </Group>
              </Badge>

              {isValidRapid(selectedRun.baseType, selectedRun.params.engine) ? (
                <Text>{minsToHours(rapidEta)}</Text>
              ) : dryRunResult.isLoading ? (
                <Loader size="sm" />
              ) : (
                <Text>
                  {!isDefined(dryRunResult.data?.eta)
                    ? 'Unknown'
                    : dryRunResult.data?.eta > 20000
                    ? 'Forever'
                    : minsToHours(dryRunResult.data?.eta)}
                </Text>
              )}

              <Divider orientation="vertical" />

              <Badge>Cost</Badge>
              {dryRunResult.isLoading ? (
                <Loader size="sm" />
              ) : !isDefined(dryRunResult.data?.cost) || selectedRun.hasIssue ? (
                <Text>Error</Text>
              ) : (
                <CurrencyBadge
                  currency={Currency.BUZZ}
                  unitAmount={dryRunResult.data.cost}
                  displayCurrency={false}
                />
              )}
            </Group>
          </Paper>
        </>
      )}

      <Divider mt="md" />

      <Group mt="lg" justify="flex-end">
        <Button variant="default" onClick={() => goBack(model.id, thisStep)}>
          Back
        </Button>
        <BuzzTransactionButton
          loading={awaitInvalidate || dryRunResult.isLoading}
          disabled={
            blockedModels.includes(formBaseModel ?? '') ||
            !status.available ||
            !allLabeled ||
            awaitInvalidate ||
            dryRunResult.isLoading
          }
          label={`Submit${runs.length > 1 ? ` (${runs.length} runs)` : ''}`}
          buzzAmount={totalBuzzCost}
          accountTypes={availableBuzzTypes}
          onPerformTransaction={handleSubmit}
          error={hasIssue ? 'Error computing cost' : undefined}
          showTypePct
        />
      </Group>
    </Stack>
  );
};
