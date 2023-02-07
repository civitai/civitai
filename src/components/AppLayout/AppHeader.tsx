import {
  Anchor,
  Burger,
  Button,
  createStyles,
  Group,
  Header,
  Menu,
  Switch,
  UnstyledButton,
  useMantineColorScheme,
  Transition,
  Paper,
  Grid,
  Badge,
  ActionIcon,
} from '@mantine/core';
import { useClickOutside, useDisclosure } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import {
  IconCircleDashed,
  IconCrown,
  IconFile,
  IconHeart,
  IconHistory,
  IconLogout,
  IconMoonStars,
  IconPalette,
  IconPlus,
  IconQuestionCircle,
  IconSettings,
  IconSun,
  IconUpload,
  IconUserCircle,
  IconUsers,
} from '@tabler/icons';
import { signOut } from 'next-auth/react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';

import { ListSearch } from '~/components/ListSearch/ListSearch';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Logo } from '~/components/Logo/Logo';
import { NotificationBell } from '~/components/Notifications/NotificationBell';
import { BlurToggle } from '~/components/Settings/BlurToggle';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { LoginRedirectReason } from '~/utils/login-helpers';

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

type MenuLink = {
  label: React.ReactNode;
  href: string;
  redirectReason?: LoginRedirectReason;
  visible?: boolean;
};

