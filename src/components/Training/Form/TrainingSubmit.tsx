import {
  Accordion,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  createStyles,
  Divider,
  Group,
  Input,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { showNotification } from '@mantine/notifications';
import { Currency, ModelType, TrainingStatus } from '@prisma/client';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCopy,
  IconExclamationCircle,
  IconExclamationMark,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import dayjs from 'dayjs';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CivitaiTooltip } from '~/components/CivitaiWrapped/CivitaiTooltip';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { ResourceSelect } from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import {
  blockedCustomModels,
  getPrecision,
  goBack,
  isTrainingCustomModel,
  minsToHours,
} from '~/components/Training/Form/TrainingCommon';
import {
  type NumberTrainingSettingsType,
  optimizerArgMap,
  trainingSettings,
} from '~/components/Training/Form/TrainingParams';
import { useTrainingServiceStatus } from '~/components/Training/training.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';
import { TextInputWrapper } from '~/libs/form/components/TextInputWrapper';
import { BaseModel, baseModelSets } from '~/server/common/constants';
import { ModelFileCreateInput } from '~/server/schema/model-file.schema';
import {
  ModelVersionUpsertInput,
  TrainingDetailsBaseModel,
  TrainingDetailsBaseModel15,
  trainingDetailsBaseModels15,
  trainingDetailsBaseModelsXL,
  TrainingDetailsBaseModelXL,
  TrainingDetailsObj,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { Generation } from '~/server/services/generation/generation.types';
import {
  defaultBase,
  defaultBaseType,
  defaultRun,
  defaultTrainingState,
  TrainingRunUpdate,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import { TrainingModelData } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { calcBuzzFromEta, calcEta } from '~/utils/training';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const baseModelDescriptions: {
  [key in TrainingDetailsBaseModel]: { label: string; type: string; description: string };
} = {
  sd_1_5: { label: 'Standard', type: '15', description: 'Useful for all purposes.' },
  anime: { label: 'Anime', type: '15', description: 'Results will have an anime aesthetic.' },
  semi: {
    label: 'Semi-realistic',
    type: '15',
    description: 'Results will be a blend of anime and realism.',
  },
  realistic: {
    label: 'Realistic',
    type: '15',
    description: 'Results will be extremely realistic.',
  },
  sdxl: { label: 'Standard', type: 'XL', description: 'Useful for all purposes, and uses SDXL.' },
  pony: {
    label: 'Pony',
    type: 'XL',
    description: 'Results tailored to visuals of various anthro, feral, or humanoid species.',
  },
};

const maxRuns = 5;
const maxSteps =
  (trainingSettings.find((ts) => ts.name === 'targetSteps') as NumberTrainingSettingsType).max ??
  10000;

const useStyles = createStyles((theme) => ({
  segControl: {
    root: {
      border: `1px solid ${
        theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
      }`,
      background: 'none',
      flexWrap: 'wrap',
    },
    label: {
      paddingLeft: theme.spacing.sm,
      paddingRight: theme.spacing.sm,
    },
  },
  sticky: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
    position: 'sticky',
    top: 0,
    zIndex: 5,
    marginBottom: '-5px',
    paddingBottom: '5px',
  },
}));

export const TrainingFormSubmit = ({ model }: { model: NonNullable<TrainingModelData> }) => {
  const thisModelVersion = model.modelVersions[0];
  const thisTrainingDetails = thisModelVersion.trainingDetails as TrainingDetailsObj | undefined;
  const thisFile = thisModelVersion.files[0];
  const thisMetadata = thisFile?.metadata as FileMetadata | null;

  const { addRun, removeRun, updateRun } = trainingStore;
  const { runs } = useTrainingImageStore((state) => state[model.id] ?? { ...defaultTrainingState });

  const [selectedRunIndex, setSelectedRunIndex] = useState<number>(0);
  const selectedRun = runs[selectedRunIndex] ?? defaultRun;

  const [openedSections, setOpenedSections] = useState<string[]>([]);
  const [etaMins, setEtaMins] = useState<number | undefined>(undefined);
  // const [debouncedEtaMins] = useDebouncedValue(etaMins, 2000);
  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);

  const status = useTrainingServiceStatus();
  const blockedModels = status.blockedModels ?? [blockedCustomModels];

  const { classes } = useStyles();
  const theme = useMantineTheme();
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const { balance } = useBuzz();
  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to train this model. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to complete the training process.`,
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
  });

  const thisStep = 3;
  let finishedRuns = 0;

  const formBaseModel = selectedRun.base;
  const formBaseModelType = selectedRun.baseType;
  const baseModel15 =
    !!formBaseModel &&
    (trainingDetailsBaseModels15 as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelXL =
    !!formBaseModel &&
    (trainingDetailsBaseModelsXL as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;

  const buzzCost = runs.map((r) => r.buzzCost).reduce((s, a) => s + a, 0);

  // Use functions to set proper starting values based on metadata
  useEffect(() => {
    if (selectedRun.params.numRepeats === undefined) {
      const numRepeats = Math.max(
        1,
        Math.min(5000, Math.ceil(200 / (thisMetadata?.numImages || 1)))
      );
      updateRun(model.id, selectedRun.id, { params: { numRepeats } });
    }
  }, [selectedRun.id, thisMetadata?.numImages]);

  // Set targetSteps automatically on value changes
  useEffect(() => {
    const { maxTrainEpochs, numRepeats, trainBatchSize } = selectedRun.params;

    const newSteps = Math.ceil(
      ((thisMetadata?.numImages || 1) * (numRepeats ?? 200) * maxTrainEpochs) / trainBatchSize
    );

    // if (newSteps > maxSteps) {
    //   showErrorNotification({
    //     error: new Error(
    //       `Steps are beyond the maximum (${numberWithCommas(maxSteps)}. Please lower Epochs or Num Repeats, or increase Train Batch Size.`
    //     ),
    //     title: 'Too many steps',
    //   });
    // }

    if (selectedRun.params.targetSteps !== newSteps) {
      updateRun(model.id, selectedRun.id, {
        params: { targetSteps: newSteps },
      });
    }
  }, [
    selectedRun.params.maxTrainEpochs,
    selectedRun.params.numRepeats,
    selectedRun.params.trainBatchSize,
    thisMetadata?.numImages,
  ]);

  // Calc ETA and Cost
  useEffect(() => {
    const eta = calcEta({
      cost: status.cost,
      baseModel: formBaseModelType,
      targetSteps: selectedRun.params.targetSteps,
    });
    const isCustom = isTrainingCustomModel(formBaseModel);
    const price = calcBuzzFromEta({
      cost: status.cost,
      eta,
      isCustom,
      isPriority: selectedRun.highPriority ?? false,
    });
    setEtaMins(eta);
    if (price !== selectedRun.buzzCost) {
      updateRun(model.id, selectedRun.id, { buzzCost: price });
    }
  }, [
    selectedRun.params.targetSteps,
    selectedRun.highPriority,
    formBaseModel,
    formBaseModelType,
    status.cost,
  ]);

  // TODO there is some bug with the optimizer being blank...

  // Adjust optimizer and related settings
  useEffect(() => {
    const newOptimizerArgs = optimizerArgMap[selectedRun.params.optimizerType] ?? '';

    const newScheduler =
      selectedRun.params.optimizerType === 'Prodigy' &&
      selectedRun.params.lrScheduler === 'cosine_with_restarts'
        ? 'cosine'
        : selectedRun.params.lrScheduler;

    if (
      newOptimizerArgs !== selectedRun.params.optimizerArgs ||
      newScheduler !== selectedRun.params.lrScheduler
    ) {
      updateRun(model.id, selectedRun.id, {
        params: { optimizerArgs: newOptimizerArgs, lrScheduler: newScheduler },
      });
    }
  }, [selectedRun.params.optimizerType]);

  // - Apply default params with overrides and calculations upon base model selection
  const makeDefaultParams = (data: TrainingRunUpdate) => {
    const defaultParams = trainingSettings.reduce(
      (a, v) => ({
        ...a,
        [v.name]: v.overrides?.[data.base!]?.default ?? v.default,
      }),
      {} as TrainingDetailsParams
    );

    defaultParams.numRepeats = Math.max(
      1,
      Math.min(5000, Math.ceil(200 / (thisMetadata?.numImages || 1)))
    );

    defaultParams.targetSteps = Math.ceil(
      ((thisMetadata?.numImages || 1) * defaultParams.numRepeats * defaultParams.maxTrainEpochs) /
        defaultParams.trainBatchSize
    );

    updateRun(model.id, selectedRun.id, { params: { ...defaultParams }, ...data });
  };

  const { data: dryRunData, isFetching: dryRunLoading } =
    trpc.training.createRequestDryRun.useQuery(
      {
        baseModel: formBaseModel,
        isPriority: selectedRun.highPriority,
        // cost: debouncedEtaMins,
      },
      {
        refetchInterval: 1000 * 60,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        staleTime: 1000 * 60,
        enabled: !!formBaseModel,
      }
    );

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation();
  const deleteVersionMutation = trpc.modelVersion.delete.useMutation();
  const createFileMutation = trpc.modelFile.create.useMutation();
  const doTraining = trpc.training.createRequest.useMutation();

  const doTrainingMut = async (modelVersionId: number, idx: number) => {
    try {
      await doTraining.mutateAsync({ modelVersionId });

      finishedRuns++;

      // TODO update notification instead
      showSuccessNotification({
        message: `Submitted ${finishedRuns}/${runs.length} runs...`,
      });

      if (finishedRuns === runs.length) {
        showSuccessNotification({
          title: 'Successfully submitted for training!',
          message: 'You will be emailed when training is complete.',
        });
        // TODO make this a setInfiniteData, too much work right now
        await queryUtils.model.getMyTrainingModels.invalidate();

        await router.replace(userTrainingDashboardURL);
        setAwaitInvalidate(false);
      }
    } catch (e) {
      const error = e as TRPCClientErrorBase<DefaultErrorShape>;
      showErrorNotification({
        title: `Failed to submit run #${idx} for training`,
        error: new Error(error.message),
        reason: error.message ?? 'An unexpected error occurred. Please try again later.',
        autoClose: false,
      });

      if (idx > 0) {
        await deleteVersionMutation.mutateAsync({ id: modelVersionId });
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
        error: new Error('Missing file data, please reupload your images.'),
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
              <Group spacing={2}>
                <CurrencyIcon currency={Currency.BUZZ} size={12} />
                <Text span inline>
                  {(buzzCost ?? 0).toLocaleString()}
                </Text>
              </Group>
            </Group>
            <Group>
              <Text span inline>
                Your remaining balance will be:{' '}
              </Text>
              <Group spacing={2}>
                <CurrencyIcon currency={Currency.BUZZ} size={12} />
                <Text span inline>
                  {(balance - (buzzCost ?? 0)).toLocaleString()}
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

    conditionalPerformTransaction(buzzCost ?? 0, performTransaction);
  };

  const handleConfirm = () => {
    setAwaitInvalidate(true);

    runs.forEach(async (run, idx) => {
      const { params, customModel, samplePrompts, staging, highPriority } = run;
      const { optimizerArgs, ...paramData } = params;

      const baseModelConvert: BaseModel =
        (customModel?.baseModel as BaseModel | undefined) ??
        (formBaseModel === 'sdxl' ? 'SDXL 1.0' : formBaseModel === 'pony' ? 'Pony' : 'SD 1.5');

      // update the first one since it exists, or create for others
      const versionMutateData: ModelVersionUpsertInput = {
        ...(idx === 0 && { id: thisModelVersion.id }),
        name: `V${idx + 1}`,
        modelId: model.id,
        baseModel: baseModelConvert,
        trainedWords: [],
        // ---
        epochs: paramData.maxTrainEpochs,
        steps: paramData.targetSteps,
        clipSkip: paramData.clipSkip,
        trainingDetails: {
          ...((thisModelVersion.trainingDetails as TrainingDetailsObj) ?? {}),
          baseModel: formBaseModel,
          baseModelType: formBaseModelType,
          params: paramData,
          samplePrompts,
          staging,
          highPriority,
        },
      };

      try {
        const response = await upsertVersionMutation.mutateAsync(versionMutateData);
        const newVersionId = response.id;

        if (idx === 0) {
          await doTrainingMut(thisModelVersion.id, idx);
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

            await doTrainingMut(fileModelVersionId, idx);
          } catch (e) {
            const error = e as TRPCClientErrorBase<DefaultErrorShape>;
            showErrorNotification({
              error: new Error(error.message),
              title: `Failed to create model file for run #${idx}`,
              autoClose: false,
            });
            finishedRuns++;
            if (finishedRuns === runs.length) setAwaitInvalidate(false);
          }
        }
      } catch (e) {
        const error = e as TRPCClientErrorBase<DefaultErrorShape>;
        showErrorNotification({
          error: new Error(error.message),
          title: `Failed to save model version info for run #${idx}`,
          autoClose: false,
        });
        finishedRuns++;
        if (finishedRuns === runs.length) setAwaitInvalidate(false);
      }
    });

    finishedRuns = 0;
  };

  return (
    <Stack>
      {!status.available && (
        <AlertWithIcon
          icon={<IconExclamationMark size={18} />}
          iconColor="red"
          color="red"
          size="sm"
        >
          {status.message ?? 'Training is currently disabled.'}
        </AlertWithIcon>
      )}
      <Accordion
        variant="separated"
        defaultValue={'model-details'}
        styles={(theme) => ({
          content: { padding: 0 },
          item: {
            overflow: 'hidden',
            borderColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
            boxShadow: theme.shadows.sm,
          },
          control: {
            padding: theme.spacing.sm,
          },
        })}
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
                  label: 'Images',
                  value: thisMetadata?.numImages || 0,
                },
                {
                  label: 'Captions',
                  value: thisMetadata?.numCaptions || 0,
                },
              ]}
            />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <Stack className={classes.sticky}>
        <Group mt="md" position="apart" noWrap>
          <Group spacing={4}>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              Submit up to {maxRuns} training runs at once.
              <br />
              You can use different base models and/or parameters, all trained on the same dataset.
              Each will be created as their own version.
            </InfoPopover>
            <Title order={5}>Training Runs</Title>
          </Group>
          <Group spacing="xs" ml="sm">
            <Button
              color="green"
              variant="light"
              compact
              leftIcon={<IconPlus size={16} />}
              disabled={runs.length >= maxRuns}
              onClick={() => {
                addRun(model.id);
                setSelectedRunIndex(runs.length);
              }}
              styles={{
                leftIcon: {
                  marginRight: 8,
                },
              }}
            >
              Add
            </Button>
            <Button
              color="cyan"
              variant="light"
              compact
              leftIcon={<IconCopy size={16} />}
              disabled={runs.length >= maxRuns}
              onClick={() => {
                addRun(model.id, selectedRun);
                setSelectedRunIndex(runs.length);
              }}
              styles={{
                leftIcon: {
                  marginRight: 8,
                },
              }}
            >
              Duplicate
            </Button>
            <Button
              color="red"
              variant="light"
              compact
              leftIcon={<IconX size={16} />}
              // disabled={runs.length <= 1}
              onClick={() => {
                removeRun(model.id, selectedRun.id);
                setSelectedRunIndex(0);
              }}
              styles={{
                leftIcon: {
                  marginRight: 8,
                },
              }}
            >
              Remove
            </Button>
          </Group>
        </Group>

        <SegmentedControl
          data={runs.map((run, idx) => ({
            label: `Run #${idx + 1} (${
              isTrainingCustomModel(run.base)
                ? 'Custom'
                : run.base === 'sdxl'
                ? 'SDXL'
                : run.base === 'semi'
                ? 'Semi'
                : baseModelDescriptions[run.base].label
            })`,
            // value: run.id.toString(),
            value: idx.toString(),
          }))}
          value={selectedRunIndex.toString()}
          onChange={(value) => {
            // const run = runs.find((r) => r.id === Number(value));
            setSelectedRunIndex(Number(value));
          }}
          sx={{ overflow: 'auto' }}
        />

        <Divider />
      </Stack>

      <Stack spacing={0}>
        <Title mt="md" order={5}>
          Base Model for Training{' '}
          <Text span color="red">
            *
          </Text>
        </Title>
        <Text color="dimmed" size="sm">
          Not sure which one to choose? Read our{' '}
          <Anchor
            href="https://education.civitai.com/using-civitai-the-on-site-lora-trainer"
            target="_blank"
            rel="nofollow noreferrer"
          >
            On-Site LoRA Trainer Guide
          </Anchor>{' '}
          for more info.
        </Text>
      </Stack>
      <Input.Wrapper>
        <Card withBorder mt={8} p="sm">
          <Card.Section inheritPadding withBorder py="sm">
            <Stack spacing="xs">
              <Group>
                <Badge color="violet" size="lg" radius="xs" w={85}>
                  SD 1.5
                </Badge>
                <SegmentedControl
                  data={Object.entries(baseModelDescriptions)
                    .filter(([, v]) => v.type === '15')
                    .map(([k, v]) => {
                      return {
                        label: v.label,
                        value: k,
                      };
                    })}
                  // nb: this type is not accurate, but null is the only way to clear out SegmentedControl
                  value={baseModel15 as TrainingDetailsBaseModel15}
                  onChange={(value) => {
                    makeDefaultParams({ base: value, baseType: 'sd15', customModel: null });
                  }}
                  color="blue"
                  size="xs"
                  className={classes.segControl}
                  transitionDuration={0}
                />
              </Group>

              <Group>
                <Badge color="grape" size="lg" radius="xs" w={85}>
                  SDXL
                </Badge>
                <SegmentedControl
                  data={Object.entries(baseModelDescriptions)
                    .filter(([, v]) => v.type === 'XL')
                    .map(([k, v]) => {
                      return {
                        label: v.label,
                        value: k,
                      };
                    })}
                  value={baseModelXL as TrainingDetailsBaseModelXL}
                  onChange={(value) => {
                    makeDefaultParams({
                      base: value,
                      baseType: 'sdxl',
                      customModel: null,
                    });
                  }}
                  color="blue"
                  size="xs"
                  className={classes.segControl}
                  transitionDuration={0}
                />
              </Group>

              <Group>
                <Badge color="cyan" size="lg" radius="xs" w={85}>
                  Custom
                </Badge>
                <Card px="sm" py={8} radius="md" withBorder>
                  <ResourceSelect
                    buttonLabel="Select custom model"
                    buttonProps={{
                      size: 'md',
                      compact: true,
                      styles: { label: { fontSize: 12 } },
                    }}
                    options={{
                      resources: [
                        {
                          type: ModelType.Checkpoint,
                        },
                      ],
                    }}
                    allowRemove={true}
                    isTraining={true}
                    value={selectedRun.customModel}
                    onChange={(val) => {
                      const gVal = val as Generation.Resource | undefined;
                      if (!gVal) {
                        makeDefaultParams({
                          base: defaultBase,
                          baseType: defaultBaseType,
                          customModel: null,
                        });
                      } else {
                        const mId = gVal.modelId;
                        const mvId = gVal.id;
                        const mBase = gVal.baseModel as BaseModel;
                        const castBase = [
                          ...baseModelSets.SDXL,
                          ...baseModelSets.SDXLDistilled,
                          ...baseModelSets.Pony,
                        ].includes(mBase)
                          ? 'sdxl'
                          : 'sd15';
                        const cLink = `civitai:${mId}@${mvId}`;

                        makeDefaultParams({
                          base: cLink,
                          baseType: castBase,
                          customModel: gVal,
                        });
                      }
                    }}
                  />
                </Card>
              </Group>
            </Stack>
          </Card.Section>
          {formBaseModel && (
            <Card.Section inheritPadding py="sm">
              <Stack>
                <Text size="sm">
                  {isTrainingCustomModel(formBaseModel)
                    ? 'Custom model selected.'
                    : baseModelDescriptions[formBaseModel]?.description ?? 'No description.'}
                </Text>
                {blockedModels.includes(formBaseModel) ? (
                  <AlertWithIcon
                    icon={<IconExclamationCircle />}
                    iconColor="default"
                    p="sm"
                    color="red"
                  >
                    <Text>
                      This model currently does not work properly with kohya.
                      <br />
                      We are working on a fix for this - in the meantime, please try a different
                      model.
                    </Text>
                  </AlertWithIcon>
                ) : isTrainingCustomModel(formBaseModel) ? (
                  <AlertWithIcon icon={<IconAlertCircle />} iconColor="default" p="xs">
                    Note: custom models may see a higher failure rate than normal, and cost more
                    Buzz.
                  </AlertWithIcon>
                ) : undefined}
              </Stack>
            </Card.Section>
          )}
        </Card>
      </Input.Wrapper>

      {formBaseModel && (
        <>
          <Title mt="md" order={5}>
            Advanced Settings
          </Title>

          <Accordion
            variant="separated"
            multiple
            mt="md"
            onChange={setOpenedSections}
            styles={(theme) => ({
              content: { padding: 0 },
              item: {
                overflow: 'hidden',
                borderColor:
                  theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
                boxShadow: theme.shadows.sm,
              },
              control: {
                padding: theme.spacing.sm,
              },
            })}
          >
            <Accordion.Item value="custom-prompts">
              <Accordion.Control>
                <Stack spacing={4}>
                  Sample Image Prompts
                  {openedSections.includes('custom-prompts') && (
                    <Text size="xs" color="dimmed">
                      Set your own prompts for any of the 3 sample images we generate for each
                      epoch.
                    </Text>
                  )}
                </Stack>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack p="sm">
                  <TextInputWrapper
                    label="Image #1"
                    placeholder="Automatically set"
                    value={selectedRun.samplePrompts[0]}
                    onChange={(event) =>
                      updateRun(model.id, selectedRun.id, {
                        samplePrompts: [
                          event.currentTarget.value,
                          selectedRun.samplePrompts[1],
                          selectedRun.samplePrompts[2],
                        ],
                      })
                    }
                  />
                  <TextInputWrapper
                    label="Image #2"
                    placeholder="Automatically set"
                    value={selectedRun.samplePrompts[1]}
                    onChange={(event) =>
                      updateRun(model.id, selectedRun.id, {
                        samplePrompts: [
                          selectedRun.samplePrompts[0],
                          event.currentTarget.value,
                          selectedRun.samplePrompts[2],
                        ],
                      })
                    }
                  />
                  <TextInputWrapper
                    label="Image #3"
                    placeholder="Automatically set"
                    value={selectedRun.samplePrompts[2]}
                    onChange={(event) =>
                      updateRun(model.id, selectedRun.id, {
                        samplePrompts: [
                          selectedRun.samplePrompts[0],
                          selectedRun.samplePrompts[1],
                          event.currentTarget.value,
                        ],
                      })
                    }
                  />
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="training-settings">
              <Accordion.Control>
                <Stack spacing={4}>
                  <Group spacing="sm">
                    <Text>Training Parameters</Text>
                    {isTrainingCustomModel(formBaseModel) && (
                      <Tooltip
                        label="Custom models will likely require parameter adjustments. Please carefully check these before submitting."
                        maw={300}
                        multiline
                        withArrow
                        styles={(theme) => ({
                          tooltip: {
                            border: `1px solid ${
                              theme.colorScheme === 'dark'
                                ? theme.colors.dark[4]
                                : theme.colors.gray[3]
                            }`,
                          },
                          arrow: {
                            borderRight: `1px solid ${
                              theme.colorScheme === 'dark'
                                ? theme.colors.dark[4]
                                : theme.colors.gray[3]
                            }`,
                            borderBottom: `1px solid ${
                              theme.colorScheme === 'dark'
                                ? theme.colors.dark[4]
                                : theme.colors.gray[3]
                            }`,
                          },
                        })}
                      >
                        <IconAlertTriangle color="orange" size={16} />
                      </Tooltip>
                    )}
                  </Group>
                  {openedSections.includes('training-settings') && (
                    <Text size="xs" color="dimmed">
                      Hover over each setting for more information.
                      <br />
                      Default settings are based on your chosen model. Altering these settings may
                      cause undesirable results.
                    </Text>
                  )}
                </Stack>
              </Accordion.Control>
              <Accordion.Panel>
                <DescriptionTable
                  labelWidth="200px"
                  items={trainingSettings.map((ts) => {
                    let inp: React.ReactNode;

                    if (ts.type === 'int' || ts.type === 'number') {
                      const override = ts.overrides?.[formBaseModel];
                      inp = (
                        <NumberInputWrapper
                          min={override?.min ?? ts.min}
                          max={override?.max ?? ts.max}
                          precision={
                            ts.type === 'number'
                              ? getPrecision(ts.step ?? ts.default) || 4
                              : undefined
                          }
                          step={ts.step}
                          sx={{ flexGrow: 1 }}
                          disabled={ts.disabled === true}
                          format="default"
                          value={selectedRun.params[ts.name] as number}
                          onChange={(value) =>
                            updateRun(model.id, selectedRun.id, {
                              params: { [ts.name]: value },
                            })
                          }
                        />
                      );
                    } else if (ts.type === 'select') {
                      let options = ts.options as string[];
                      // TODO if we fix the bitsandbytes issue, we can disable this
                      if (ts.name === 'optimizerType' && formBaseModelType === 'sdxl') {
                        options = options.filter((o) => o !== 'AdamW8Bit');
                      }
                      if (
                        ts.name === 'lrScheduler' &&
                        selectedRun.params.optimizerType === 'Prodigy'
                      ) {
                        options = options.filter((o) => o !== 'cosine_with_restarts');
                      }

                      inp = (
                        <SelectWrapper
                          data={options}
                          disabled={ts.disabled === true}
                          value={selectedRun.params[ts.name] as string}
                          onChange={(value) =>
                            updateRun(model.id, selectedRun.id, {
                              params: { [ts.name]: value },
                            })
                          }
                        />
                      );
                    } else if (ts.type === 'bool') {
                      inp = (
                        <Checkbox
                          py={8}
                          disabled={ts.disabled === true}
                          checked={selectedRun.params[ts.name] as boolean}
                          onChange={(event) =>
                            updateRun(model.id, selectedRun.id, {
                              params: {
                                [ts.name]: event.currentTarget.checked,
                              },
                            })
                          }
                        />
                      );
                    } else if (ts.type === 'string') {
                      inp = (
                        <TextInputWrapper
                          disabled={ts.disabled === true}
                          clearable={ts.disabled !== true}
                          value={selectedRun.params[ts.name] as string}
                          onChange={(event) =>
                            updateRun(model.id, selectedRun.id, {
                              params: {
                                [ts.name]: event.currentTarget.value,
                              },
                            })
                          }
                        />
                      );
                    }

                    return {
                      label: ts.hint ? (
                        <CivitaiTooltip
                          position="top"
                          variant="roundedOpaque"
                          withArrow
                          multiline
                          label={ts.hint}
                        >
                          <Group spacing={6}>
                            <Text inline style={{ cursor: 'help' }}>
                              {ts.label}
                            </Text>
                            {ts.name === 'targetSteps' &&
                              selectedRun.params.targetSteps > maxSteps && (
                                <IconAlertTriangle color="orange" size={16} />
                              )}
                          </Group>
                        </CivitaiTooltip>
                      ) : (
                        ts.label
                      ),
                      value: inp,
                    };
                  })}
                />
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          <Group mt="lg">
            <Switch
              label={
                <Group spacing={4} noWrap>
                  <InfoPopover size="xs" iconProps={{ size: 16 }}>
                    Jump to the front of the training queue and ensure that your training run is
                    uninterrupted.
                  </InfoPopover>
                  <Text>High Priority</Text>
                </Group>
              }
              labelPosition="left"
              checked={selectedRun.highPriority}
              onChange={(event) =>
                updateRun(model.id, selectedRun.id, {
                  highPriority: event.currentTarget.checked,
                })
              }
            />
            {currentUser?.isModerator && (
              <Switch
                label="Test Mode"
                labelPosition="left"
                checked={selectedRun.staging}
                onChange={(event) =>
                  updateRun(model.id, selectedRun.id, {
                    staging: event.currentTarget.checked,
                  })
                }
              />
            )}
          </Group>
          <Paper
            shadow="xs"
            radius="sm"
            mt="md"
            w="fit-content"
            px="md"
            py="xs"
            style={{
              backgroundColor:
                theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
              alignSelf: 'flex-end',
            }}
          >
            {/* TODO: some tooltip -> link explaining */}
            <Group spacing="sm">
              <Badge>Est. Wait Time</Badge>
              {dryRunLoading ? (
                <Loader size="sm" />
              ) : (
                <Text>
                  {/*{!!dryRunData ? formatDate(dryRunData, 'MMM D, YYYY hh:mm:ss A') : 'Unknown'}*/}
                  {!!dryRunData ? dayjs(dryRunData).add(10, 's').fromNow(true) : 'Unknown'}
                </Text>
              )}
              <Divider orientation="vertical" />
              <Badge>ETA</Badge>
              {dryRunLoading ? (
                <Loader size="sm" />
              ) : (
                <Text>
                  {!isDefined(etaMins)
                    ? 'Unknown'
                    : minsToHours(
                        (!!dryRunData
                          ? (new Date().getTime() - new Date(dryRunData).getTime()) / 60000
                          : 10) + etaMins
                      )}
                </Text>
              )}
              <Divider orientation="vertical" />
              <Badge>Cost</Badge>
              <CurrencyBadge
                currency={Currency.BUZZ}
                unitAmount={selectedRun.buzzCost}
                displayCurrency={false}
              />
            </Group>
          </Paper>
        </>
      )}

      <Divider mt="md" />

      <Group mt="lg" position="right">
        <Button variant="default" onClick={() => goBack(model.id, thisStep)}>
          Back
        </Button>
        <BuzzTransactionButton
          loading={awaitInvalidate}
          disabled={blockedModels.includes(formBaseModel ?? '') || !status.available}
          label={`Submit${runs.length > 1 ? ` (${runs.length} runs)` : ''}`}
          buzzAmount={buzzCost ?? 0}
          onPerformTransaction={handleSubmit}
        />
      </Group>
    </Stack>
  );
};
