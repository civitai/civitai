import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Burger,
  Button,
  createStyles,
  Divider,
  Grid,
  Group,
  GroupProps,
  Header,
  MantineSize,
  Menu,
  Paper,
  ScrollArea,
  Switch,
  Text,
  Transition,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { useClickOutside, useDisclosure } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import {
  IconBarbell,
  IconBookmark,
  IconCircleDashed,
  IconClockBolt,
  IconCrown,
  IconHeart,
  IconHistory,
  IconInfoSquareRounded,
  IconLogout,
  IconMoneybag,
  IconMoonStars,
  IconPalette,
  IconPhotoUp,
  IconPlaylistAdd,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSun,
  IconUpload,
  IconUser,
  IconUserCircle,
  IconUsers,
  IconWriting,
} from '@tabler/icons-react';
import { signOut } from 'next-auth/react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Fragment, RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowsingModeIcon, BrowsingModeMenu } from '~/components/BrowsingMode/BrowsingMode';
import { CivitaiLinkPopover } from '~/components/CivitaiLink/CivitaiLinkPopover';
import { useHomeSelection } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { ListSearch } from '~/components/ListSearch/ListSearch';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Logo } from '~/components/Logo/Logo';
import { ModerationNav } from '~/components/Moderation/ModerationNav';
import { NotificationBell } from '~/components/Notifications/NotificationBell';
import { UploadTracker } from '~/components/Resource/UploadTracker';
import { BlurToggle } from '~/components/Settings/BlurToggle';
import { SupportButton } from '~/components/SupportButton/SupportButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LoginRedirectReason } from '~/utils/login-helpers';
import { AutocompleteSearch } from '../AutocompleteSearch/AutocompleteSearch';
import { UserBuzz } from '../User/UserBuzz';

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
    [theme.fn.smallerThan('md')]: {
      display: 'none',
    },
  },

  searchArea: {
    [theme.fn.smallerThan('md')]: {
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
    borderRadius: theme.radius.xl,
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

  mobileSearchWrapper: {
    height: '100%',
  },

  dNone: {
    display: 'none',
  },
}));

type MenuLink = {
  label: React.ReactNode;
  href: string;
  redirectReason?: LoginRedirectReason;
  visible?: boolean;
  as?: string;
};

function defaultRenderSearchComponent({ onSearchDone, isMobile, ref }: RenderSearchComponentProps) {
  if (isMobile) {
    return (
      <AutocompleteSearch
        variant="filled"
        onClear={onSearchDone}
        onSubmit={onSearchDone}
        rightSection={null}
        ref={ref}
      />
    );
  }

  return <AutocompleteSearch />;
}

