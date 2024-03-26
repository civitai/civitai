import { Modal, Paper, Text, createStyles, UnstyledButton } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  browsingLevels,
  browsingLevelLabels,
  browsingLevelDescriptions,
} from '~/shared/constants/browsingLevel.constants';
import { imageStore } from '~/store/image.store';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function SetBrowsingLevelModal({
  imageId,
  nsfwLevel,
}: {
  imageId: number;
  nsfwLevel: number;
}) {
  const currentUser = useCurrentUser();
  const dialog = useDialogContext();
  const { classes, cx } = useStyles();
  const isModerator = currentUser?.isModerator;

  const updateImageNsfwLevel = trpc.image.updateImageNsfwLevel.useMutation({
    onSuccess: () => {
      if (!isModerator) showSuccessNotification({ message: 'Image rating vote received' });
    },
    onError: (error) => {
      if (isModerator) {
        imageStore.setImage(imageId, { nsfwLevel });
        showErrorNotification({ title: 'There was an error updating the image nsfwLevel', error });
      } else {
        showErrorNotification({ title: 'There was an error making this request', error });
      }
    },
  });

  const handleClick = (level: number) => {
    if (isModerator) imageStore.setImage(imageId, { nsfwLevel: level });
    updateImageNsfwLevel.mutate({ id: imageId, nsfwLevel: level });
    dialog.onClose();
  };

  return (
    <Modal title={isModerator ? 'Image ratings' : 'Vote for image rating'} {...dialog}>
      <Paper withBorder p={0} className={classes.root}>
        {browsingLevels.map((level) => (
          <UnstyledButton
            key={level}
            p="md"
            w="100%"
            className={cx({ [classes.active]: nsfwLevel === level })}
            onClick={() => handleClick(level)}
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
