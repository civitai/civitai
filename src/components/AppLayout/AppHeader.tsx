import {
  Anchor,
  Burger,
  Button,
  createStyles,
  Group,
  Header,
  Menu,
  Switch,
  Title,
  Text,
  UnstyledButton,
  useMantineColorScheme,
  Transition,
  Paper,
  Container,
} from '@mantine/core';
import { useClickOutside, useDisclosure } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import {
  IconFile,
  IconLogout,
  IconPalette,
  IconSettings,
  IconUpload,
  IconUserCircle,
} from '@tabler/icons';
import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { ListSearch } from '~/components/ListSearch/ListSearch';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';

const HEADER_HEIGHT = 70;

const useStyles = createStyles((theme) => ({
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '100%',
    padding: 0,

    [theme.fn.smallerThan('xl')]: {
      paddingLeft: theme.spacing.xs * 1.6, // 16px
      paddingRight: theme.spacing.xs * 1.6, // 16px
    },
  },

  burger: {
    [theme.fn.largerThan('md')]: {
      display: 'none',
    },
  },

  dropdown: {
    position: 'absolute',
    top: HEADER_HEIGHT,
    left: 0,
    right: 0,
    zIndex: 0,
    borderTopRightRadius: 0,
    borderTopLeftRadius: 0,
    borderTopWidth: 0,
    overflow: 'hidden',

    [theme.fn.largerThan('md')]: {
      display: 'none',
    },
  },

  search: {
    [theme.fn.smallerThan('xs')]: {
      display: 'none',
    },
  },

  links: {
    [theme.fn.smallerThan('md')]: {
      display: 'none',
    },
  },

  link: {
    display: 'block',
    lineHeight: 1,
    padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
    borderRadius: theme.radius.sm,
    textDecoration: 'none',
    color: theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.colors.gray[7],
    fontSize: theme.fontSizes.sm,
    fontWeight: 500,

    '&:hover': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    },

    [theme.fn.smallerThan('md')]: {
      borderRadius: 0,
      padding: theme.spacing.md,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
    },
  },

  linkActive: {
    '&, &:hover': {
      backgroundColor: theme.fn.variant({ variant: 'light', color: theme.primaryColor }).background,
      color: theme.fn.variant({ variant: 'light', color: theme.primaryColor }).color,
    },
  },

  user: {
    color: theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.black,
    borderRadius: theme.radius.sm,
    transition: 'background-color 100ms ease',

    '&:hover': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
    },

    [theme.fn.smallerThan('md')]: {
      display: 'none',
    },
  },

  userActive: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
  },
}));

