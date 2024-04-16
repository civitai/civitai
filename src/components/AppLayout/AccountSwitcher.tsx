import { Box, Button, createStyles, Divider, Group, Menu, Stack, Text } from '@mantine/core';
import { IconChevronLeft, IconExclamationCircle } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { Dispatch, SetStateAction, useState } from 'react';
import {
  CivitaiAccount,
  CivitaiAccounts,
} from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { socialItems } from '~/components/Social/Social';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { getLoginLink } from '~/utils/login-helpers';

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

const ActionButtons = ({
  logout,
  close,
}: {
  logout: ({ removeLS, redirect }?: { removeLS?: boolean; redirect?: boolean }) => Promise<void>;
  close: () => void;
}) => {
  const router = useRouter();
  const [waiting, setWaiting] = useState(false);

  return (
    <Stack spacing="xs">
      <Button
        // component={NextLink}
        // href={getLoginLink({ returnUrl: router.asPath, reason: 'switch-accounts' })}
        variant="light"
        loading={waiting}
        onClick={async () => {
          setWaiting(true);
          // TODO is this not working?
          // await logout({ removeLS: false, redirect: false });
          await logout({ removeLS: false });

          console.log('awaited logout, pushing');
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
        }}
      >
        {waiting ? 'Logging out...' : 'Add Account'}
      </Button>
      <Button variant="light" color="grape" onClick={() => logout()}>
        Logout
      </Button>
    </Stack>
  );
};

export const AccountSwitcher = ({
  inMenu = true,
  setUserSwitching,
  accounts,
  logout,
  close,
}: {
  inMenu?: boolean;
  setUserSwitching: Dispatch<SetStateAction<boolean>>;
  accounts: CivitaiAccounts;
  logout: ({ removeLS, redirect }?: { removeLS?: boolean; redirect?: boolean }) => Promise<void>;
  close: () => void;
}) => {
  const { classes } = useStyles();
  const router = useRouter();

  const swapAccount = async ({ provider, email }: CivitaiAccount) => {
    await logout({ removeLS: false, redirect: false });

    if (provider !== 'email') {
      await signIn(provider, { callbackUrl: router.asPath }, { login_hint: email });
    } else {
      signIn('email', { email, redirect: false });
    }
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
        {Object.entries(accounts).map(([k, v]) => {
          const { Icon } = socialItems[v.provider] ?? {};
          return (
            <Menu.Item
              key={k}
              onClick={v.active ? undefined : () => swapAccount(v)}
              sx={v.active ? { cursor: 'initial' } : {}}
            >
              <Group>
                {Icon ? <Icon size={16} /> : <IconExclamationCircle size={26} />}
                <UserAvatar userId={Number(k)} withUsername />
                {v.active && <Text color="dimmed">Active</Text>}
              </Group>
            </Menu.Item>
          );
        })}
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
      {Object.entries(accounts).map(([k, v]) => {
        const { Icon } = socialItems[v.provider] ?? {};
        return (
          <Group
            key={k}
            onClick={v.active ? undefined : () => swapAccount(v)}
            className={classes.link}
            sx={v.active ? { cursor: 'initial' } : {}}
          >
            {Icon ? <Icon size={16} /> : <IconExclamationCircle size={26} />}
            <UserAvatar userId={Number(k)} withUsername />
            {v.active && <Text color="dimmed">Active</Text>}
          </Group>
        );
      })}
      <Divider />
      <Box p="md">
        <ActionButtons logout={logout} close={close} />
      </Box>
    </>
  );
};
