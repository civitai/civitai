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
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronLeft, IconCircleCheck, IconLogout } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import React, { Dispatch, SetStateAction, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  CivitaiAccount,
  CivitaiAccounts,
} from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { Username } from '~/components/User/Username';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getLoginLink } from '~/utils/login-helpers';
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

const ActionButtons = ({ logout, close }: { logout: () => Promise<void>; close: () => void }) => {
  const router = useRouter();
  const [waiting, setWaiting] = useState(false);

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

  return (
    <Stack spacing="xs" mb={4} px={4}>
      <Button variant="light" loading={waiting} onClick={handleAdd}>
        {waiting ? 'Redirecting...' : 'Add Account'}
      </Button>
      {/* TODO when logging out this way, log back into another existing account */}
      {/* TODO also add "log out all" option */}
      <Button
        variant="default"
        leftIcon={<IconLogout stroke={1.5} size={18} />}
        onClick={() => logout()}
      >
        Logout
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
  logout,
  close,
}: {
  inMenu?: boolean;
  setUserSwitching: Dispatch<SetStateAction<boolean>>;
  logout: () => Promise<void>;
  close: () => void;
}) => {
  const { classes } = useStyles();
  const router = useRouter();
  const [accounts] = useLocalStorage<CivitaiAccounts>({
    key: `civitai-accounts`,
    defaultValue: {},
    getInitialValueInEffect: false,
  });

  const swapAccount = async ({ token }: CivitaiAccount) => {
    await signIn('account-switch', { callbackUrl: router.asPath, ...token });
  };

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
            onClick={v.active ? undefined : () => swapAccount(v)}
            sx={v.active ? { cursor: 'initial' } : {}}
          >
            <Group position="apart" w="100%">
              <UserRow data={v} />
            </Group>
          </Menu.Item>
        ))}
        <Divider mb={8} />
        <ActionButtons logout={logout} close={close} />
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
          onClick={v.active ? undefined : () => swapAccount(v)}
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
        <ActionButtons logout={logout} close={close} />
      </Box>
    </>
  );
};
