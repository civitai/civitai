import { Button, createStyles, Group, Image, Radio, Stack, Text } from '@mantine/core';
import { ModelStatus, ModelType, ModelUploadType, TrainingStatus } from '@prisma/client';
import React, { useState } from 'react';
import { z } from 'zod';
import { goNext } from '~/components/Resource/Forms/Training/TrainingCommon';
import { Form, InputRadioGroup, InputText, useForm } from '~/libs/form';
import { BaseModel, constants } from '~/server/common/constants';
import { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { TrainingModelData } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type tmTypes = (typeof constants.trainingModelTypes)[number];

const useStyles = createStyles((theme) => ({
  centerRadio: {
    '& .mantine-Group-root': {
      justifyContent: 'space-between',
      alignItems: 'stretch',
      [theme.fn.smallerThan('sm')]: {
        justifyContent: 'center',
      },
    },
    '& .mantine-Radio-inner': {
      display: 'none',
    },
    '& .mantine-Radio-label': {
      padding: theme.spacing.md,
    },
    '& .mantine-Radio-root': {
      borderRadius: theme.radius.md,
      // TODO [bw] check for dark theme here
      '&:hover': {
        backgroundColor: theme.fn.rgba(theme.colors.blue[2], 0.1),
      },
      '&[data-checked]': {
        backgroundColor: theme.fn.rgba(theme.colors.blue[9], 0.2),
      },
    },
  },
}));

const RadioImg = ({
  value,
  src,
  description,
}: {
  value: string;
  src: string;
  description: string;
}) => (
  <Radio
    value={value}
    label={
      <Image
        src={src}
        width={170}
        height={255}
        alt={value}
        radius="sm"
        caption={
          <>
            <Text fz="lg" fw={500}>
              {value}
            </Text>
            <Text>{description}</Text>
          </>
        }
        withPlaceholder
      />
    }
  />
);

export function TrainingFormBasic({ model }: { model?: TrainingModelData }) {
  const queryUtils = trpc.useContext();
  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);

  const thisModelVersion = model?.modelVersions[0];
  const thisTrainingDetails = thisModelVersion?.trainingDetails as TrainingDetailsObj | undefined;
  const existingTrainingModelType = thisTrainingDetails?.type ?? undefined;

  const [trainingModelType, setTrainingModelType] = useState<tmTypes | undefined>(
    existingTrainingModelType
  );

  const { classes } = useStyles();

  const thisStep = 1;

  const schema = z.object({
    id: z.number().optional(),
    name: z.string().trim().min(1, 'Name cannot be empty.'),
    trainingModelType: z.enum(constants.trainingModelTypes, {
      errorMap: () => ({ message: 'A model type must be chosen.' }),
    }),
  });

  const defaultValues: Omit<z.infer<typeof schema>, 'trainingModelType'> & {
    trainingModelType: tmTypes | undefined;
  } = {
    ...model,
    name: model?.name ?? '',
    trainingModelType: existingTrainingModelType,
  };
  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues,
    shouldUnregister: false,
  });

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
            modelVersions: [],
          };

        return {
          ...old,
          name: request.name,
        };
      });

      // TODO [bw] don't invalidate, just update
      await queryUtils.model.getMyTrainingModels.invalidate();
      // queryUtils.model.getMyTrainingModels.setData({}, (old) => {
      //   if (!old) return old;
      //
      //   return {};
      // });

      const versionMutateData = {
        ...(versionId && { id: versionId }),
        modelId: modelId,
        name: modelName,
        baseModel: thisModelVersion
          ? (thisModelVersion.baseModel as BaseModel)
          : ('SD 1.5' as const), // TODO [bw] this is not really correct, but it needs something there
        trainingStatus: TrainingStatus.Pending,
        trainingDetails: { type: trainingModelType as tmTypes },
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
                    files: [],
                  },
                  ...old.modelVersions,
                ],
              };
            }
          });

          // TODO [bw] don't invalidate, just update
          await queryUtils.model.getMyTrainingModels.invalidate();
          setAwaitInvalidate(false);
          goNext(modelId, thisStep);
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
    if (isDirty) {
      setAwaitInvalidate(true);
      // TODO [bw]: status draft is maybe wrong here if they can come back later
      // nb: if updating, update setData above
      upsertModelMutation.mutate({
        ...rest,
        status: ModelStatus.Draft,
        type: ModelType.LORA,
        uploadType: ModelUploadType.Trained,
        // TODO [bw] we can set the tag here based on type so category is filled out
        // tagsOnModels:
      });
    } else {
      goNext(model?.id, thisStep);
    }
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack>
        <InputRadioGroup
          value={trainingModelType}
          onChange={(v) => {
            setTrainingModelType(v as tmTypes);
          }}
          className={classes.centerRadio} // why is this not easier to do?
          name="trainingModelType"
          label="Choose your model type"
          withAsterisk
        >
          <RadioImg
            value="Character"
            src="https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/c42020cf-ca49-4b4d-b0e6-1807463f90ad/width=1024/00834-2746643195.jpeg"
            description="A specific person or character, realistic or anime"
          />
          <RadioImg
            value="Style"
            src="https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/9829c1d2-6c99-40a6-b882-057209a86bee/width=1024/00104-1775031745.jpeg"
            description="A time period, art style, or general look and feel"
          />
          <RadioImg
            value="Concept"
            src="https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/55418f7b-7d7d-4284-abea-35d684c48b78/width=2667/00454.jpeg"
            description="Objects, clothing, anatomy, poses, etc."
          />
        </InputRadioGroup>
        <InputText name="name" label="Name" placeholder="Name" withAsterisk />
      </Stack>
      <Group mt="xl" position="right">
        <Button
          type="submit"
          loading={
            upsertModelMutation.isLoading || upsertVersionMutation.isLoading || awaitInvalidate
          }
        >
          Next
        </Button>
      </Group>
    </Form>
  );
}
