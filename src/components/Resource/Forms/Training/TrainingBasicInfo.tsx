import { Button, createStyles, Group, Image, Radio, Stack, Text } from '@mantine/core';
import { ModelStatus, ModelType, ModelUploadType, TrainingStatus } from '@prisma/client';
import React, { useState } from 'react';
import { z } from 'zod';
import { goNext } from '~/components/Resource/Forms/Training/TrainingCommon';
import { Form, InputRadioGroup, InputText, useForm } from '~/libs/form';
import { constants } from '~/server/common/constants';
import { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { ModelById } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type tmTypes = (typeof constants.trainingModelTypes)[number];

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

export function TrainingFormBasic({ model }: { model?: ModelById }) {
  const queryUtils = trpc.useContext();
  const [trainingModelType, setTrainingModelType] = useState<tmTypes | undefined>(undefined);
  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);

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

  const { classes } = useStyles();

  const thisStep = 1;

  console.log(model);
  console.log(model?.modelVersions[0]);

  const schema = z.object({
    id: z.number().optional(),
    name: z.string().min(1, 'Name cannot be empty.'),
    trainingModelType: z.enum(constants.trainingModelTypes, {
      errorMap: () => ({ message: 'A model type must be chosen.' }),
    }),
  });

  const thisTrainingDetails = model?.modelVersions[0].trainingDetails as
    | TrainingDetailsObj
    | undefined;

  const defaultValues: z.infer<typeof schema> = {
    ...model,
    name: model?.name ?? '',
    trainingModelType: thisTrainingDetails?.type ?? undefined,
  };
  console.log(defaultValues);
  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues,
    shouldUnregister: false,
  });

  const { isDirty, errors } = form.formState;
  if (errors) console.log('errors', errors);

  const editing = !!model;
  console.log('editing2', editing);

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation({
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to saved model version',
      });
    },
  });

  const upsertModelMutation = trpc.model.upsert.useMutation({
    onSuccess: async (data, payload) => {
      console.log('success with model');
      console.log(data);
      console.log(payload);

      if (!payload.id) await queryUtils.model.getMyDraftModels.invalidate();

      const modelId = data.id;
      const modelName = payload.name;
      const versionId = model?.modelVersions[0].id;

      console.log(modelId, modelName);
      console.log('version, are we editing: ', editing);
      console.log(versionId);

      const versionMutateData = {
        ...(versionId && { id: versionId }),
        modelId: modelId,
        name: modelName,
        baseModel: 'SD 1.5' as const, // this is not really correct, but it needs something there
        trainingStatus: TrainingStatus.Pending,
        trainingDetails: { type: trainingModelType as tmTypes },
      };

      upsertVersionMutation.mutate(versionMutateData, {
        onSuccess: async (vData) => {
          // TODO [bw] ideally, we would simply update the proper values rather than invalidate to skip the loading step
          await queryUtils.modelVersion.getById.invalidate({ id: vData.id });
          await queryUtils.model.getById.invalidate({ id: data.id });
          setAwaitInvalidate(false);
          goNext(modelId, thisStep);
        },
        onError: (error) => {
          setAwaitInvalidate(false);
          showErrorNotification({
            error: new Error(error.message),
            title: 'Failed to save model version',
          });
        },
      });
    },
    onError: (error) => {
      setAwaitInvalidate(false);
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to save model',
      });
    },
  });

  const handleSubmit = ({ ...rest }: z.infer<typeof schema>) => {
    console.log('dirty', isDirty);
    console.log(rest);
    if (isDirty) {
      console.log('running model mutation');
      setAwaitInvalidate(true);
      // TODO [bw]: status draft is maybe wrong here
      upsertModelMutation.mutate({
        ...rest,
        status: ModelStatus.Draft,
        type: ModelType.LORA,
        uploadType: ModelUploadType.Trained,
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
            description="A specific person or character, realisitic or anime"
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
