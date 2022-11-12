import {
  Badge,
  BadgeProps,
  createStyles,
  Stack,
  Text,
  Popover,
  Button,
  ThemeIcon,
  Center,
  Group,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { IconEyeOff, IconKey, IconLock } from '@tabler/icons';
import { useSession } from 'next-auth/react';
import React, { useMemo } from 'react';
import { useState } from 'react';

const SensitiveContentContext = React.createContext<{
  show: boolean;
  setShow: React.Dispatch<React.SetStateAction<boolean>>;
}>({ show: false, setShow: () => undefined });
const useSensitiveContentContext = () => React.useContext(SensitiveContentContext);

type SensitiveContentProps = {
  controls?: React.ReactNode;
  children: React.ReactNode;
  placeholder?: React.ReactNode;
} & Omit<React.ComponentPropsWithoutRef<'div'>, 'placeholder'>;

export const SensitiveContent = ({
  children,
  controls,
  className,
  placeholder,
  ...rootProps
}: SensitiveContentProps) => {
  const { classes, cx } = useStyles();
  const [show, setShow] = useState(false);
  const { data: session } = useSession();
  const shouldBlur = session?.user?.blurNsfw ?? true;
  if (!shouldBlur) return <>{children}</>;

  return (
    <SensitiveContentContext.Provider value={{ show, setShow }}>
      <div
        className={cx(classes.root, className)}
        {...rootProps}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={classes.controls}>{controls ?? <SensitiveContentToggle m="md" />}</div>
        {!show ? (
          <>
            {placeholder}
            <Stack align="center" spacing={0} className={classes.message}>
              <IconEyeOff size={20} color="white" />
              <Text color="white">Sensitive Content</Text>
              <Text size="xs" color="white" align="center">
                This is marked as NSFW
              </Text>
            </Stack>
          </>
        ) : (
          children
        )}
      </div>
    </SensitiveContentContext.Provider>
  );
};

type SensitiveContentToggleProps = BadgeProps;
const SensitiveContentToggle = ({ ...props }: SensitiveContentToggleProps) => {
  const { show, setShow } = useSensitiveContentContext();
  const { data: session } = useSession();
  const [opened, { close, open }] = useDisclosure(false);
  const isAuthenticated = !!session?.user;

  const badge = (
    <Badge
      component="div"
      color="red"
      variant="filled"
      size="sm"
      sx={{ cursor: 'pointer', userSelect: 'none' }}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        if (isAuthenticated) setShow((value) => !value);
        else opened ? close() : open();
      }}
      {...props}
    >
      {!show ? 'Show' : 'Hide'}
    </Badge>
  );

  if (isAuthenticated) return badge;

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const returnUrl = useMemo(() => {
    const { pathname, search } = window.location;
    return pathname + search;
  }, []);
  return (
    <Popover
      width={300}
      position="bottom"
      opened={opened}
      withArrow
      closeOnClickOutside
      withinPortal
    >
      <Popover.Target>{badge}</Popover.Target>
      <Popover.Dropdown>
        <Stack spacing="xs">
          <Group>
            <ThemeIcon color="red" size="xl" variant="outline">
              <IconLock />
            </ThemeIcon>
            <Text size="sm" weight={500} sx={{ flex: 1 }}>
              You must be logged in to view NSFW content
            </Text>
          </Group>

          <Button size="xs" component={NextLink} href={`/login?returnUrl=${returnUrl}`}>
            Login
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
};

SensitiveContent.Toggle = SensitiveContentToggle;

const useStyles = createStyles(() => ({
  root: {
    position: 'relative',
  },
  controls: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  message: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
  },
}));
