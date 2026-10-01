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
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';

export default function SetBrowsingLevelModal({
  imageId,
  nsfwLevel,
  isOwner,
  hideLevelSelect = false,
  skipImageUpdate = false,
  onSubmit,
}: SetBrowsingLevelModalProps) {
  const currentUser = useCurrentUser();
  const dialog = useDialogContext();
  const isModerator = currentUser?.isModerator;

  const [selectedNsfwLevel, setSelectedNsfwLevel] = useState<NsfwLevel>(nsfwLevel);

  const updateImageNsfwLevel = trpc.image.updateImageNsfwLevel.useMutation({
    onSuccess: ({ applied }, { nsfwLevel: level }) => {
      if (isModerator) return;
      if (applied) {
        imageStore.setImage(imageId, { nsfwLevel: level });
        showSuccessNotification({ message: 'Image rating updated' });
      } else showSuccessNotification({ message: 'Image rating vote received' });
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

  const isOwnerRaise = (level: NsfwLevel) =>
    !isModerator && !!isOwner && !skipImageUpdate && level > selectedNsfwLevel;

  const handleClick = (level: NsfwLevel) => {
    if (isModerator) {
      setSelectedNsfwLevel(level);
      return;
    }

    if (level !== selectedNsfwLevel && !skipImageUpdate)
      updateImageNsfwLevel.mutate({ id: imageId, nsfwLevel: level });
    dialog.onClose();
  };

  const handleSelectReason = (reason?: string) => {
    if (!selectedNsfwLevel) return;

    onSubmit?.({ level: selectedNsfwLevel, reason });
    if (!skipImageUpdate) {
      imageStore.setImage(imageId, { nsfwLevel: selectedNsfwLevel });
      updateImageNsfwLevel.mutate({
        id: imageId,
        nsfwLevel: selectedNsfwLevel,
        reason,
      });
    }
    dialog.onClose();
  };

  // selectedNsfwLevel can be a combined bitmask (e.g. project.nsfwLevel = bit_or of chapters);
  // browsingLevelReasons is keyed by single bits, so the lookup may be undefined.
  const reasons =
    (isModerator
      ? (browsingLevelReasons as Record<number, string[] | undefined>)[selectedNsfwLevel]
      : undefined) ?? [];

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
              <PopConfirm
                key={level}
                enabled={isOwnerRaise(level)}
                withinPortal
                position="bottom"
                width={280}
                message={
                  <Text size="sm">
                    Raise this image to {browsingLevelLabels[level]}? This applies right away, and
                    lowering it again goes to review.
                  </Text>
                }
                onConfirm={() => handleClick(level)}
              >
                <UnstyledButton
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
              </PopConfirm>
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
  /** The viewer owns the image: raising its rating applies immediately, so it asks first. */
  isOwner?: boolean;
  hideLevelSelect?: boolean;
  /** When true, only calls onSubmit without updating the image nsfwLevel via the image mutation. */
  skipImageUpdate?: boolean;
  onSubmit?: (data: { level: NsfwLevel; reason: string | undefined }) => void;
}
