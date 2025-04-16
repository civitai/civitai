import {
  Anchor,
  Badge,
  Card,
  createStyles,
  Group,
  Indicator,
  Input,
  MantineColor,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertCircle, IconExclamationCircle } from '@tabler/icons-react';
import React from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ResourceSelect } from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import { blockedCustomModels } from '~/components/Training/Form/TrainingCommon';
import { useTrainingServiceStatus } from '~/components/Training/training.utils';
import { baseModelSets } from '~/server/common/constants';
import {
  TrainingDetailsBaseModelList,
  trainingDetailsBaseModels15,
  trainingDetailsBaseModels35,
  trainingDetailsBaseModelsFlux,
  trainingDetailsBaseModelsHunyuan,
  trainingDetailsBaseModelsWan,
  trainingDetailsBaseModelsXL,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import { ModelType } from '~/shared/utils/prisma/enums';
import {
  defaultBase,
  defaultBaseType,
  defaultBaseTypeVideo,
  defaultBaseVideo,
  defaultEngine,
  defaultEngineVideo,
  getDefaultTrainingParams,
  TrainingRun,
  TrainingRunUpdate,
  trainingStore,
} from '~/store/training.store';
import { stringifyAIR } from '~/utils/string-helpers';
import { type TrainingBaseModelType, trainingModelInfo } from '~/utils/training';

const useStyles = createStyles((theme) => ({
  // TODO is this working?
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
}));

const badgeWidth = 115;

const ModelSelector = ({
  selectedRun,
  color,
  name,
  value,
  baseType,
  makeDefaultParams,
  isNew = false,
  isCustom = false,
  isVideo = false,
}: {
  selectedRun: TrainingRun;
  color: MantineColor;
  name: string;
  value: string | null;
  baseType: TrainingBaseModelType;
  makeDefaultParams: (data: TrainingRunUpdate) => void;
  isNew?: boolean;
  isCustom?: boolean;
  isVideo?: boolean;
}) => {
  const { classes } = useStyles();

  const versions = Object.entries(trainingModelInfo).filter(([, v]) => v.type === baseType);
  if (!versions.length) return null;

  return (
    <Group spacing="lg">
      <Indicator
        disabled={!isNew}
        inline
        color="green.8"
        label="New"
        size={16}
        styles={{ indicator: { top: '2px !important', right: '10px !important' } }}
      >
        <Badge color={color} size="lg" radius="xs" px="xs" w={badgeWidth}>
          {name}
        </Badge>
      </Indicator>
      {!isCustom ? (
        <SegmentedControl
          data={versions.map(([k, v]) => {
            return {
              label: v.isNew ? (
                <Group noWrap spacing={6}>
                  <Text>{v.label}</Text>
                  <Badge size="xs" color="green">
                    NEW
                  </Badge>
                </Group>
              ) : (
                v.label
              ),
              value: k,
            };
          })}
          value={value!} // TODO undefined vs null?
          onChange={(value) => {
            makeDefaultParams({
              base: value,
              baseType: baseType,
              customModel: null,
            });
          }}
          color="blue"
          size="xs"
          className={classes.segControl}
          transitionDuration={0}
        />
      ) : (
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
                  // nb: when adding here, make sure logic is added in castBase below
                  baseModels: ['SD 1.4', 'SD 1.5', 'SDXL 1.0', 'Pony', 'Illustrious'],
                },
              ],
            }}
            allowRemove={true}
            selectSource="training"
            value={selectedRun.customModel}
            onChange={(gVal) => {
              if (!gVal) {
                makeDefaultParams({
                  base: isVideo ? defaultBaseVideo : defaultBase,
                  baseType: isVideo ? defaultBaseTypeVideo : defaultBaseType,
                  customModel: null,
                });
              } else {
                const { baseModel, model, id: mvId } = gVal;

                const castBase = (
                  [
                    ...baseModelSets.SDXL.baseModels,
                    ...baseModelSets.SDXLDistilled.baseModels,
                    ...baseModelSets.Pony.baseModels,
                    ...baseModelSets.Illustrious.baseModels,
                  ] as string[]
                ).includes(baseModel)
                  ? 'sdxl'
                  : ([...baseModelSets.Flux1.baseModels] as string[]).includes(baseModel)
                  ? 'flux'
                  : ([...baseModelSets.SD3.baseModels] as string[]).includes(baseModel)
                  ? 'sd35'
                  : 'sd15';

                const cLink = stringifyAIR({
                  baseModel,
                  type: model.type,
                  modelId: model.id,
                  id: mvId,
                });

                makeDefaultParams({
                  base: cLink,
                  baseType: castBase,
                  customModel: gVal,
                });
              }
            }}
          />
        </Card>
      )}
    </Group>
  );
};

