import { Modal, Paper, Text, createStyles, UnstyledButton } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  browsingLevels,
  browsingLevelLabels,
  browsingLevelDescriptions,
} from '~/shared/constants/browsingLevel.constants';
import { imageStore } from '~/store/image.store';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function SetBrowsingLevelModal({
  imageId,
  nsfwLevel,
}: {
  imageId: number;
  nsfwLevel: number;
}) {
  const dialog = useDialogContext();
  const { classes, cx } = useStyles();

  const { mutate } = trpc.image.setImageNsfwLevel.useMutation({
    onError: (error) => {
      imageStore.setImage(imageId, { nsfwLevel });
      showErrorNotification({ title: 'There was an error updating the image nsfwLevel', error });
    },
  });

  return (
    <Modal title="Nsfw Levels" {...dialog}>
      <Paper withBorder p={0} className={classes.root}>
        {browsingLevels.map((level) => (
          <UnstyledButton
            key={level}
            p="md"
            w="100%"
            className={cx({ [classes.active]: nsfwLevel === level })}
            onClick={() => {
              mutate({ id: imageId, nsfwLevel: level });
              imageStore.setImage(imageId, { nsfwLevel: level });
              dialog.onClose();
            }}
          >
            <Text weight={700}>{browsingLevelLabels[level]}</Text>
            <Text>{browsingLevelDescriptions[level]}</Text>
          </UnstyledButton>
        ))}
      </Paper>
    </Modal>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    ['& > button']: {
      ['&:hover']: {
        background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[2],
        cursor: 'pointer',
      },
      ['&:not(:last-child)']: {
        borderBottom: `1px ${
          theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
        } solid`,
      },
    },
  },
  active: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],
  },
}));
