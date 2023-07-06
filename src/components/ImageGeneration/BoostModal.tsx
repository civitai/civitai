import { Button, Checkbox, Group, Paper, Stack, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { ContextModalProps, openContextModal } from '@mantine/modals';
import { IconBolt, IconExclamationMark } from '@tabler/icons-react';
import { useRef } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Generation } from '~/server/services/generation/generation.types';

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
  const [, setShowBoost] = useLocalStorage({
    key: 'show-boost-modal',
    defaultValue: true,
  });

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
