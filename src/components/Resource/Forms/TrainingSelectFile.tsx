import {
  Button,
  Center,
  createStyles,
  Group,
  Image,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { TrainingStatus } from '@prisma/client';
import React from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ModelWithTags } from '~/components/Resource/Wizard/ModelWizard';

const useStyles = createStyles((theme) => ({
  epochRow: {
    [theme.fn.smallerThan('sm')]: {
      flexDirection: 'column',
      gap: theme.spacing.md,
    },
  },
}));

const EpochRow = ({ epoch }) => {
  console.log(epoch.sample_images);
  const { classes } = useStyles();
  return (
    <Paper radius="md" p="xs" withBorder>
      <Group position="apart" spacing={4} className={classes.epochRow}>
        {/* put buttons on top */}
        <Stack>
          {/*<div>{`Epoch #${epoch.epoch_number}`}</div>*/}
          <Button>
            <Center style={{ flexDirection: 'column' }}>
              <div>Select</div>
              <div>Epoch #{epoch.epoch_number}</div>
            </Center>
          </Button>
          <DownloadButton
            component="a"
            // href={createModelFileDownloadUrl({
            //   versionId: modalData.id as number,
            //   type: 'Training Data',
            // })}
            sx={{ flex: 1 }}
          >
            <Text align="center">
              {/*{`Download (${formatKBytes(modalData.file?.sizeKB)})`}*/}
              Download
            </Text>
          </DownloadButton>
        </Stack>
        {epoch.sample_images.map((imgUrl, index) => (
          <Stack key={index} style={{ justifyContent: 'flex-start' }}>
            {/*<div className={classes.imgOverlay}>*/}
            <Image
              alt={`Sample image #${index}`}
              src={imgUrl}
              imageProps={{
                style: {
                  height: '180px',
                  // if we want to show full image, change objectFit to contain
                  objectFit: 'cover',
                  // object-position: top;
                  width: '100%',
                },
              }}
            />
            {/*</div>*/}
            <Textarea
              autosize
              minRows={1}
              maxRows={4}
              // value={imgData.caption}
              value={'stuff'}
              readOnly
            />
          </Stack>
        ))}
      </Group>
    </Paper>
  );
};

export default function TrainingSelectFile({
  model,
  onBackClick,
  onNextClick,
}: {
  model?: ModelWithTags;
  onBackClick: () => void;
  onNextClick: () => void;
}) {
  console.log(model);
  const modelVersion = model?.modelVersions?.[0];
  console.log(modelVersion);
  // TODO [bw] need to worry about multiple files? which one will this grab?
  const modelFile = modelVersion?.files.find((f) => f.type === 'Training Data');
  console.log(modelFile);

  // you should only be able to get to this screen after having created a model, version, and uploading a training set
  if (!model || !modelVersion || !modelFile) {
    return <NotFound />;
  }

  /*
  {
  "trainingResults": {
    "epochs": [
      {
        "model_url": "https://localhost:7233/v1/consumer/jobs/ec2692d1-6c23-468a-8c42-58ff8066e0e5/assets/FoodPets_AdamW_20230818003523_e000010_01.png",
        "epoch_number": 1,
        "sample_images": [
          "/workspace/training/FoodPets_AdamW/model/sample/FoodPets_AdamW_20230818003523_e000010_00.png",
          "/workspace/training/FoodPets_AdamW/model/sample/FoodPets_AdamW_20230818003523_e000010_01.png",
          "/workspace/training/FoodPets_AdamW/model/sample/FoodPets_AdamW_20230818003525_e000010_02.png"
        ]
      }
    ],
    "end_time": "2023-08-22T23:59:02.123Z",
    "start_time": "2023-08-22T23:58:02.123Z"
  }
}
   */

  // TODO flip order on epoch_number
  const epochs = modelFile.metadata.trainingResults?.epochs.sort(function (a, b) {
    const x = a.epoch_number;
    const y = b.epoch_number;
    return x < y ? -1 : x > y ? 1 : 0;
  });

  return (
    <Stack>
      {/* TODO [bw] handle approved state? what happens when its published normally? */}
      {modelVersion.trainingStatus !== TrainingStatus.InReview || !epochs || !epochs.length ? (
        <PageLoader text="Models are currently training..." />
      ) : (
        <>
          {/* download all button */}
          <Center>
            <Title order={4}>Recommended</Title>
          </Center>
          <EpochRow epoch={epochs[0]} />
          {epochs.length > 1 && (
            <>
              <Center>
                <Title order={4}>Other Results</Title>
              </Center>
              {epochs.slice(1).map((e) => {
                <EpochRow epoch={e} />;
              })}
            </>
          )}
        </>
      )}

      <Group mt="xl" position="right">
        <Button variant="default" onClick={onBackClick}>
          Back
        </Button>
        <Button>Next</Button>
      </Group>
    </Stack>
  );
}
