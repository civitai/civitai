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
  Grid,
} from '@mantine/core';
import { useClickOutside, useDisclosure } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import {
  IconEye,
  IconFile,
  IconHeart,
  IconLogout,
  IconPalette,
  IconPlus,
  IconSettings,
  IconUpload,
  IconUserCircle,
} from '@tabler/icons';
import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { ListSearch } from '~/components/ListSearch/ListSearch';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { BlurToggle } from '~/components/Settings/BlurToggle';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';

const HEADER_HEIGHT = 70;

const useStyles = createStyles((theme) => ({
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '100%',
    flexWrap: 'nowrap',
    paddingLeft: theme.spacing.xs * 1.6, // 16px
    paddingRight: theme.spacing.xs * 1.6, // 16px

    [theme.fn.smallerThan('sm')]: {
      paddingLeft: theme.spacing.xs * 0.8, // 8px
      paddingRight: theme.spacing.xs * 0.8, // 8px
    },
  },

  burger: {
    display: 'flex',
    justifyContent: 'flex-end',
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
    display: 'flex',
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
    <LoginRedirect key="upload-menu-item" reason="upload-model" returnUrl="/models/create">
      <Link href="/models/create" passHref>
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
      </Link>
    </LoginRedirect>,
    session?.user
      ? [
          <Link key="your-models-menu-item" href={`/?username=${session.user.username}`} passHref>
            <Anchor
              className={cx(classes.link, {
                [classes.linkActive]: router.asPath.includes(`username=${session.user.username}`),
              })}
              variant="text"
              onClick={() => closeBurger()}
            >
              <Group align="center" spacing="xs">
                <IconFile stroke={1.5} color={theme.colors.blue[6]} />
                Your models
              </Group>
            </Anchor>
          </Link>,
          <Link key="your-favorites-menu-item" href={`/?favorites=true`} passHref>
            <Anchor
              className={cx(classes.link, {
                [classes.linkActive]: router.asPath.includes(`username=${session.user.username}`),
              })}
              variant="text"
              onClick={() => closeBurger()}
            >
              <Group align="center" spacing="xs">
                <IconHeart stroke={1.5} color={theme.colors.pink[6]} stroke={1.5} />
                Liked models
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
          <BlurToggle key="nsfw-switcher">
            {({ icon, toggle }) => (
              <UnstyledButton className={classes.link} onClick={toggle}>
                <Group align="center" spacing="xs">
                  {icon}
                  Toggle NSFW blur
                </Group>
                <Switch
                  checked={!session?.user?.blurNsfw}
                  sx={{ display: 'flex', alignItems: 'center' }}
                  onClick={(e) => e.stopPropagation()}
                />
              </UnstyledButton>
            )}
          </BlurToggle>,
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
          <UnstyledButton key="user-logout" className={classes.link} onClick={() => signOut()}>
            <Group>
              <IconLogout stroke={1.5} color={theme.colors.red[9]} />
              Logout
            </Group>
          </UnstyledButton>,
        ]
      : []),
  ];

  return (
    <Header ref={ref} height={HEADER_HEIGHT} fixed>
      <Grid className={classes.header} m={0} gutter="xs" align="center">
        <Grid.Col span="auto">
          <Group spacing="xs">
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
            <LoginRedirect reason="upload-model" returnUrl="/models/create">
              <Button
                className={classes.links}
                component={NextLink}
                href="/models/create"
                variant="filled"
                size="xs"
                ml="xs"
                pl={5}
              >
                <IconPlus size={16} />
                Upload a model
              </Button>
            </LoginRedirect>
          </Group>
        </Grid.Col>
        <Grid.Col span={6} md={5}>
          <ListSearch onSearch={() => closeBurger()} />
        </Grid.Col>
        <Grid.Col span="auto" className={classes.links} sx={{ justifyContent: 'flex-end' }}>
          <Group spacing="sm">{menuItems}</Group>
          <Group spacing="xs">
            {!session ? (
              <Button
                component={NextLink}
                href={`/login?returnUrl=${router.asPath}`}
                variant="default"
              >
                Sign In
              </Button>
            ) : null}
            <BlurToggle />
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
                  <>
                    <Menu.Item
                      icon={<IconFile size={14} color={theme.colors.blue[6]} stroke={1.5} />}
                      component={NextLink}
                      href={`/?username=${session.user.username}`}
                    >
                      Your models
                    </Menu.Item>
                    <Menu.Item
                      icon={<IconHeart size={14} color={theme.colors.pink[6]} stroke={1.5} />}
                      component={NextLink}
                      href={`/?favorites=true`}
                    >
                      Liked models
                    </Menu.Item>
                  </>
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
        </Grid.Col>
        <Grid.Col span="auto" className={classes.burger}>
          <Burger
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
        </Grid.Col>
      </Grid>
    </Header>
  );
}

type Props = {
  links?: Array<{ url: string; label: string }>;
};
