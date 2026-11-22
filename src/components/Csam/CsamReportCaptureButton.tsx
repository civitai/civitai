import { Button, Loader, Modal, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** A report's preserved capture, for the person filing a supplemental. Each open is recorded. */
export function CsamReportCaptureButton({ reportId }: { reportId: number }) {
  const [opened, setOpened] = useState(false);
  const read = trpc.csam.readReportCapture.useMutation({
    // Not kept once the modal closes.
    gcTime: 0,
    onError: (error) => showErrorNotification({ error, title: 'Could not read the capture' }),
  });
  const close = () => {
    setOpened(false);
    read.reset();
  };

  return (
    <>
      <Button
        size="compact-xs"
        variant="light"
        onClick={() => {
          setOpened(true);
          read.mutate({ reportId });
        }}
      >
        Read capture
      </Button>
      <Modal opened={opened} onClose={close} title={`Capture of report ${reportId}`} size="xl">
        {read.isPending ? (
          <Loader size="sm" />
        ) : read.data === null ? (
          <Text size="sm">This report has no captured text.</Text>
        ) : read.data ? (
          <Stack gap="md">
            <Text size="xs" c="dimmed">
              Your read was recorded at {read.data.readAt}.
            </Text>
            {read.data.blocks.map((block, i) => (
              <Text key={i} size="sm" className="whitespace-pre-wrap break-words">
                {block}
              </Text>
            ))}
          </Stack>
        ) : null}
      </Modal>
    </>
  );
}
