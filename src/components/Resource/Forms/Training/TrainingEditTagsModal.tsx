import { Badge, Button, Flex, Grid, Group, Stack, TextInput } from '@mantine/core';
import { IconArrowNarrowRight } from '@tabler/icons-react';
import React, { useState } from 'react';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import {
  getCaptionAsList,
  ImageDataType,
} from '~/components/Resource/Forms/Training/TrainingImages';

const { openModal, Modal } = createContextModal<{
  selectedTags: string[];
  imageList: ImageDataType[];
  modelId: number;
  setImageList: (modelId: number, imgData: ImageDataType[]) => void;
  setSelectedTags: (value: string[]) => void;
}>({
  title: 'Replace captions',
  name: 'trainingReplaceTags',
  centered: true,
  radius: 'lg',
  Element: ({
    context,
    props: { selectedTags, imageList, modelId, setImageList, setSelectedTags },
  }) => {
    const [tagChange, setTagChange] = useState<{ [key: string]: string }>(
      selectedTags.reduce((acc, s) => ({ ...acc, [s]: '' }), {})
    );

    const handleClose = () => context.close();

    const handleConfirm = () => {
      const newImageList = imageList.map((i) => {
        const capts = getCaptionAsList(i.caption).map((c) => {
          const foundVal = tagChange[c];
          return foundVal && foundVal.length ? foundVal : c;
        });
        return { ...i, caption: capts.join(', ') };
      });
      setImageList(modelId, newImageList);
      setSelectedTags([]);
      handleClose();
    };

    return (
      <Stack>
        <Grid align="center">
          {selectedTags.map((st) => (
            <>
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
            </>
          ))}
        </Grid>
        <Group position="right" mt="md">
          <Button variant="light" color="gray" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Confirm</Button>
        </Group>
      </Stack>
    );
  },
});

export const openTrainingEditTagsModal = openModal;
export default Modal;
