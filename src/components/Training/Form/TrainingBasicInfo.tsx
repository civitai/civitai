import { Badge, Button, Group, Image, Input, Radio, Stack, Text, Tooltip } from '@mantine/core';
import { IconPhoto, IconVideo } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import * as z from 'zod';
import { goNext } from '~/components/Training/Form/TrainingCommon';
import { Form, InputRadioGroup, InputSegmentedControl, InputText, useForm } from '~/libs/form';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { constants } from '~/server/common/constants';
import type { TrainingBaseModelType } from '~/utils/training';
import type {
  ModelVersionUpsertInput,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import {
  Availability,
  ModelStatus,
  ModelType,
  ModelUploadType,
  TrainingStatus,
} from '~/shared/utils/prisma/enums';
import { trainingStore } from '~/store/training.store';
import type { TrainingModelData } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import classes from './TrainingBasicInfo.module.css';
import { useTrainingServiceStatus } from '~/components/Training/training.utils';

type tmTypes = TrainingDetailsObj['type'];
type tMediaTypes = TrainingDetailsObj['mediaType'];

export const trainingModelTypesMap: {
  [p in tmTypes]: {
    allowedTypes: ('image' | 'video')[];
    description: string;
    src: string;
    type: 'img' | 'vid';
    isNew?: boolean;
    restrictedModels?: TrainingBaseModelType[];
  };
} = {
  Character: {
    allowedTypes: ['image', 'video'],
    description: 'A specific person or character, realistic or anime',
    src: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/84918ac0-e5de-4ee5-be94-1fc32ee9a7c4/width=1024/67085860.jpeg',
    type: 'img',
  },
  Style: {
    allowedTypes: ['image', 'video'],
    description: 'A time period, art style, or general look and feel',
    src: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/9829c1d2-6c99-40a6-b882-057209a86bee/width=1024/00104-1775031745.jpeg',
    type: 'img',
  },
  Concept: {
    allowedTypes: ['image', 'video'],
    description: 'Objects, clothing, anatomy, poses, etc.',
    src: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/55418f7b-7d7d-4284-abea-35d684c48b78/width=1024/00454.jpeg',
    type: 'img',
  },
  Effect: {
    allowedTypes: ['video'],
    description: 'Animations or video effects',
    src: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/02e7cb76-2fec-43a9-ab0d-8369a785c4cb/ocean.mp4',
    type: 'vid',
  },
  'Image Edit': {
    allowedTypes: ['image'],
    description: 'Train image-to-image transformations using paired datasets (e.g., logo on shirt, background removal)',
    src: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/84918ac0-e5de-4ee5-be94-1fc32ee9a7c4/width=1024/67085860.jpeg',
    type: 'img',
    isNew: true,
    restrictedModels: ['flux2', 'qwen'], // Flux2 Klein/Dev, Qwen Image Edit, future: Flux Kontext, Z Image Omni/Edit
  },
};

const RadioImg = ({
  value,
  src,
  description,
  type,
  isNew,
}: {
  value: string;
  src: string;
  description: string;
  type: 'img' | 'vid';
  isNew?: boolean;
}) => {
  const caption = (
    <Stack gap={0}>
      <Group justify="center" gap="xs" className="!items-center !justify-center align-middle">
        <Text fz="lg" fw={500}>
          {value}
        </Text>
        {isNew && <Badge color="green">New</Badge>}
      </Group>
      <Text>{description}</Text>
    </Stack>
  );

  const media =
    type === 'img' ? (
      <figure>
        <Image src={src} w={180} h={255} alt={value} radius="sm" />
        <figcaption>
          <Text component="div" c="dimmed" align="center" mt={10}>
            {caption}
          </Text>
        </figcaption>
      </figure>
    ) : (
      <figure>
        <video
          loop
          playsInline
          disablePictureInPicture
          muted
          autoPlay
          controls={false}
          height={255}
          width={180}
          className="!h-[255px] object-cover"
        >
          <source src={src.replace('.mp4', '.webm')} type="video/webm" />
          <source src={src} type="video/mp4" />
        </video>
        <figcaption>
          <Text component="div" c="dimmed" align="center" mt={10}>
            {caption}
          </Text>
        </figcaption>
      </figure>
    );

  return (
    <Radio.Card className={classes.radioCard} value={value}>
      {media}
    </Radio.Card>
  );
};

export function TrainingFormBasic({ model }: { model?: TrainingModelData }) {
  const queryUtils = trpc.useUtils();
  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);
  const features = useFeatureFlags();
  const status = useTrainingServiceStatus();

  const { resetRuns } = trainingStore;

  const thisModelVersion = model?.modelVersions[0];
  const thisTrainingDetails = thisModelVersion?.trainingDetails as TrainingDetailsObj | undefined;
  const existingTrainingModelType = thisTrainingDetails?.type ?? undefined;
  const existingTrainingMediaType = thisTrainingDetails?.mediaType ?? 'image';

  const thisStep = 1;

  const schema = z.object({
    id: z.number().optional(),
    name: z.string().trim().min(1, 'Name cannot be empty.'),
    trainingModelType: z.enum(constants.trainingModelTypes, 'A model type must be chosen.'),
    trainingMediaType: z.enum(constants.trainingMediaTypes, 'A media type must be chosen.'),
  });

  const defaultValues: Omit<z.infer<typeof schema>, 'trainingModelType' | 'trainingMediaType'> & {
    trainingModelType: tmTypes | undefined;
    trainingMediaType: tMediaTypes | undefined;
  } = {
    ...model,
    name: model?.name ?? '',
    trainingModelType: existingTrainingModelType,
    trainingMediaType: existingTrainingMediaType,
  };
  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues,
    shouldUnregister: false,
  });

  const [trainingModelType, trainingMediaType] = form.watch([
    'trainingModelType',
    'trainingMediaType',
  ]);
  const { isDirty } = form.formState;

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation();
  const upsertModelMutation = trpc.model.upsert.useMutation({
    onSuccess: async (response, request) => {
      const modelId = response.id;
      const modelName = request.name;
      const versionId = thisModelVersion?.id;

      queryUtils.training.getModelBasic.setData({ id: modelId }, (old) => {
        if (!old)
          return {
            id: response.id,
            name: modelName,
            status: request.status,
            type: request.type,
            uploadType: request.uploadType,
            availability: request.availability ?? Availability.Public,
            modelVersions: [],
          };

        return {
          ...old,
          name: request.name,
        };
      });

      const versionMutateData: ModelVersionUpsertInput = {
        ...(versionId && { id: versionId }),
        modelId: modelId,
        name: modelName,
        baseModel: thisModelVersion
          ? (thisModelVersion.baseModel as BaseModel)
          : ('SD 1.5' as const), // this is not really correct, but it needs something there
        trainedWords: thisModelVersion ? thisModelVersion.trainedWords : [],
        trainingStatus: TrainingStatus.Pending,
        trainingDetails: {
          type: trainingModelType,
          mediaType: trainingMediaType,
        },
        uploadType: ModelUploadType.Trained,
      };

      upsertVersionMutation.mutate(versionMutateData, {
        onSuccess: async (vResponse) => {
          queryUtils.training.getModelBasic.setData({ id: modelId }, (old) => {
            if (!old) return old;

            const versionToUpdate = versionId
              ? old.modelVersions.find((mv) => mv.id === versionId)
              : undefined;
            if (versionToUpdate) {
              return {
                ...old,
                modelVersions: [
                  {
                    ...versionToUpdate,
                    name: modelName,
                    trainingDetails: {
                      ...((versionToUpdate.trainingDetails as
                        | TrainingDetailsObj
                        | undefined
                        | null) || {}),
                      type: trainingModelType,
                      mediaType: trainingMediaType,
                    },
                  },
                  ...old.modelVersions.filter((mv) => mv.id !== versionId),
                ],
              };
            } else {
              return {
                ...old,
                modelVersions: [
                  {
                    id: vResponse.id,
                    name: vResponse.name,
                    baseModel: vResponse.baseModel,
                    trainingDetails: vResponse.trainingDetails,
                    trainingStatus: vResponse.trainingStatus,
                    trainedWords: vResponse.trainedWords,
                    // uploadType?
                    files: [],
                  },
                  ...old.modelVersions,
                ],
              };
            }
          });

          await queryUtils.model.getMyTrainingModels.invalidate();

          goNext(modelId, thisStep, () => setAwaitInvalidate(false));
        },
        onError: (error) => {
          // should we "roll back" the model creation here?
          setAwaitInvalidate(false);
          showErrorNotification({
            error: new Error(error.message),
            title: 'Failed to save model version',
            autoClose: false,
          });
        },
      });
    },
    onError: (error) => {
      setAwaitInvalidate(false);
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to save model',
        autoClose: false,
      });
    },
  });

  const handleSubmit = ({ ...rest }: z.infer<typeof schema>) => {
    if (!features.videoTraining && trainingMediaType === 'video') {
      showErrorNotification({
        error: new Error('Video training not available'),
        autoClose: false,
      });
      return;
    }

    if (isDirty) {
      setAwaitInvalidate(true);
      // TODO [bw]: status draft is maybe wrong here if they can come back later
      // nb: if updating, update setData above
      upsertModelMutation.mutate({
        ...rest,
        status: ModelStatus.Draft,
        type: ModelType.LORA,
        uploadType: ModelUploadType.Trained,
        ...(rest.trainingModelType
          ? { tagsOnModels: [{ name: rest.trainingModelType.toLowerCase(), isCategory: true }] }
          : {}),
      });
    } else {
      goNext(model?.id, thisStep);
    }
  };

  useEffect(() => {
    if (model?.id && trainingMediaType) resetRuns(model.id, trainingMediaType);

    if (
      trainingModelType &&
      !trainingModelTypesMap[trainingModelType].allowedTypes.includes(trainingMediaType)
    ) {
      form.setValue('trainingModelType', 'Character');
    }
  }, [trainingMediaType]);

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack>
        <Input.Wrapper
          label="Choose your media type"
          labelProps={{ w: '100%', pb: 10 }}
          withAsterisk
          // error={'A media type must be chosen'}
          // errorProps={{ mt: 'xs' }}
        >
          <InputSegmentedControl
            name="trainingMediaType"
            radius="sm"
            className="border-gray-4 dark:border-dark-4"
            data={constants.trainingMediaTypes.map((mt) => {
              const videoNotAllowed = mt === 'video' && !features.videoTraining;

              return {
                label: (
                  <Tooltip
                    disabled={!videoNotAllowed}
                    // label={videoNotAllowed ? 'Currently available to subscribers only' : undefined}
                    label="Temporarily disabled - check back soon!"
                    withinPortal
                  >
                    <Group gap="xs" justify="center">
                      {mt === 'video' ? <IconVideo size={18} /> : <IconPhoto size={16} />}
                      <Text>{titleCase(mt)}</Text>
                      {mt === 'video' && new Date() < new Date('2025-04-30') && (
                        <Badge color="green">New</Badge>
                      )}
                    </Group>
                  </Tooltip>
                ),
                value: mt,
                disabled: videoNotAllowed,
              };
            })}
            fullWidth
          />
        </Input.Wrapper>
        <InputRadioGroup
          className={classes.centerRadio}
          name="trainingModelType"
          label="Choose your LoRA type"
          withAsterisk
        >
          <Group justify="space-between" gap="md" grow>
            {Object.entries(trainingModelTypesMap)
              .filter(([, v]) =>
                !!trainingMediaType ? v.allowedTypes.includes(trainingMediaType) : true
              )
              .map(([k, v]) => (
                <RadioImg
                  value={k}
                  description={v.description}
                  src={v.src}
                  type={v.type}
                  isNew={v.isNew}
                  key={k}
                />
              ))}
          </Group>
        </InputRadioGroup>
        <InputText name="name" label="Name" placeholder="Name" withAsterisk />
      </Stack>
      {/*
        TODO: option to "select existing model"
          would find all training models and spawn a new version
          instead of creating a new model
       */}
      <Group mt="xl" justify="flex-end">
        <Button
          type="submit"
          loading={
            upsertModelMutation.isLoading || upsertVersionMutation.isLoading || awaitInvalidate
          }
          disabled={status && !status.available}
        >
          Next
        </Button>
      </Group>
    </Form>
  );
}
