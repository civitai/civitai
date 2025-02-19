import {
  Button,
  ButtonProps,
  Drawer,
  Menu,
  Text,
  UnstyledButton,
  useMantineTheme,
} from '@mantine/core';
import { IconCheck, IconChevronDown, IconSortDescending } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { useIsMobile } from '~/hooks/useIsMobile';

type SelectMenu<T extends string | number> = {
  label: React.ReactNode;
  options: { label: React.ReactNode; value: T }[];
  onClick: (value: T) => void;
  value?: T;
  disabled?: boolean;
  children?: React.ReactNode;
} & ButtonProps;

export function SelectMenu<T extends string | number>({
  label,
  options,
  onClick,
  value,
  disabled,
  children,
}: SelectMenu<T>) {
  const theme = useMantineTheme();

  return (
    <Menu withArrow disabled={disabled}>
      <Menu.Target>
        <div
          className="flex cursor-pointer items-center gap-1.5"
          style={disabled ? { opacity: 0.3, cursor: 'default', userSelect: 'none' } : {}}
        >
          <Text weight={700} transform="uppercase" suppressHydrationWarning>
            {label}
          </Text>
          <IconChevronDown size={16} stroke={3} />
        </div>
      </Menu.Target>
      <Menu.Dropdown>
        <>
          {options.map((option) => (
            <Menu.Item key={option.value.toString()} onClick={() => onClick(option.value)}>
              <Text
                transform="uppercase"
                ta="center"
                color={option.value === value ? theme.primaryColor : undefined}
                weight={option.value === value ? 700 : undefined}
              >
                {option.label}
              </Text>
            </Menu.Item>
          ))}
          {children}
        </>
      </Menu.Dropdown>
    </Menu>
  );
}

export function SelectMenuV2<T extends string | number>({
  label,
  options,
  onClick,
  value,
  disabled,
  children,
  icon,
  className,
  ...buttonProps
}: SelectMenu<T> & {
  icon?: React.ReactNode;
}) {
  const theme = useMantineTheme();
  const [opened, setOpened] = useState(false);
  const mobile = useIsMobile();

  const targetOld = (
    <Button
      disabled={disabled}
      rightIcon={
        <IconChevronDown
          className="transition-transform group-data-[expanded=true]:rotate-180"
          size={16}
        />
      }
      className={clsx(
        'group h-8 rounded-3xl bg-transparent px-2',
        'text-gray-8 hover:bg-gray-2 data-[expanded=true]:bg-gray-3',
        'dark:text-white dark:hover:bg-dark-5 dark:data-[expanded=true]:bg-dark-4',
        className
      )}
      {...buttonProps}
      onClick={() => setOpened((o) => !o)}
    >
      <div className="flex items-center gap-1" suppressHydrationWarning>
        {icon ?? <IconSortDescending size={16} />}
        {label}
      </div>
    </Button>
  );

  const target = (
    <FilterButton
      disabled={disabled}
      icon={IconSortDescending}
      onClick={() => setOpened((o) => !o)}
    >
      {label}
    </FilterButton>
  );

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          position="bottom"
          opened={opened}
          onClose={() => setOpened(false)}
          styles={{
            root: { zIndex: 400 },
            body: { padding: 16, paddingTop: 0, overflow: 'auto' },
            drawer: { height: 'auto' },
            header: { padding: '4px 8px' },
            closeButton: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
          closeButtonLabel="Close sort menu"
        >
          <div className="flex flex-col gap-2">
            {options.map((option) => {
              const active = option.value === value;

              return (
                <UnstyledButton
                  key={option.value.toString()}
                  className={clsx('rounded-md px-2.5 py-3', {
                    ['bg-gray-0 dark:bg-dark-4']: active,
                  })}
                  onClick={() => {
                    onClick(option.value);
                    setOpened(false);
                  }}
                >
                  <div className="flex justify-between">
                    <Text inline>{option.label}</Text>
                    {active && (
                      <Text color={theme.primaryColor} inline>
                        <IconCheck size={16} color="currentColor" />
                      </Text>
                    )}
                  </div>
                </UnstyledButton>
              );
            })}
          </div>
        </Drawer>
      </>
    );

  return (
    <Menu
      position="bottom-end"
      shadow="md"
      radius={12}
      width={256}
      onChange={setOpened}
      disabled={disabled}
    >
      <Menu.Target>{target}</Menu.Target>
      <Menu.Dropdown p={8}>
        <>
          {options.map((option) => {
            const active = option.value === value;

            return (
              <Menu.Item
                key={option.value.toString()}
                onClick={() => onClick(option.value)}
                data-hovered={`${active}`}
                rightSection={
                  active && (
                    <Text color={theme.primaryColor} inline>
                      <IconCheck size={16} color="currentColor" />
                    </Text>
                  )
                }
              >
                {option.label}
              </Menu.Item>
            );
          })}
          {children}
        </>
      </Menu.Dropdown>
    </Menu>
  );
}
