import { Box, Button, createStyles, Divider, Group, Menu, Stack, Text } from '@mantine/core';
import { IconChevronLeft } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { Dispatch, SetStateAction, useState } from 'react';
import { CivitaiAccounts } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { getLoginLink } from '~/utils/login-helpers';

const useStyles = createStyles((theme) => ({
  link: {
    // display: 'block',
    // lineHeight: 1,
    // padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
    // borderRadius: theme.radius.sm,
    // textDecoration: 'none',
    color: theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.colors.gray[7],
    fontSize: theme.fontSizes.sm,
    // fontWeight: 500,
    cursor: 'pointer',
    // justifyContent: 'flex-start !important',

    '&:hover': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    },

    // [containerQuery.smallerThan('md')]: {
    // borderRadius: 0,
    padding: theme.spacing.md,
    // display: 'flex',
    // alignItems: 'center',
    // justifyContent: 'space-between',
    // width: '100%',
    // },
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
  // const { data: userData } = useSession();
  console.log(accounts);

  const swapAccount = async (jwt: string, email: string) => {
    // console.log(jwt);
    // console.log('temp logging out');
    // await logout({ removeLS: false, redirect: false });
    // const resp = await fetch(`/api/auth/switchaccounts?token=${jwt}`);
    //
    // if (resp.ok) {
    //   // router.reload();
    //   console.log('dispatching event');
    //   dispatchEvent(new CustomEvent('account-swap'));
    // } else {
    //   const respJson: { error: string } = await resp.json();
    //   console.log(respJson.error);
    // }

    console.log(email);

    await logout({ removeLS: false, redirect: false });
    await signIn('google', { callbackUrl: router.asPath }, { login_hint: email });
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
            onClick={v.active ? undefined : () => swapAccount(v.jwt, v.email)}
            sx={v.active ? { cursor: 'initial' } : {}}
          >
            <Group>
              <UserAvatar userId={Number(k)} withUsername />
              {v.active && <Text color="dimmed">Active</Text>}
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
          onClick={v.active ? undefined : () => swapAccount(v.jwt)}
          className={classes.link}
          sx={v.active ? { cursor: 'initial' } : {}}
        >
          <UserAvatar userId={Number(k)} withUsername />
          {v.active && <Text color="dimmed">Active</Text>}
        </Group>
      ))}
      <Divider />
      <Box p="md">
        <ActionButtons logout={logout} close={close} />
      </Box>
    </>
  );
};
