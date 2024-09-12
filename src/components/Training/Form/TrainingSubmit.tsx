import {
  Accordion,
  Badge,
  Button,
  createStyles,
  Divider,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { showNotification } from '@mantine/notifications';
import { Currency, ModelUploadType, TrainingStatus } from '@prisma/client';
import {
  IconAlertTriangle,
  IconCopy,
  IconExclamationMark,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import dayjs from 'dayjs';
import { capitalize } from 'lodash-es';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import {
  blockedCustomModels,
  goBack,
  isTrainingCustomModel,
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
import { BaseModel } from '~/server/common/constants';
import { ModelFileCreateInput } from '~/server/schema/model-file.schema';
import {
  ModelVersionUpsertInput,
  TrainingDetailsBaseModelList,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import {
  defaultRun,
  defaultTrainingState,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import { TrainingModelData } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { calcBuzzFromEta, calcEta, isInvalidRapid, isValidRapid, rapidEta } from '~/utils/training';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export const baseModelDescriptions: {
  [key in TrainingDetailsBaseModelList]: { label: string; type: string; description: string };
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
  flux_dev: {
    label: 'Dev',
    type: 'Flux',
    description: 'High quality images and accurate text.',
  },
};

const maxRuns = 5;
// TODO check override
const maxSteps =
  (trainingSettings.find((ts) => ts.name === 'targetSteps') as NumberTrainingSettingsType).max ??
  10000;

const useStyles = createStyles((theme) => ({
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
  const thisNumImages = thisMetadata?.numImages;

  const { addRun, removeRun, updateRun } = trainingStore;
  const { runs } = useTrainingImageStore((state) => state[model.id] ?? { ...defaultTrainingState });

  const [selectedRunIndex, setSelectedRunIndex] = useState<number>(0);
  const selectedRun = runs[selectedRunIndex] ?? defaultRun;

  const [multiMode, setMultiMode] = useState(runs.length > 1);

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

  const buzzCost = runs.map((r) => r.buzzCost).reduce((s, a) => s + a, 0);

  // Calc ETA and Cost
  useEffect(() => {
    const eta = calcEta({
      cost: status.cost,
      baseModel: formBaseModelType,
      params: selectedRun.params,
    });
    const isCustom = isTrainingCustomModel(formBaseModel);
    const price = calcBuzzFromEta({
      cost: status.cost,
      eta,
      isCustom,
      isFlux: selectedRun.baseType === 'flux',
      isPriority: selectedRun.highPriority ?? false,
      isRapid: isValidRapid(selectedRun.baseType, selectedRun.params.engine),
      numImages: thisNumImages ?? 1,
    });
    setEtaMins(eta);
    if (price !== selectedRun.buzzCost) {
      updateRun(model.id, selectedRun.id, { buzzCost: price });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    status.cost,
    selectedRun.params.targetSteps,
    selectedRun.params.resolution,
    selectedRun.params.engine,
    selectedRun.highPriority,
    formBaseModel,
    formBaseModelType,
  ]);

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
      const { base, baseType, params, customModel, samplePrompts, staging, highPriority } = run;
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

      const baseModelConvert: BaseModel =
        (customModel?.baseModel as BaseModel | undefined) ??
        (base === 'sdxl'
          ? 'SDXL 1.0'
          : base === 'pony'
          ? 'Pony'
          : base === 'flux_dev'
          ? 'Flux.1 D'
          : 'SD 1.5');

      // TODO there is a bug here where if >1 fails and then get resubmitted, the idx will be 0
      //  and thus overwrites the first version...

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
        clipSkip: paramData.clipSkip || undefined,
        trainingDetails: {
          ...((thisModelVersion.trainingDetails as TrainingDetailsObj) ?? {}),
          baseModel: base,
          baseModelType: baseType,
          params: paramData,
          samplePrompts,
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
          <Group spacing={4}>
            <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
              Submit up to {maxRuns} training runs at once.
              <br />
              You can use different base models and/or parameters, all trained on the same dataset.
              Each will be created as their own version.
            </InfoPopover>
            <Text>Show Multi Training</Text>
          </Group>
        }
        labelPosition="left"
        checked={multiMode}
        mt="md"
        disabled={runs.length > 1}
        onChange={(event) => setMultiMode(event.currentTarget.checked)}
      />

      <Stack className={classes.sticky} sx={!multiMode ? { display: 'none' } : {}}>
        <Group mt="md" position="apart" noWrap>
          <Title order={5}>Training Runs</Title>
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
              disabled={runs.length <= 1}
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
                : run.base === 'flux_dev'
                ? 'Flux'
                : baseModelDescriptions[run.base as TrainingDetailsBaseModelList].label ?? 'Unknown'
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

      <ModelSelect selectedRun={selectedRun} modelId={model.id} numImages={thisNumImages} />

      {selectedRun.base === 'flux_dev' &&
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
            <Group spacing="sm" position="apart" noWrap>
              <Text>
                You have &quot;tagged&quot; images, but <Badge color="red">Flux</Badge> works best
                with &quot;captions&quot;.
              </Text>
              <Button onClick={() => goBack(model.id, thisStep)}>Go back and fix</Button>
            </Group>
          </AlertWithIcon>
        )}
      {selectedRun.base !== 'flux_dev' &&
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
            <Group spacing="sm" position="apart" noWrap>
              <Text>
                You have &quot;captioned&quot; images, but <Badge color="violet">SD</Badge> models
                work best with &quot;tags&quot;.
              </Text>
              <Button onClick={() => goBack(model.id, thisStep)}>Go back and fix</Button>
            </Group>
          </AlertWithIcon>
        )}

      {formBaseModel && (
        <>
          <AdvancedSettings
            modelId={model.id}
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
                    <Group spacing={4} noWrap>
                      <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
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
              )}
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
          )}
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
            <Group spacing="sm">
              <Badge>
                <Group spacing={4} noWrap>
                  <Text>Est. Wait Time</Text>
                  <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }} withinPortal>
                    How long before your job is expected to be picked up
                  </InfoPopover>
                </Group>
              </Badge>

              {isValidRapid(selectedRun.baseType, selectedRun.params.engine) ? (
                <Text>{dayjs(Date.now()).add(10, 's').fromNow(true)}</Text>
              ) : dryRunLoading ? (
                <Loader size="sm" />
              ) : (
                <Text>
                  {!!dryRunData ? dayjs(dryRunData).add(10, 's').fromNow(true) : 'Unknown'}
                </Text>
              )}
              <Divider orientation="vertical" />

              <Badge>
                <Group spacing={4} noWrap>
                  <Text>ETA</Text>
                  <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }} withinPortal>
                    How long in total before your job is done
                  </InfoPopover>
                </Group>
              </Badge>

              {isValidRapid(selectedRun.baseType, selectedRun.params.engine) ? (
                <Text>{minsToHours(rapidEta)}</Text>
              ) : dryRunLoading ? (
                <Loader size="sm" />
              ) : (
                <Text>
                  {!isDefined(etaMins)
                    ? 'Unknown'
                    : etaMins > 20000
                    ? 'Forever'
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
          disabled={
            blockedModels.includes(formBaseModel ?? '') || !status.available || awaitInvalidate
          }
          label={`Submit${runs.length > 1 ? ` (${runs.length} runs)` : ''}`}
          buzzAmount={buzzCost ?? 0}
          onPerformTransaction={handleSubmit}
        />
      </Group>
    </Stack>
  );
};