export const ModelSelect = ({
  selectedRun,
  modelId,
  mediaType,
  numImages,
}: {
  selectedRun: TrainingRun;
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
  numImages: number | undefined;
}) => {
  const status = useTrainingServiceStatus();

  const { updateRun } = trainingStore;
  const blockedModels = status.blockedModels ?? [blockedCustomModels];

  // - Apply default params with overrides and calculations upon base model selection
  const makeDefaultParams = (data: TrainingRunUpdate) => {
    const defaultParams = getDefaultTrainingParams(
      data.base!,
      data.params?.engine ?? (mediaType === 'video' ? defaultEngineVideo : defaultEngine)
    );

    defaultParams.numRepeats = Math.max(1, Math.min(5000, Math.ceil(200 / (numImages || 1))));

    defaultParams.targetSteps = Math.ceil(
      ((numImages || 1) * defaultParams.numRepeats * defaultParams.maxTrainEpochs) /
        defaultParams.trainBatchSize
    );

    updateRun(modelId, mediaType, selectedRun.id, { params: { ...defaultParams }, ...data });
  };

  const formBaseModel = selectedRun.base;
  const isCustomModel = !!selectedRun.customModel;

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
  const baseModel35 =
    !!formBaseModel &&
    (trainingDetailsBaseModels35 as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelFlux =
    !!formBaseModel &&
    (trainingDetailsBaseModelsFlux as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelHunyuan =
    !!formBaseModel &&
    (trainingDetailsBaseModelsHunyuan as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelWan =
    !!formBaseModel &&
    (trainingDetailsBaseModelsWan as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;

  return (
    <>
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
              {mediaType === 'image' && (
                <>
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="violet"
                    name="SD 1.5"
                    value={baseModel15}
                    baseType="sd15"
                    makeDefaultParams={makeDefaultParams}
                  />
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="grape"
                    name="SDXL"
                    value={baseModelXL}
                    baseType="sdxl"
                    makeDefaultParams={makeDefaultParams}
                  />
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="pink"
                    name="SD 3.5"
                    value={baseModel35}
                    baseType="sd35"
                    makeDefaultParams={makeDefaultParams}
                    isNew={new Date() < new Date('2024-11-10')}
                  />
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="red"
                    name="Flux"
                    value={baseModelFlux}
                    baseType="flux"
                    makeDefaultParams={makeDefaultParams}
                    isNew={new Date() < new Date('2024-09-01')}
                  />
                </>
              )}
              {mediaType === 'video' && (
                <>
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="teal"
                    name="Hunyuan"
                    value={baseModelHunyuan}
                    baseType="hunyuan"
                    makeDefaultParams={makeDefaultParams}
                    isVideo
                    isNew={new Date() < new Date('2025-04-30')}
                  />
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="green"
                    name="Wan"
                    value={baseModelWan}
                    baseType="wan"
                    makeDefaultParams={makeDefaultParams}
                    isVideo
                    isNew={new Date() < new Date('2025-04-30')}
                  />
                </>
              )}
              {mediaType === 'image' && (
                <>
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="cyan"
                    name="Custom"
                    value=""
                    baseType="sdxl" // unused
                    makeDefaultParams={makeDefaultParams}
                    isCustom
                  />
                </>
              )}
            </Stack>
          </Card.Section>
          {formBaseModel && (
            <Card.Section inheritPadding py="sm">
              <Stack>
                <Text size="sm">
                  {isCustomModel
                    ? 'Custom model selected.'
                    : trainingModelInfo[formBaseModel as TrainingDetailsBaseModelList]
                        ?.description ?? 'No description.'}
                </Text>
                {blockedModels.includes(formBaseModel) ? (
                  <AlertWithIcon
                    icon={<IconExclamationCircle />}
                    iconColor="default"
                    p="sm"
                    color="red"
                  >
                    <Text>
                      This model is not currently available for LoRA training - please select a
                      different model.
                    </Text>
                  </AlertWithIcon>
                ) : isCustomModel ? (
                  <AlertWithIcon icon={<IconAlertCircle />} iconColor="default" p="xs">
                    Note: custom models may see a higher failure rate than normal, and cost more
                    Buzz.
                  </AlertWithIcon>
                ) : selectedRun.baseType === 'hunyuan' || selectedRun.baseType === 'wan' ? (
                  <AlertWithIcon icon={<IconAlertCircle />} iconColor="default" p="xs">
                    Note: this is an experimental build. Pricing, default settings, and results are
                    subject to change.
                  </AlertWithIcon>
                ) : undefined}
              </Stack>
            </Card.Section>
          )}
        </Card>
      </Input.Wrapper>
    </>
  );
};