export function AppHeader({ links }: Props) {
  const { data: session } = useSession();
  const { classes, cx, theme } = useStyles();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const router = useRouter();

  const [burgerOpened, { open: openBurger, close: closeBurger }] = useDisclosure(false);
  const [userMenuOpened, setUserMenuOpened] = useState(false);
  const ref = useClickOutside(() => closeBurger());

  const menuItems =
    links?.map((link) => (
      <Link
        key={link.label}
        href={link.url}
        passHref
        className={cx(classes.link, { [classes.linkActive]: router.asPath === link.url })}
      >
        <Anchor
          variant="text"
          className={cx(classes.link, { [classes.linkActive]: router.asPath === link.url })}
          onClick={() => closeBurger()}
        >
          {link.label}
        </Anchor>
      </Link>
    )) ?? [];
  const extendedMenuItems = [
    session?.user
      ? [
          <Link key="upload-menu-item" href="/models/create" passHref>
            <Anchor
              className={cx(classes.link, {
                [classes.linkActive]: router.asPath.includes('/models/create'),
              })}
              variant="text"
              onClick={() => closeBurger()}
            >
              <Group align="center" spacing="xs">
                <IconUpload stroke={1.5} />
                Upload a model
              </Group>
            </Anchor>
          </Link>,
          <Link key="your-models-menu-item" href={`/?user=${session.user.username}`} passHref>
            <Anchor
              className={cx(classes.link, {
                [classes.linkActive]: router.asPath.includes(`user=${session.user.username}`),
              })}
              variant="text"
              onClick={() => closeBurger()}
            >
              <Group align="center" spacing="xs">
                <IconFile stroke={1.5} />
                Your models
              </Group>
            </Anchor>
          </Link>,
        ]
      : [
          <Link key="sign-in-menu-item" href={`/login?returnUrl=${router.asPath}`} passHref>
            <Anchor
              className={cx(classes.link, {
                [classes.linkActive]: router.asPath.includes('/login'),
              })}
              variant="text"
              onClick={() => closeBurger()}
            >
              <Group align="center" spacing="xs">
                <IconUserCircle stroke={1.5} />
                Sign In/Sign up
              </Group>
            </Anchor>
          </Link>,
        ],
    ...menuItems,
    <UnstyledButton
      key="theme-switcher"
      className={classes.link}
      onClick={() => toggleColorScheme()}
    >
      <Group align="center" spacing="xs">
        <IconPalette stroke={1.5} />
        Dark mode
      </Group>
      <Switch
        checked={colorScheme === 'dark'}
        sx={{ display: 'flex', alignItems: 'center' }}
        onClick={(e) => e.stopPropagation()}
      />
    </UnstyledButton>,
    ...(session?.user
      ? [
          <Link key="your-models-menu-item" href="/user/account" passHref>
            <Anchor
              className={cx(classes.link, {
                [classes.linkActive]: router.asPath.includes('/user/account'),
              })}
              variant="text"
              onClick={() => closeBurger()}
            >
              <Group align="center" spacing="xs">
                <IconSettings stroke={1.5} />
                Account settings
              </Group>
            </Anchor>
          </Link>,
          <UnstyledButton
            key="user-logout"
            className={classes.link}
            onClick={() => signOut()}
            sx={(theme) => ({ color: theme.colors.red[9] })}
          >
            <Group>
              <IconLogout stroke={1.5} />
              Logout
            </Group>
          </UnstyledButton>,
        ]
      : []),
  ];

  return (
    <Header ref={ref} height={HEADER_HEIGHT} fixed>
      <Container size="xl" className={classes.header}>
        <Group spacing="sm">
          <Link href="/" passHref>
            <Anchor variant="text" onClick={() => closeBurger()}>
              <Title order={1}>
                C
                <Text
                  component="span"
                  sx={(theme) => ({
                    display: 'none',
                    [theme.fn.largerThan('xs')]: {
                      display: 'inline',
                    },
                  })}
                >
                  ivit
                </Text>
                <Text component="span" color="blue">
                  ai
                </Text>
              </Title>
            </Anchor>
          </Link>
          <ListSearch onSearch={() => closeBurger()} />
        </Group>
        <Group spacing="sm" className={classes.links}>
          <Group spacing="sm">{menuItems}</Group>
          <Group spacing="xs">
            {session?.user ? (
              <Button component={NextLink} href="/models/create" variant="subtle">
                Upload a model
              </Button>
            ) : (
              <Button
                component={NextLink}
                href={`/login?returnUrl=${router.asPath}`}
                variant="outline"
              >
                Sign In
              </Button>
            )}
            <Menu
              width={260}
              opened={userMenuOpened}
              position="bottom-end"
              transition="pop-top-right"
              onClose={() => setUserMenuOpened(false)}
            >
              <Menu.Target>
                <UnstyledButton
                  className={cx(classes.user, { [classes.userActive]: userMenuOpened })}
                  onClick={() => setUserMenuOpened(true)}
                >
                  <UserAvatar user={session?.user} avatarProps={{ size: 'md' }} />
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                {session?.user ? (
                  <Menu.Item
                    icon={<IconFile size={14} color={theme.colors.blue[6]} stroke={1.5} />}
                    component={NextLink}
                    // TODO - replace?
                    href={`/?user=${session.user.username}`}
                  >
                    Your models
                  </Menu.Item>
                ) : (
                  <Menu.Item component={NextLink} href={`/login?returnUrl=${router.asPath}`}>
                    Sign in/Sign up
                  </Menu.Item>
                )}

                <Menu.Item
                  closeMenuOnClick={false}
                  icon={<IconPalette size={14} stroke={1.5} />}
                  onClick={() => toggleColorScheme()}
                >
                  <Group align="center" position="apart">
                    Dark mode
                    <Switch
                      checked={colorScheme === 'dark'}
                      sx={{ display: 'flex', alignItems: 'center' }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Group>
                </Menu.Item>

                {session?.user ? (
                  <>
                    <Menu.Item
                      icon={<IconSettings size={14} stroke={1.5} />}
                      component={NextLink}
                      href="/user/account"
                    >
                      Account settings
                    </Menu.Item>
                    <Menu.Item
                      icon={<IconLogout size={14} color={theme.colors.red[9]} stroke={1.5} />}
                      onClick={() => signOut()}
                    >
                      Logout
                    </Menu.Item>
                  </>
                ) : null}
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
        <Burger
          className={classes.burger}
          opened={burgerOpened}
          onClick={burgerOpened ? closeBurger : openBurger}
          size="sm"
        />
        <Transition transition="scale-y" duration={200} mounted={burgerOpened}>
          {(styles) => (
            <Paper className={classes.dropdown} withBorder style={styles}>
              {extendedMenuItems}
            </Paper>
          )}
        </Transition>
      </Container>
    </Header>
  );
}

type Props = {
  links?: Array<{ url: string; label: string }>;
};
