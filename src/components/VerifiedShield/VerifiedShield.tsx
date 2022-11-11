import { ButtonProps, Button, Popover, Text } from '@mantine/core';
import { IconShieldCheck, IconShieldX } from '@tabler/icons';
import ReactMarkdown from 'react-markdown';

export function VerifiedShield({
  verified,
  message,
  style,
  ...props
}: { verified?: boolean; message?: string | null } & Omit<ButtonProps, 'children'>) {
  const icon = (
    <Button
      color={verified ? 'green' : 'gray'}
      style={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px', ...style }}
      {...props}
    >
      {verified ? <IconShieldCheck /> : <IconShieldX />}
    </Button>
  );

  message ??= verified ? 'This model has been verified' : 'This model has not been verified';

  return (
    <Popover withArrow width={300} position="bottom-end">
      <Popover.Target>{icon}</Popover.Target>
      <Popover.Dropdown>
        <Text weight={500} size="md" color={verified ? 'green' : 'red'} pb={5}>
          Model {verified ? 'Verified' : 'Unverified'}
        </Text>
        <ReactMarkdown className="popover-markdown">{message}</ReactMarkdown>
        <Text
          component="a"
          href="https://github.com/civitai/civitai/wiki/Model-Safety-Checks"
          target="_blank"
          size="xs"
          color="dimmed"
          td="underline"
        >
          What does this mean?
        </Text>
      </Popover.Dropdown>
    </Popover>
  );
}