export function AppHeader({ renderSearchComponent = defaultRenderSearchComponent }: Props) {
  const currentUser = useCurrentUser();
  const { classes, cx, theme } = useStyles();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const router = useRouter();
  const features = useFeatureFlags();

  const [burgerOpened, { open: openBurger, close: closeBurger }] = useDisclosure(false);
  const [userMenuOpened, setUserMenuOpened] = useState(false);
  const ref = useClickOutside(() => closeBurger());
  const searchRef = useRef<HTMLInputElement>(null);
  const { url: homeUrl } = useHomeSelection();

  const isMuted = currentUser?.muted ?? false;

  const mainActions = useMemo<MenuLink[]>(
    () => [
      {
        href: '/models/create',
        visible: !isMuted,
        redirectReason: 'upload-model',
        label: (
          <Group align="center" spacing="xs">
            <IconUpload stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            Upload a model
          </Group>
        ),
      },
      {
        href: '/models/train',
        visible: !isMuted && features.imageTraining,
        redirectReason: 'train-model',
        label: (
          <Group align="center" spacing="xs">
            <IconBarbell stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            Train a model
          </Group>
        ),
      },
      {
        href: '/posts/create',
        visible: !isMuted,
        redirectReason: 'post-images',
        label: (
          <Group align="center" spacing="xs">
            <IconPhotoUp stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            Post images
          </Group>
        ),
      },
      {
        href: '/articles/create',
        visible: !isMuted,
        redirectReason: 'create-article',
        label: (
          <Group align="center" spacing="xs">
            <IconWriting stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            Write an article
          </Group>
        ),
      },
      {
        href: '/bounties/create',
        visible: !isMuted && features.bounties,
        redirectReason: 'create-bounty',
        label: (
          <Group align="center" spacing="xs">
            <IconMoneybag stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            Create a bounty
          </Group>
        ),
      },
    ],
    [features.bounties, features.imageTraining, isMuted, theme]
  );
  const links = useMemo<MenuLink[]>(
    () => [
      {
        href: `/user/${currentUser?.username}`,
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconUser stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            Your profile
          </Group>
        ),
      },
      {
        href: `/user/${currentUser?.username}/models?section=training`,
        visible: !!currentUser && features.imageTraining,
        label: (
          <Group align="center" spacing="xs">
            <IconBarbell stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            Training
          </Group>
        ),
      },
      {
        href: `/collections`,
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconPlaylistAdd stroke={1.5} color={theme.colors.pink[theme.fn.primaryShade()]} />
            My collections
          </Group>
        ),
      },
      {
        href: `${features.alternateHome ? '/models' : '/'}?favorites=true`,
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconHeart stroke={1.5} color={theme.colors.pink[theme.fn.primaryShade()]} />
            Liked models
          </Group>
        ),
      },
      {
        href: '/articles?favorites=true&view=feed',
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconBookmark stroke={1.5} color={theme.colors.pink[theme.fn.primaryShade()]} />
            Bookmarked articles
          </Group>
        ),
      },
      {
        href: '/bounties?engagement=favorite',
        as: '/bounties',
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconMoneybag stroke={1.5} color={theme.colors.pink[theme.fn.primaryShade()]} />
            My bounties
          </Group>
        ),
      },
      {
        href: '',
        label: <Divider />,
      },
      {
        href: '/leaderboard/overall',
        label: (
          <Group align="center" spacing="xs">
            <IconCrown stroke={1.5} color={theme.colors.yellow[theme.fn.primaryShade()]} />
            Leaderboard
          </Group>
        ),
      },
      {
        href: `${features.alternateHome ? '/models' : '/'}?hidden=true`,
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconCircleDashed stroke={1.5} color={theme.colors.yellow[theme.fn.primaryShade()]} />
            Hidden models
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
            Download history
          </Group>
        ),
      },
      {
        href: '/user/transactions',
        visible: !!features.buzz,
        label: (
          <Group align="center" spacing="xs">
            <IconClockBolt stroke={1.5} />
            Buzz transactions
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
        href: '/questions',
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconInfoSquareRounded stroke={1.5} />
            Questions{' '}
            <Badge color="yellow" size="xs">
              Beta
            </Badge>
          </Group>
        ),
      },
    ],
    [
      currentUser,
      features.imageTraining,
      features.alternateHome,
      features.buzz,
      router.asPath,
      theme,
    ]
  );

  const burgerMenuItems = useMemo(
    () =>
      mainActions
        .concat([{ href: '', label: <Divider /> }, ...links])
        .filter(({ visible }) => visible !== false)
        .map((link, index) => {
          const item = link.href ? (
            <Link key={link.href} href={link.href} as={link.as} passHref>
              <Anchor
                variant="text"
                className={cx(classes.link, { [classes.linkActive]: router.asPath === link.href })}
                onClick={() => closeBurger()}
              >
                {link.label}
              </Anchor>
            </Link>
          ) : (
            <Fragment key={`separator-${index}`}>{link.label}</Fragment>
          );

          return link.redirectReason ? (
            <LoginRedirect key={link.href} reason={link.redirectReason} returnUrl={link.href}>
              {item}
            </LoginRedirect>
          ) : (
            item
          );
        }),
    [classes, closeBurger, cx, links, mainActions, router.asPath]
  );
  const userMenuItems = useMemo(
    () =>
      links
        .filter(({ visible }) => visible !== false)
        .map((link, index) =>
          link.href ? (
            <Menu.Item key={link.href} component={NextLink} href={link.href} as={link.as}>
              {link.label}
            </Menu.Item>
          ) : (
            <Fragment key={`separator-${index}`}>{link.label}</Fragment>
          )
        ),
    [links]
  );
  const [showSearch, setShowSearch] = useState(false);
  const onSearchDone = () => setShowSearch(false);

  useEffect(() => {
    if (showSearch && searchRef.current) {
      searchRef.current.focus(); // Automatically focus input on mount
    }
  }, [showSearch]);

  const BuzzMenuItem = useCallback(
    ({
      textSize = 'xs',
      withAbbreviation = true,
      ...groupProps
    }: GroupProps & {
      textSize?: MantineSize;
      withAbbreviation?: boolean;
    }) => {
      if (!features.buzz) return null;
      if (!currentUser) return null;

      return (
        <Group
          p="sm"
          position="apart"
          mx={-4}
          mt={-4}
          sx={(theme) => ({
            backgroundColor:
              theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2],
          })}
          noWrap
          {...groupProps}
        >
          <Group spacing={4} noWrap>
            <UserBuzz
              iconSize={16}
              user={currentUser}
              textSize={textSize}
              withAbbreviation={withAbbreviation}
              withTooltip
            />
          </Group>
          {/* TODO.buzz: Replace this with button below when buying is available */}
          <Paper radius="xl" py={4} px={12}>
            <Text size="xs" weight={600}>
              Available Buzz
            </Text>
          </Paper>
          {/* TODO.buzz: Once buying is available, uncomment this block */}
          {/* <Button
            variant="white"
            radius="xl"
            size={buttonSize}
            px={12}
            onClick={() => openBuyBuzzModal({})}
            compact
          >
            Buy More Buzz
          </Button> */}
        </Group>
      );
    },
    [currentUser, features.buzz]
  );

  return (
    <Header ref={ref} height={HEADER_HEIGHT} fixed zIndex={200}>
      <Box className={cx(classes.mobileSearchWrapper, { [classes.dNone]: !showSearch })}>
        {renderSearchComponent({ onSearchDone, isMobile: true, ref: searchRef })}
      </Box>

      <Grid
        className={cx(classes.header, { [classes.dNone]: showSearch })}
        m={0}
        gutter="xs"
        align="center"
      >
        <Grid.Col span="auto" pl={0}>
          <Group spacing="xs" noWrap>
            <Link href={homeUrl ?? '/'} passHref>
              <Anchor variant="text" onClick={() => closeBurger()}>
                <Logo />
              </Anchor>
            </Link>
            {!isMuted && (
              <Menu position="bottom-start" withArrow>
                <Menu.Target>
                  <ActionIcon
                    className={classes.links}
                    size={30}
                    variant="filled"
                    color="green"
                    radius={10}
                    sx={(theme) => ({
                      backgroundColor: '#529C4F',
                      color: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
                    })}
                  >
                    <IconPlus size={25} stroke={2.5} />
                  </ActionIcon>
                  {/* <Button className={classes.links} variant="filled" color="green" size="xs" pl={5}>
                    <IconPlus size={16} /> New
                  </Button> */}
                </Menu.Target>
                <Menu.Dropdown>
                  {mainActions
                    .filter(({ visible }) => visible !== false)
                    .map((link, index) => {
                      const menuItem = (
                        <Menu.Item
                          key={!link.redirectReason ? index : undefined}
                          component={NextLink}
                          href={link.href}
                          as={link.as}
                        >
                          {link.label}
                        </Menu.Item>
                      );

                      return link.redirectReason ? (
                        <LoginRedirect
                          key={index}
                          reason={link.redirectReason}
                          returnUrl={link.href}
                        >
                          {menuItem}
                        </LoginRedirect>
                      ) : (
                        menuItem
                      );
                    })}
                </Menu.Dropdown>
              </Menu>
            )}
            <SupportButton />
          </Group>
        </Grid.Col>
        <Grid.Col
          span={6}
          md={5}
          className={features.enhancedSearch ? classes.searchArea : undefined}
        >
          {features.enhancedSearch ? (
            <>{renderSearchComponent({ onSearchDone, isMobile: false })}</>
          ) : (
            <ListSearch onSearch={() => closeBurger()} />
          )}
        </Grid.Col>
        <Grid.Col span="auto" className={classes.links} sx={{ justifyContent: 'flex-end' }}>
          <Group spacing="md" align="center" noWrap>
            <Group spacing="sm" noWrap>
              {currentUser && (
                <>
                  <UploadTracker />
                  <CivitaiLinkPopover />
                </>
              )}
              {currentUser?.showNsfw && <BrowsingModeIcon />}
              {currentUser && <NotificationBell />}
              {currentUser?.isModerator && <ModerationNav />}
            </Group>
            {!currentUser ? (
              <Button
                component={NextLink}
                href={`/login?returnUrl=${router.asPath}`}
                variant="default"
              >
                Sign In
              </Button>
            ) : (
              <Divider orientation="vertical" />
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
                  <Group spacing={8} noWrap>
                    <UserAvatar user={currentUser} size="md" />
                    {features.buzz && <UserBuzz user={currentUser} />}
                  </Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <BuzzMenuItem />
                {userMenuItems}
                <Divider />
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
          <Group spacing={4} noWrap>
            {features.enhancedSearch && (
              <ActionIcon onClick={() => setShowSearch(true)}>
                <IconSearch />
              </ActionIcon>
            )}
            {currentUser && <CivitaiLinkPopover />}
            {currentUser && <NotificationBell />}
            <Burger
              opened={burgerOpened}
              onClick={burgerOpened ? closeBurger : openBurger}
              size="sm"
            />
            <Transition transition="scale-y" duration={200} mounted={burgerOpened}>
              {(styles) => (
                <Paper
                  className={classes.dropdown}
                  withBorder
                  shadow="md"
                  style={{ ...styles, borderLeft: 0, borderRight: 0 }}
                  radius={0}
                >
                  {/* Calculate maxHeight based off total viewport height minus header + footer + static menu options inside dropdown sizes */}
                  <ScrollArea.Autosize maxHeight={'calc(100vh - 269px)'}>
                    <BuzzMenuItem mx={0} mt={0} textSize="sm" withAbbreviation={false} />
                    {burgerMenuItems}
                  </ScrollArea.Autosize>
                  {currentUser && (
                    <Box px="md">
                      <BrowsingModeMenu />
                    </Box>
                  )}

                  <Group p="md" position="apart" grow>
                    <ActionIcon
                      variant="default"
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
                              <ActionIcon variant="default" size="lg" onClick={toggle}>
                                {icon}
                              </ActionIcon>
                            )}
                          </BlurToggle>
                        )}
                        <Link href="/user/account" passHref>
                          <ActionIcon
                            variant="default"
                            component="a"
                            size="lg"
                            onClick={closeBurger}
                          >
                            <IconSettings stroke={1.5} />
                          </ActionIcon>
                        </Link>
                        <ActionIcon variant="default" onClick={() => signOut()} size="lg">
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

type Props = { renderSearchComponent?: (opts: RenderSearchComponentProps) => React.ReactElement };
export type RenderSearchComponentProps = {
  onSearchDone: () => void;
  isMobile: boolean;
  ref?: RefObject<HTMLInputElement>;
};
