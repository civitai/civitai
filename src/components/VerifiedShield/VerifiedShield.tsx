import { ButtonProps, Button, Popover } from '@mantine/core';
import { IconShieldCheck, IconShieldX } from '@tabler/icons';
import ReactMarkdown from 'react-markdown';

export function VerifiedShield({
  verified,
  message,
  style,
  ...props
}: { verified?: boolean; message?: string | null } & Omit<ButtonProps, 'children'>) {
  const icon = (
    <Button color={verified ? 'blue' : 'gray'} style={{ cursor: 'pointer', ...style }} {...props}>
      {verified ? <IconShieldCheck /> : <IconShieldX />}
    </Button>
  );

  if (!message) {
    message = verified ? 'This model has been verified' : 'This model has not been verified';
  }

  return (
    <Popover withArrow>
      <Popover.Target>{icon}</Popover.Target>
      <Popover.Dropdown>
        <ReactMarkdown>{message}</ReactMarkdown>
      </Popover.Dropdown>
    </Popover>
  );
}