export function AppHeader() {
  const currentUser = useCurrentUser();
  const { classes, cx, theme } = useStyles();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const router = useRouter();

  const [burgerOpened, { open: openBurger, close: closeBurger }] = useDisclosure(false);
  const [userMenuOpened, setUserMenuOpened] = useState(false);
  const ref = useClickOutside(() => closeBurger());

  const isMuted = currentUser?.muted ?? false;

  const links: MenuLink[] = useMemo(
    () => [
      {
        href: '/models/create',
        visible: !isMuted,
        loginRedirect: 'upload-model',
        label: (
          <Group align="center" spacing="xs">
            <IconUpload stroke={1.5} />
            Upload a model
          </Group>
        ),
      },
      {
        href: `/user/${currentUser?.username}`,
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconFile stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            Your models
          </Group>
        ),
      },
      {
        href: '/?favorites=true',
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconHeart stroke={1.5} color={theme.colors.pink[theme.fn.primaryShade()]} />
            Liked models
          </Group>
        ),
      },
      {
        href: '/?hidden=true',
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconCircleDashed stroke={1.5} color={theme.colors.yellow[theme.fn.primaryShade()]} />
            Hidden models
          </Group>
        ),
      },
      {
        href: '/questions',
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconQuestionCircle stroke={1.5} />
            Questions{' '}
            <Badge color="yellow" size="xs">
              Beta
            </Badge>
          </Group>
        ),
      },
      {
        href: `/user/${currentUser?.username}/following`,
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconUsers stroke={1.5} />
            Creators you follow
          </Group>
        ),
      },
      {
        href: '/user/downloads',
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconHistory stroke={1.5} />
            Download History
          </Group>
        ),
      },
      {
        href: `/login?returnUrl=${router.asPath}`,
        visible: !currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconUserCircle stroke={1.5} />
            Sign In/Sign up
          </Group>
        ),
      },
      {
        href: '/leaderboard',
        label: (
          <Group align="center" spacing="xs">
            <IconCrown stroke={1.5} />
            Leaderboard
          </Group>
        ),
      },
    ],
    [currentUser, isMuted, router.asPath, theme]
  );

  const burgerMenuItems = useMemo(
    () =>
      links
        .filter(({ visible }) => visible !== false)
        .map((link) => {
          const item = (
            <Link key={link.href} href={link.href} passHref>
              <Anchor
                variant="text"
                className={cx(classes.link, { [classes.linkActive]: router.asPath === link.href })}
                onClick={() => closeBurger()}
              >
                {link.label}
              </Anchor>
            </Link>
          );

          return link.redirectReason ? (
            <LoginRedirect key={link.href} reason={link.redirectReason} returnUrl={link.href}>
              {item}
            </LoginRedirect>
          ) : (
            item
          );
        }),
    [classes, closeBurger, cx, links, router.asPath]
  );
  const userMenuItems = useMemo(
    () =>
      links
        .filter(({ href, visible }) => visible !== false && href !== '/models/create')
        .map((link) => (
          <Menu.Item key={link.href} component={NextLink} href={link.href}>
            {link.label}
          </Menu.Item>
        )),
    [links]
  );

  return (
    <Header ref={ref} height={HEADER_HEIGHT} fixed>
      <Grid className={classes.header} m={0} gutter="xs" align="center">
        <Grid.Col span="auto" pl={0}>
          <Group spacing="xs" noWrap>
            <Link href="/" passHref>
              <Anchor variant="text" onClick={() => closeBurger()}>
                <Logo />
              </Anchor>
            </Link>
            {!isMuted && (
              <LoginRedirect reason="upload-model" returnUrl="/models/create">
                <Button
                  className={classes.links}
                  component={NextLink}
                  href="/models/create"
                  variant="filled"
                  size="xs"
                  pl={5}
                >
                  <IconPlus size={16} />
                  Upload a model
                </Button>
              </LoginRedirect>
            )}
          </Group>
        </Grid.Col>
        <Grid.Col span={6} md={5}>
          <ListSearch onSearch={() => closeBurger()} />
        </Grid.Col>
        <Grid.Col span="auto" className={classes.links} sx={{ justifyContent: 'flex-end' }}>
          <Group spacing="xs" align="center">
            {!currentUser ? (
              <Button
                component={NextLink}
                href={`/login?returnUrl=${router.asPath}`}
                variant="default"
              >
                Sign In
              </Button>
            ) : null}

            {currentUser?.showNsfw && <BlurToggle />}
            {currentUser && <NotificationBell />}
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
                  <UserAvatar user={currentUser} avatarProps={{ size: 'md' }} />
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                {userMenuItems}
                <Menu.Item
                  closeMenuOnClick={false}
                  icon={<IconPalette stroke={1.5} />}
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

                {currentUser ? (
                  <>
                    <Menu.Item
                      icon={<IconSettings stroke={1.5} />}
                      component={NextLink}
                      href="/user/account"
                    >
                      Account settings
                    </Menu.Item>
                    <Menu.Item
                      icon={<IconLogout color={theme.colors.red[9]} stroke={1.5} />}
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
          <Group>
            {currentUser && <NotificationBell />}
            <Burger
              opened={burgerOpened}
              onClick={burgerOpened ? closeBurger : openBurger}
              size="sm"
            />
            <Transition transition="scale-y" duration={200} mounted={burgerOpened}>
              {(styles) => (
                <Paper className={classes.dropdown} withBorder style={styles}>
                  {burgerMenuItems}
                  <Group p="md" position="apart">
                    <ActionIcon
                      variant="light"
                      onClick={() => toggleColorScheme()}
                      size="lg"
                      sx={(theme) => ({
                        color:
                          theme.colorScheme === 'dark'
                            ? theme.colors.yellow[theme.fn.primaryShade()]
                            : theme.colors.blue[theme.fn.primaryShade()],
                      })}
                    >
                      {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoonStars size={18} />}
                    </ActionIcon>
                    {currentUser && (
                      <>
                        {currentUser?.showNsfw && (
                          <BlurToggle iconProps={{ stroke: 1.5 }}>
                            {({ icon, toggle }) => (
                              <ActionIcon variant="light" size="lg" onClick={toggle}>
                                {icon}
                              </ActionIcon>
                            )}
                          </BlurToggle>
                        )}
                        <Link href="/user/account" passHref>
                          <ActionIcon variant="light" component="a" size="lg" onClick={closeBurger}>
                            <IconSettings stroke={1.5} />
                          </ActionIcon>
                        </Link>
                        <ActionIcon variant="light" onClick={() => signOut()} size="lg">
                          <IconLogout
                            stroke={1.5}
                            color={theme.colors.red[theme.fn.primaryShade()]}
                          />
                        </ActionIcon>
                      </>
                    )}
                  </Group>
                </Paper>
              )}
            </Transition>
          </Group>
        </Grid.Col>
      </Grid>
    </Header>
  );
}
