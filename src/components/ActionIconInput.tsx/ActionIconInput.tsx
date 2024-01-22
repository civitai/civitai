import {
  ActionIcon,
  ActionIconProps,
  Group,
  Popover,
  PopoverProps,
  TextInput,
} from '@mantine/core';
import { getHotkeyHandler, useClickOutside } from '@mantine/hooks';
import { useState } from 'react';

export function ActionIconInput<T>({
  onSubmit,
  actionIconProps,
  children,
  placeholder,
  ...popoverProps
}: {
  onSubmit: (input: string) => void;
  children: React.ReactNode;
  placeholder?: string;
  actionIconProps?: ActionIconProps;
} & Omit<PopoverProps, 'children'>) {
  const [editing, setEditing] = useState(false);
  const [control, setControl] = useState<HTMLInputElement | null>(null);
  const [toggle, setToggle] = useState<HTMLButtonElement | null>(null);

  useClickOutside(() => setEditing(false), null, [control, toggle]);
  function handleSubmit() {
    if (control) {
      onSubmit(control.value);
      control.value = '';
    }
    setEditing(false);
  }

  return (
    <Popover opened={editing} position="bottom-start" shadow="lg" {...popoverProps}>
      <Popover.Target>
        <ActionIcon
          variant="outline"
          {...actionIconProps}
          ref={setToggle}
          onClick={() => setEditing((x) => !x)}
        >
          {children}
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Group>
          <TextInput
            ref={setControl}
            variant="unstyled"
            autoFocus
            autoComplete="off"
            placeholder={placeholder}
            styles={(theme) => ({
              input: {
                fontSize: 16,
                lineHeight: 1,
                padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
                height: 'auto',
              },
            })}
            onKeyDown={getHotkeyHandler([['Enter', handleSubmit]])}
          />
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}
