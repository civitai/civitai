import { Divider, Group, Modal, Stack, Text } from '@mantine/core';
import { useDialogContext } from '../DialogProvider';
import { IconCheck, IconCircleX, IconInfoCircle } from '@tabler/icons-react';

const DIALOG_TYPES = ['success', 'error', 'info'] as const;
type DialogType = (typeof DIALOG_TYPES)[number];

type Props = {
  type: DialogType;
  children?: React.ReactNode | ((props: { handleClose: () => void }) => React.ReactNode);
  title?: string | React.ReactNode;
  icon?: React.ReactNode;
};

const DEFAULT_DIALOG_TEMPLATES: Record<DialogType, Omit<Props, 'type'>> = {
  success: {
    title: 'Success!',
    icon: <IconCheck size={22} />,
    children: <Text>Operation completed successfully</Text>,
  },
  error: {
    title: 'Error',
    icon: <IconCircleX size={22} />,
    children: <Text>Something went wrong. Please try again later</Text>,
  },
  info: {
    title: 'Hey, Listen!',
    icon: <IconInfoCircle size={22} />,
  },
};

export const AlertDialog = ({ type, ...props }: Props) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { children, icon, title } = {
    ...DEFAULT_DIALOG_TEMPLATES[type],
    ...props,
  };

  return (
    <Modal {...dialog} size="sm" withCloseButton={false} radius="md">
      {title ? (
        <Stack align="center">
          <Group spacing="xs">
            {icon}
            {typeof title === 'string' ? (
              <Text size="lg" weight="bold">
                {title}
              </Text>
            ) : (
              title
            )}
          </Group>
          <Divider mx="-lg" />
          <Stack>{typeof children === 'function' ? children({ handleClose }) : children}</Stack>
        </Stack>
      ) : typeof children === 'function' ? (
        children({ handleClose })
      ) : (
        children
      )}
    </Modal>
  );
};
