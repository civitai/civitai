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
import { ModelType } from '@prisma/client';
import { IconAlertCircle, IconExclamationCircle } from '@tabler/icons-react';
import React from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ResourceSelect } from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import {
  blockedCustomModels,
  isTrainingCustomModel,
} from '~/components/Training/Form/TrainingCommon';
import { trainingSettings } from '~/components/Training/Form/TrainingParams';
import { baseModelDescriptions } from '~/components/Training/Form/TrainingSubmit';
import { useTrainingServiceStatus } from '~/components/Training/training.utils';
import { baseModelSets } from '~/server/common/constants';
import {
  TrainingDetailsBaseModelList,
  trainingDetailsBaseModels15,
  trainingDetailsBaseModelsFlux,
  trainingDetailsBaseModelsXL,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { Generation } from '~/server/services/generation/generation.types';
import {
  defaultBase,
  defaultBaseType,
  defaultEngine,
  TrainingRun,
  TrainingRunUpdate,
  trainingStore,
} from '~/store/training.store';
import { TrainingBaseModelType } from '~/utils/training';

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
}));

const badgeWidth = 115;

const ModelSelector = ({
  selectedRun,
  color,
  name,
  type,
  value,
  baseType,
  makeDefaultParams,
  isNew = false,
  isCustom = false,
}: {
  selectedRun: TrainingRun;
  color: MantineColor;
  name: string;
  type: string;
  value: string | null;
  baseType: TrainingBaseModelType;
  makeDefaultParams: (data: TrainingRunUpdate) => void;
  isNew?: boolean;
  isCustom?: boolean;
}) => {
  const { classes } = useStyles();

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
          data={Object.entries(baseModelDescriptions)
            .filter(([, v]) => v.type === type)
            .map(([k, v]) => {
              return {
                label: v.label,
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
              // canGenerate: true, // TODO toggle this on
              resources: [
                {
                  type: ModelType.Checkpoint,
                  baseModels: ['SD 1.4', 'SD 1.5', 'SDXL 1.0', 'Pony'],
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
                const castBase = (
                  [
                    ...baseModelSets.SDXL,
                    ...baseModelSets.SDXLDistilled,
                    ...baseModelSets.Pony,
                  ] as string[]
                ).includes(gVal.baseModel)
                  ? 'sdxl'
                  : ([...baseModelSets.Flux1] as string[]).includes(gVal.baseModel)
                  ? 'flux'
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
      )}
    </Group>
  );
};

export const ModelSelect = ({
  selectedRun,
  modelId,
  numImages,
}: {
  selectedRun: TrainingRun;
  modelId: number;
  numImages: number | undefined;
}) => {
  const status = useTrainingServiceStatus();

  const { updateRun } = trainingStore;
  const blockedModels = status.blockedModels ?? [blockedCustomModels];

  // - Apply default params with overrides and calculations upon base model selection
  const makeDefaultParams = (data: TrainingRunUpdate) => {
    const defaultParams = trainingSettings.reduce(
      (a, v) => ({
        ...a,
        [v.name]:
          v.overrides?.[data.base!]?.all?.default ??
          v.overrides?.[data.base!]?.[data.params?.engine ?? defaultEngine]?.default ??
          v.default,
      }),
      {} as TrainingDetailsParams
    );

    defaultParams.numRepeats = Math.max(1, Math.min(5000, Math.ceil(200 / (numImages || 1))));

    defaultParams.targetSteps = Math.ceil(
      ((numImages || 1) * defaultParams.numRepeats * defaultParams.maxTrainEpochs) /
        defaultParams.trainBatchSize
    );

    updateRun(modelId, selectedRun.id, { params: { ...defaultParams }, ...data });
  };

  const formBaseModel = selectedRun.base;

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
  const baseModelFlux =
    !!formBaseModel &&
    (trainingDetailsBaseModelsFlux as ReadonlyArray<string>).includes(formBaseModel)
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
              <ModelSelector
                selectedRun={selectedRun}
                color="violet"
                name="SD 1.5"
                type="15"
                value={baseModel15}
                baseType="sd15"
                makeDefaultParams={makeDefaultParams}
              />
              <ModelSelector
                selectedRun={selectedRun}
                color="grape"
                name="SDXL"
                type="XL"
                value={baseModelXL}
                baseType="sdxl"
                makeDefaultParams={makeDefaultParams}
              />
              <ModelSelector
                selectedRun={selectedRun}
                color="red"
                name="Flux"
                type="Flux"
                value={baseModelFlux}
                baseType="flux"
                makeDefaultParams={makeDefaultParams}
                isNew={new Date() < new Date('2024-09-01')}
              />
              <ModelSelector
                selectedRun={selectedRun}
                color="cyan"
                name="Custom"
                type=""
                value=""
                baseType="sdxl" // unused
                makeDefaultParams={makeDefaultParams}
                isCustom
              />
            </Stack>
          </Card.Section>
          {formBaseModel && (
            <Card.Section inheritPadding py="sm">
              <Stack>
                <Text size="sm">
                  {isTrainingCustomModel(formBaseModel)
                    ? 'Custom model selected.'
                    : baseModelDescriptions[formBaseModel as TrainingDetailsBaseModelList]
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
    </>
  );
};
