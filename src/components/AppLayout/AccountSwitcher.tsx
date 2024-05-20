import {
  Avatar,
  Box,
  Button,
  createStyles,
  Divider,
  Group,
  Menu,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { IconChevronLeft, IconCircleCheck, IconLogout, IconLogout2 } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { Dispatch, SetStateAction, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  type CivitaiAccount,
  useAccountContext,
} from '~/components/CivitaiWrapped/AccountProvider';
import { Username } from '~/components/User/Username';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { getInitials } from '~/utils/string-helpers';

const useStyles = createStyles((theme) => ({
  link: {
    color: theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.colors.gray[7],
    fontSize: theme.fontSizes.sm,
    padding: theme.spacing.md,
    cursor: 'pointer',

    '&:hover': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    },
  },
}));

const ActionButtons = ({ close }: { close: () => void }) => {
  const router = useRouter();
  const { logout, logoutAll } = useAccountContext();
  const [waiting, setWaiting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);

  const handleAdd = () => {
    setWaiting(true);
    router
      .push(
        getLoginLink({
          returnUrl: router.asPath,
          reason: 'switch-accounts',
        })
      )
      .then(() => {
        close();
        setWaiting(false);
      });
  };

  const handleLogout = () => {
    setLoggingOut(true);
    logout().catch((e) => {
      setLoggingOut(false);
      showErrorNotification({
        title: 'Error logging out',
        error: new Error(e.message),
      });
    });
  };
  const handleLogoutAll = () => {
    setLoggingOutAll(true);
    logoutAll().catch((e) => {
      setLoggingOutAll(false);
      showErrorNotification({
        title: 'Error logging out',
        error: new Error(e.message),
      });
    });
  };

  return (
    <Stack spacing="xs" mb={4} px={4}>
      <Button variant="light" loading={waiting} onClick={handleAdd}>
        {waiting ? 'Redirecting...' : 'Add Account'}
      </Button>
      <Button
        variant="default"
        leftIcon={<IconLogout stroke={1.5} size={18} />}
        loading={loggingOut}
        disabled={loggingOutAll}
        onClick={handleLogout}
      >
        {loggingOut ? 'Logging out...' : 'Logout'}
      </Button>
      <Button
        variant="default"
        leftIcon={<IconLogout2 stroke={1.5} size={18} />}
        loading={loggingOutAll}
        disabled={loggingOut}
        onClick={handleLogoutAll}
      >
        {loggingOutAll ? 'Logging out...' : 'Logout All'}
      </Button>
    </Stack>
  );
};

const UserRow = ({ data }: { data: CivitaiAccount }) => {
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();

  const { avatarUrl, email, username, active } = data;

  const avatarBgColor =
    theme.colorScheme === 'dark' ? 'rgba(255,255,255,0.31)' : 'rgba(0,0,0,0.31)';

  return (
    <>
      <Group spacing={8}>
        <Tooltip label={email}>
          <Avatar
            src={
              !!avatarUrl
                ? getEdgeUrl(avatarUrl, {
                    width: 96,
                    anim: currentUser ? (!currentUser.autoplayGifs ? false : undefined) : undefined,
                  })
                : undefined
            }
            alt={email}
            radius="xl"
            size="sm"
            imageProps={{ loading: 'lazy', referrerPolicy: 'no-referrer' }}
            sx={{ backgroundColor: avatarBgColor }}
          >
            {getInitials(username)}
          </Avatar>
        </Tooltip>
        <Username username={username} />
      </Group>
      {active && <IconCircleCheck size={20} color="green" />}
    </>
  );
};

export const AccountSwitcher = ({
  inMenu = true,
  setUserSwitching,
  close,
}: {
  inMenu?: boolean;
  setUserSwitching: Dispatch<SetStateAction<boolean>>;
  close: () => void;
}) => {
  const { classes } = useStyles();
  const { accounts, swapAccount } = useAccountContext();

  if (inMenu) {
    return (
      <>
        <Menu.Item onClick={() => setUserSwitching(false)} closeMenuOnClick={false}>
          <Group>
            <IconChevronLeft />
            <Text>Back</Text>
          </Group>
        </Menu.Item>
        <Divider />
        {Object.entries(accounts).map(([k, v]) => (
          <Menu.Item
            key={k}
            onClick={v.active ? undefined : () => swapAccount(v.token)}
            sx={v.active ? { cursor: 'initial' } : {}}
          >
            <Group position="apart" w="100%">
              <UserRow data={v} />
            </Group>
          </Menu.Item>
        ))}
        <Divider mb={8} />
        <ActionButtons close={close} />
      </>
    );
  }

  return (
    <>
      <Group onClick={() => setUserSwitching(false)} className={classes.link}>
        <IconChevronLeft />
        <Text>Back</Text>
      </Group>
      <Divider />
      {Object.entries(accounts).map(([k, v]) => (
        <Group
          key={k}
          onClick={v.active ? undefined : () => swapAccount(v.token)}
          className={classes.link}
          sx={v.active ? { cursor: 'initial' } : {}}
          position="apart"
          w="100%"
        >
          <UserRow data={v} />
        </Group>
      ))}
      <Divider />
      <Box p="md">
        <ActionButtons close={close} />
      </Box>
    </>
  );
};
