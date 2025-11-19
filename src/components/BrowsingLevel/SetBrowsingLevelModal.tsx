import { Group, Modal, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import clsx from 'clsx';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  browsingLevels,
  browsingLevelLabels,
  browsingLevelDescriptions,
  browsingLevelReasons,
} from '~/shared/constants/browsingLevel.constants';
import { imageStore } from '~/store/image.store';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import classes from './SetBrowsingLevelModal.module.scss';
import type { NsfwLevel } from '~/server/common/enums';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';

export default function SetBrowsingLevelModal({
  imageId,
  nsfwLevel,
  hideLevelSelect = false,
  onSubmit,
}: SetBrowsingLevelModalProps) {
  const currentUser = useCurrentUser();
  const dialog = useDialogContext();
  const isModerator = currentUser?.isModerator;

  const [selectedNsfwLevel, setSelectedNsfwLevel] = useState<NsfwLevel>(nsfwLevel);

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

  const handleClick = (level: NsfwLevel) => {
    if (isModerator) {
      setSelectedNsfwLevel(level);
      return;
    }

    if (level !== selectedNsfwLevel) updateImageNsfwLevel.mutate({ id: imageId, nsfwLevel: level });
    dialog.onClose();
  };

  const handleSelectReason = (reason?: string) => {
    if (!selectedNsfwLevel) return;

    onSubmit?.({ level: selectedNsfwLevel, reason });
    imageStore.setImage(imageId, { nsfwLevel: selectedNsfwLevel });
    updateImageNsfwLevel.mutate({
      id: imageId,
      nsfwLevel: selectedNsfwLevel,
      reason,
    });
    dialog.onClose();
  };

  const reasons = isModerator ? browsingLevelReasons[selectedNsfwLevel] : [];

  return (
    <Modal title={isModerator ? 'Image ratings' : 'Vote for image rating'} {...dialog}>
      <Stack mt={4} gap="md">
        {!hideLevelSelect && (
          <Paper
            withBorder
            p={0}
            className={clsx(classes.root, { [classes.horizontal]: isModerator })}
          >
            {browsingLevels.map((level) => (
              <UnstyledButton
                key={level}
                p="md"
                w="100%"
                className={clsx({
                  [classes.active]: selectedNsfwLevel === level,
                  ['text-center']: isModerator,
                })}
                onClick={() => handleClick(level)}
              >
                <Text fw={700}>{browsingLevelLabels[level]}</Text>
                {!isModerator && <Text>{browsingLevelDescriptions[level]}</Text>}
              </UnstyledButton>
            ))}
          </Paper>
        )}
        {selectedNsfwLevel && isModerator && reasons.length > 0 && (
          <Stack gap="sm">
            {hideLevelSelect && (
              <Group gap={4}>
                <Text fw={600} size="lg">
                  Selected rating:
                </Text>
                <BrowsingLevelBadge size="lg" browsingLevel={selectedNsfwLevel} />
              </Group>
            )}
            <div>
              <Text fw={600} size="sm">
                Why do you think this is the appropriate rating? (optional)
              </Text>
              <Text c="dimmed" size="xs">
                Choose the closest or most appropriate reason
              </Text>
            </div>
            <Paper className={classes.root} p={0} withBorder>
              {reasons.map((reason, index) => (
                <UnstyledButton
                  key={index}
                  p="md"
                  w="100%"
                  onClick={() => handleSelectReason(reason)}
                >
                  <Text fw={500}>{reason}</Text>
                </UnstyledButton>
              ))}
            </Paper>
            <UnstyledButton
              className={classes.noReasonButton}
              p="md"
              w="100%"
              onClick={() => handleSelectReason(undefined)}
            >
              <Text fw={500}>Not defined</Text>
            </UnstyledButton>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

export interface SetBrowsingLevelModalProps {
  imageId: number;
  nsfwLevel: NsfwLevel;
  hideLevelSelect?: boolean;
  onSubmit?: (data: { level: NsfwLevel; reason: string | undefined }) => void;
}
