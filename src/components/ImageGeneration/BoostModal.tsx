import { Button, Checkbox, Group, Paper, Stack, Text } from '@mantine/core';
import { ContextModalProps, openContextModal } from '@mantine/modals';
import { IconBolt, IconExclamationMark } from '@tabler/icons-react';
import { useRef } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Generation } from '~/server/services/generation/generation.types';

type BoostModalState = {
  showBoost: boolean;
  setShowBoost: (value: boolean) => void;
};

// if localStorage becomes an issue with nextjs, maybe try something like this:
// https://github.com/pmndrs/zustand/issues/1145#issuecomment-1556132781
export const useBoostModalStore = create<BoostModalState>()(
  persist(
    immer((set, get) => ({
      showBoost: true,
      setShowBoost: (value) =>
        set((state) => {
          state.showBoost = value;
        }),
    })),
    {
      name: 'boost-modal',
    }
  )
);

type BoostModalProps = {
  request: Generation.Request;
  cb?: (request: Generation.Request) => void;
};

export default function BoostModal2({
  context,
  id,
  innerProps: { request, cb },
}: ContextModalProps<BoostModalProps>) {
  const hideBoostRef = useRef(false);
  const submittedRef = useRef(false);
  const setShowBoost = useBoostModalStore((state) => state.setShowBoost);

  const handleSubmit = () => {
    if (submittedRef.current) return; // limit to one submission
    if (hideBoostRef.current === true) setShowBoost(false);
    cb?.(request);
    context.closeModal(id);
  };

  return (
    <Stack>
      <AlertWithIcon icon={<IconExclamationMark />} size="sm">
        {`When there is too much demand or you've already generated a large quantity of images in a month, you may notice slower generation times. Boosting with Buzz, allows you to speed up the generation time of a single job when you don't want to wait.`}
      </AlertWithIcon>
      <Group position="center">
        <Stack align="center">
          <Paper p="sm" withBorder>
            <Group spacing={8}>
              <IconBolt size={24} />
              <Text size="md" inline>
                10
              </Text>
            </Group>
          </Paper>
          <Checkbox
            label="Don't show me this again"
            defaultChecked={hideBoostRef.current}
            onChange={(event) => {
              hideBoostRef.current = event.target.checked;
            }}
          />
        </Stack>
      </Group>
      <Group spacing={8} align="flex-end" grow>
        <Button onClick={handleSubmit}>Boost it!</Button>
      </Group>
    </Stack>
  );
}

export const openBoostModal = (innerProps: BoostModalProps) => {
  openContextModal({
    modal: 'boostModal',
    title: (
      <Group>
        <IconBolt size={20} /> Boost
      </Group>
    ),
    innerProps,
    zIndex: 400,
  });
};
