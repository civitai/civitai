import {
  Button,
  Group,
  Input,
  Modal,
  ModalProps,
  NumberInput,
  Paper,
  Slider,
  Stack,
  Text,
} from '@mantine/core';
import { IconArrowsShuffle, IconExclamationMark } from '@tabler/icons-react';
import { useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

type State = { similarity: number; quantity: number };

export function CreateVariantsModal({ onClose, ...props }: Props) {
  const [state, setState] = useState<State>({ similarity: 50, quantity: 10 });

  const handleClose = () => {
    setState({ similarity: 50, quantity: 10 });
    onClose();
  };

  return (
    <Modal
      {...props}
      onClose={handleClose}
      title={
        <Group>
          <IconArrowsShuffle size={20} /> Create Variants
        </Group>
      }
    >
      <Stack>
        <AlertWithIcon icon={<IconExclamationMark />} size="sm">
          {`This will generate images similar to the one you've selected with the level of variation driven by your selection below.`}
        </AlertWithIcon>
        <Input.Wrapper label="Similarity">
          <Group>
            <Slider
              label={(value) => `${value}%`}
              min={1}
              max={100}
              defaultValue={state.similarity}
              onChangeEnd={(value) => setState((current) => ({ ...current, similarity: value }))}
              sx={{ flex: 1 }}
            />
            <Paper p="xs" withBorder>
              <Text size="sm">{state.similarity}%</Text>
            </Paper>
          </Group>
        </Input.Wrapper>
        <Input.Wrapper label="Quantity">
          <Group>
            <Slider
              min={1}
              max={100}
              defaultValue={state.quantity}
              onChangeEnd={(value) => setState((current) => ({ ...current, quantity: value }))}
              sx={{ flex: 1 }}
            />
            <Paper p="xs" withBorder>
              <Text size="sm">{state.quantity}</Text>
            </Paper>
          </Group>
        </Input.Wrapper>
        <Group spacing={8} align="flex-end" grow>
          {/* <NumberInput label="Quantity" defaultValue={state.quantity} min={1} max={100} /> */}
          <Button onClick={handleClose}>Go</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

type Props = Omit<ModalProps, 'title' | 'children'>;
