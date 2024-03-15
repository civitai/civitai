import { useEffect, useState } from 'react';
import { immer } from 'zustand/middleware/immer';
import { create } from 'zustand';
import { Modal, Stack, ThemeIcon, Title, Text, Button, Group } from '@mantine/core';

export function UpdateRequiredWatcher() {
  const updateRequired = useIsUpdatedRequired();
  const [dismissed, setDismissed] = useState(false);
  const showAlert = updateRequired && !dismissed;

  if (!showAlert) return null;

  return (
    <Modal
      onClose={() => setDismissed(true)}
      opened={showAlert}
      withCloseButton={false}
      closeOnEscape={false}
      closeOnClickOutside={false}
    >
      <Stack align="center">
        <ThemeIcon size={120} radius={100} color="blue" variant="light">
          <Text size={64}>🎉</Text>
        </ThemeIcon>
        <Title order={3}>New version available!</Title>
        <Text>{`It's time to refresh your browser to get the latest features. If you don't things may not work as expected.`}</Text>
        <Button onClick={() => window.location.reload()} radius="xl" size="lg">
          Update Now
        </Button>
        <Group spacing={4}>
          <Text>😬</Text>
          <Text
            variant="link"
            color="yellow"
            size="xs"
            onClick={() => setDismissed(true)}
            style={{ cursor: 'pointer' }}
          >
            {`No. I'll continue at my own peril`}
          </Text>
          <Text>😱</Text>
        </Group>
      </Stack>
    </Modal>
  );
}

type UpdateRequiredStore = {
  updateRequired: boolean;
  setUpdateRequired: (value: boolean) => void;
};
const useUpdateRequiredStore = create<UpdateRequiredStore>()(
  immer((set) => ({
    updateRequired: false,
    setUpdateRequired: (value: boolean) => {
      set((state) => {
        state.updateRequired = value;
      });
    },
  }))
);

let originalFetch: typeof window.fetch | undefined;
export const useIsUpdatedRequired = () => {
  const updateRequired = useUpdateRequiredStore((state) => state.updateRequired);
  const setUpdateRequired = useUpdateRequiredStore((state) => state.setUpdateRequired);

  useEffect(() => {
    if (originalFetch || typeof window === 'undefined') return;
    originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch!(...args);
      if (response.headers.has('x-update-required')) {
        setUpdateRequired(true);
      }
      return response;
    };
  }, []);

  return updateRequired;
};
