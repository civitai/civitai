import { Badge, Button, Flex, Grid, Group, Modal, Stack, TextInput } from '@mantine/core';
import { IconArrowNarrowRight } from '@tabler/icons-react';
import React, { Fragment, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogContext';
import { getTextTagsAsList } from '~/components/Training/Form/TrainingCommon';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import type { ImageDataType } from '~/store/training.store';

export const TrainingEditTagsModal = ({
  selectedTags,
  imageList,
  modelId,
  mediaType,
  setImageList,
  setSelectedTags,
}: {
  selectedTags: string[];
  imageList: ImageDataType[];
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
  setImageList: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    imgData: ImageDataType[]
  ) => void;
  setSelectedTags: (value: string[]) => void;
}) => {
  const dialog = useDialogContext();
  const [tagChange, setTagChange] = useState<{ [key: string]: string }>(
    selectedTags.reduce((acc, s) => ({ ...acc, [s]: '' }), {})
  );

  const handleClose = dialog.onClose;

  const handleConfirm = () => {
    const newImageList = imageList.map((i) => {
      const capts = getTextTagsAsList(i.label).map((c) => {
        const foundVal = tagChange[c];
        return foundVal && foundVal.length ? foundVal : c;
      });
      return { ...i, label: capts.join(', ') };
    });
    setImageList(modelId, mediaType, newImageList);
    setSelectedTags([]);
    handleClose();
  };

  return (
    <Modal {...dialog} centered size="md" radius="md" title="Replace tags">
      <Stack>
        <Grid align="center">
          {selectedTags.map((st) => (
            <Fragment key={st}>
              <Grid.Col span={5}>
                <Badge h={36} fullWidth>
                  {st}
                </Badge>
              </Grid.Col>
              <Grid.Col span={2}>
                <Flex justify="center" align="center">
                  <IconArrowNarrowRight />
                </Flex>
              </Grid.Col>
              <Grid.Col span={5}>
                <TextInput
                  placeholder={st}
                  onChange={(e) =>
                    setTagChange({ ...tagChange, [st]: e.currentTarget?.value ?? '' })
                  }
                />
              </Grid.Col>
            </Fragment>
          ))}
        </Grid>
        <Group justify="flex-end" mt="md">
          <Button variant="light" color="gray" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Confirm</Button>
        </Group>
      </Stack>
    </Modal>
  );
};
