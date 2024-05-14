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
  Portal,
  ScrollArea,
  Switch,
  Text,
  Transition,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { Currency } from '@prisma/client';
import {
  IconBarbell,
  IconBookmark,
  IconBookmarkEdit,
  IconBrush,
  IconChevronDown,
  IconChevronRight,
  IconCloudLock,
  IconClubs,
  IconCrown,
  IconHistory,
  IconInfoSquareRounded,
  IconLink,
  IconLogout,
  IconMoneybag,
  IconMoonStars,
  IconPalette,
  IconPhotoUp,
  IconPlayerPlayFilled,
  IconPlus,
  IconProgressBolt,
  IconSearch,
  IconSettings,
  IconSun,
  IconUpload,
  IconUser,
  IconUserCircle,
  IconUsers,
  IconVideoPlus,
  IconWriting,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Fragment,
  ReactElement,
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AccountSwitcher } from '~/components/AppLayout/AccountSwitcher';
import { BrowsingModeIcon, BrowsingModeMenu } from '~/components/BrowsingMode/BrowsingMode';
import { ChatButton } from '~/components/Chat/ChatButton';
import { CivitaiLinkPopover } from '~/components/CivitaiLink/CivitaiLinkPopover';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { useSystemCollections } from '~/components/Collections/collection.utils';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { FeatureIntroductionModal } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Logo } from '~/components/Logo/Logo';
import { ImpersonateButton } from '~/components/Moderation/ImpersonateButton';
import { ModerationNav } from '~/components/Moderation/ModerationNav';
import { NotificationBell } from '~/components/Notifications/NotificationBell';
import { UploadTracker } from '~/components/Resource/UploadTracker';
import { SupportButton } from '~/components/SupportButton/SupportButton';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { LoginRedirectReason } from '~/utils/login-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { trpc } from '~/utils/trpc';
import { AutocompleteSearch } from '../AutocompleteSearch/AutocompleteSearch';
import { openBuyBuzzModal } from '../Modals/BuyBuzzModal';
import { GenerateButton } from '../RunStrategy/GenerateButton';
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

    [containerQuery.smallerThan('md')]: {
      paddingLeft: theme.spacing.xs * 0.8, // 8px
      paddingRight: theme.spacing.xs * 0.8, // 8px
    },
  },

  burger: {
    display: 'flex',
    justifyContent: 'flex-end',
    [containerQuery.largerThan('md')]: {
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
    height: `calc(100% - ${HEADER_HEIGHT}px)`,

    [containerQuery.largerThan('md')]: {
      display: 'none',
    },
  },

  search: {
    [containerQuery.smallerThan('md')]: {
      display: 'none',
    },
  },

  searchArea: {
    [containerQuery.smallerThan('md')]: {
      display: 'none',
    },
  },

  links: {
    display: 'flex',
    [containerQuery.smallerThan('md')]: {
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

    [containerQuery.smallerThan('md')]: {
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

    [containerQuery.smallerThan('md')]: {
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
  label: ReactNode;
  href: string;
  redirectReason?: LoginRedirectReason;
  visible?: boolean;
  as?: string;
  rel?: string;
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

export function AppHeader({
  renderSearchComponent = defaultRenderSearchComponent,
  fixed = true,
}: Props) {
  const currentUser = useCurrentUser();
  const { classes, cx, theme } = useStyles();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const router = useRouter();
  const features = useFeatureFlags();
  const isMobile = useIsMobile();
  const { logout } = useAccountContext();
  const [burgerOpened, setBurgerOpened] = useState(false);
  const [userMenuOpened, setUserMenuOpened] = useState(false);
  const [userSwitching, setUserSwitching] = useState(false);
  // const ref = useClickOutside(() => setBurgerOpened(false));
  const searchRef = useRef<HTMLInputElement>(null);

  const isMuted = currentUser?.muted ?? false;
  const {
    groupedCollections: {
      Article: bookmarkedArticlesCollection,
      Model: bookmarkedModelsCollection,
    },
  } = useSystemCollections();

  const { data: creator } = trpc.user.getCreator.useQuery(
    { id: currentUser?.id as number },
    { enabled: !!currentUser }
  );

  const mainActions = useMemo<MenuLink[]>(
    () => [
      {
        href: '/generate',
        visible: !isMuted,
        label: (
          <Group align="center" spacing="xs">
            <IconBrush stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            Generate images
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/posts/create',
        visible: !isMuted,
        redirectReason: 'post-images',
        label: (
          <Group align="center" spacing="xs">
            <IconPhotoUp stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            Post images
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/posts/create?video=true',
        visible: !isMuted,
        redirectReason: 'post-images',
        label: (
          <Group align="center" spacing="xs">
            <IconVideoPlus stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            Post videos
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/models/create',
        visible: !isMuted,
        redirectReason: 'upload-model',
        label: (
          <Group align="center" spacing="xs">
            <IconUpload stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            Upload a model
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/models/train',
        visible: !isMuted && features.imageTraining,
        redirectReason: 'train-model',
        label: (
          <Group align="center" spacing="xs">
            <IconBarbell stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            <Text span inline>
              Train a LoRA
            </Text>
            <CurrencyIcon currency={Currency.BUZZ} size={16} />
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/articles/create',
        visible: !isMuted,
        redirectReason: 'create-article',
        label: (
          <Group align="center" spacing="xs">
            <IconWriting stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            Write an article
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/bounties/create',
        visible: !isMuted && features.bounties,
        redirectReason: 'create-bounty',
        label: (
          <Group align="center" spacing="xs">
            <IconMoneybag stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            <Text>Create a bounty</Text>
            <CurrencyIcon currency={Currency.BUZZ} size={16} />
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/clubs/create',
        visible: !isMuted && features.clubs,
        redirectReason: 'create-club',
        label: (
          <Group align="center" spacing="xs">
            <IconClubs stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            <Text>Create a club</Text>
          </Group>
        ),
        rel: 'nofollow',
      },
    ],
    [features.bounties, features.imageTraining, features.clubs, isMuted, theme]
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
        visible: !!currentUser && features.imageTrainingResults,
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
            <IconBookmark stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            My collections
          </Group>
        ),
      },
      {
        href: `/collections/${bookmarkedModelsCollection?.id}`,
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs">
            <ThumbsUpIcon stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            Liked models
          </Group>
        ),
      },
      {
        href: `/collections/${bookmarkedArticlesCollection?.id}`,
        visible: !!currentUser && !!bookmarkedArticlesCollection,
        label: (
          <Group align="center" spacing="xs">
            <IconBookmarkEdit stroke={1.5} color={theme.colors.pink[theme.fn.primaryShade()]} />
            Bookmarked articles
          </Group>
        ),
      },
      {
        href: '/bounties?engagement=favorite',
        as: '/bounties',
        visible: !!currentUser && features.bounties,
        label: (
          <Group align="center" spacing="xs">
            <IconMoneybag stroke={1.5} color={theme.colors.pink[theme.fn.primaryShade()]} />
            My bounties
          </Group>
        ),
      },
      {
        href: '/clubs?engagement=engaged',
        as: '/clubs',
        visible: !!currentUser && features.clubs,
        label: (
          <Group align="center" spacing="xs">
            <IconClubs stroke={1.5} color={theme.colors.pink[theme.fn.primaryShade()]} />
            My clubs
          </Group>
        ),
      },
      {
        href: '/user/buzz-dashboard',
        visible: !!currentUser && features.buzz,
        label: (
          <Group align="center" spacing="xs">
            <IconProgressBolt stroke={1.5} color={theme.colors.yellow[7]} />
            Buzz dashboard
          </Group>
        ),
      },
      {
        href: '/user/vault',
        visible: !!currentUser && features.vault,
        label: (
          <Group align="center" spacing="xs">
            <IconCloudLock stroke={1.5} color={theme.colors.yellow[7]} />
            My vault
          </Group>
        ),
      },
      {
        href: '',
        visible: !!currentUser,
        label: <Divider my={4} />,
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
        href: '/product/link',
        label: (
          <Group align="center" spacing="xs">
            <IconLink stroke={1.5} />
            Download Link App
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
        href: `/login?returnUrl=${router.asPath}`,
        visible: !currentUser,
        label: (
          <Group align="center" spacing="xs">
            <IconUserCircle stroke={1.5} />
            Sign In/Sign up
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/questions',
        visible: !!currentUser && features.questions,
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
      {
        href: '#!',
        visible: !!currentUser,
        label: (
          <UnstyledButton
            onClick={() => {
              dialogStore.trigger({
                component: FeatureIntroductionModal,
                props: {
                  feature: 'getting-started',
                  contentSlug: ['feature-introduction', 'welcome'],
                },
              });
            }}
          >
            <Group align="center" spacing="xs">
              <IconPlayerPlayFilled stroke={1.5} />
              Getting Started
            </Group>
          </UnstyledButton>
        ),
      },
    ],
    [
      currentUser,
      currentUser?.username,
      features.imageTrainingResults,
      features.bounties,
      features.buzz,
      features.questions,
      features.clubs,
      features.vault,
      bookmarkedModelsCollection,
      bookmarkedArticlesCollection,
      router.asPath,
      // theme,
    ]
  );

  const burgerMenuItems = useMemo(
    () =>
      mainActions
        .concat([{ href: '', label: <Divider /> }, ...links])
        .filter(({ visible }) => visible !== false)
        .map((link, index) => {
          const item = link.href ? (
            <Link key={index} href={link.href} as={link.as} passHref>
              <Anchor
                variant="text"
                className={cx(classes.link, { [classes.linkActive]: router.asPath === link.href })}
                onClick={() => setBurgerOpened(false)}
                rel={link.rel}
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
    [classes, setBurgerOpened, cx, links, mainActions, router.asPath]
  );
  const userMenuItems = useMemo(
    () =>
      links
        .filter(({ visible }) => visible !== false)
        .map((link, index) =>
          link.href ? (
            <Menu.Item
              key={link.href}
              display="flex"
              component={NextLink}
              href={link.href}
              as={link.as}
              rel={link.rel}
            >
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

  const handleCloseMenu = useCallback(() => {
    setUserSwitching(false);
    setBurgerOpened(false);
    setUserMenuOpened(false);
  }, [setBurgerOpened]);

  useEffect(() => {
    if (showSearch && searchRef.current) {
      searchRef.current.focus(); // Automatically focus input on mount
    }
  }, [showSearch]);

  const BuzzMenuItem = useCallback(
    ({
      textSize = 'md',
      withAbbreviation = true,
      ...groupProps
    }: GroupProps & {
      textSize?: MantineSize;
      withAbbreviation?: boolean;
    }) => {
      if (!features.buzz) return null;
      if (!currentUser) return null;

      return (
        <Link href="/user/buzz-dashboard">
          <Group
            p="sm"
            position="apart"
            mx={-4}
            mb={4}
            sx={(theme) => ({
              backgroundColor:
                theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2],
              cursor: 'pointer',
            })}
            onClick={handleCloseMenu}
            noWrap
            {...groupProps}
          >
            <Group spacing={4} noWrap>
              <UserBuzz
                iconSize={16}
                textSize={textSize}
                withAbbreviation={withAbbreviation}
                withTooltip={withAbbreviation}
              />
            </Group>
            <Button
              variant="white"
              radius="xl"
              size="xs"
              px={12}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openBuyBuzzModal({}, { fullScreen: isMobile });
              }}
              compact
            >
              Buy Buzz
            </Button>
          </Group>
        </Link>
      );
    },
    [currentUser, features.buzz, handleCloseMenu, isMobile]
  );

  const mobileCreateButton = !isMuted && (
    <GenerateButton
      variant="light"
      py={8}
      px={12}
      h="auto"
      radius="sm"
      mode="toggle"
      compact
      className="inline-block md:hidden"
      data-activity="create:navbar"
    />
  );

  const createMenu = !isMuted && (
    <Menu
      position="bottom"
      offset={5}
      withArrow
      trigger="hover"
      openDelay={400}
      zIndex={constants.imageGeneration.drawerZIndex + 2}
      withinPortal
    >
      <Menu.Target>
        {features.imageGeneration ? (
          <Group spacing={0} noWrap className="hide-mobile">
            <GenerateButton
              variant="light"
              py={8}
              pl={12}
              pr={4}
              h="auto"
              radius="sm"
              mode="toggle"
              // Quick hack to avoid svg from going over the button. cc: Justin 👀
              sx={() => ({ borderTopRightRadius: 0, borderBottomRightRadius: 0 })}
              compact
              data-activity="create:navbar"
            />
            <Button
              variant="light"
              py={8}
              px={4}
              h="auto"
              radius="sm"
              sx={() => ({ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 })}
            >
              <IconChevronDown stroke={2} size={20} />
            </Button>
          </Group>
        ) : (
          <Button
            className={cx(classes.links, 'hide-mobile')}
            variant="filled"
            color="green"
            size="xs"
            pl={5}
          >
            <IconPlus size={16} /> New
          </Button>
        )}
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
                rel={link.rel}
              >
                {link.label}
              </Menu.Item>
            );

            return link.redirectReason ? (
              <LoginRedirect key={index} reason={link.redirectReason} returnUrl={link.href}>
                {menuItem}
              </LoginRedirect>
            ) : (
              menuItem
            );
          })}
      </Menu.Dropdown>
    </Menu>
  );

  return (
    <Header height={HEADER_HEIGHT} fixed={fixed} zIndex={200}>
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
            <Anchor
              component={NextLink}
              href="/"
              variant="text"
              onClick={() => setBurgerOpened(false)}
            >
              <Logo />
            </Anchor>
            <SupportButton />
            {/* Disabled until next event */}
            {/* <EventButton /> */}
          </Group>
        </Grid.Col>
        <Grid.Col span={6} md={5} className={classes.searchArea}>
          {renderSearchComponent({ onSearchDone, isMobile: false })}
        </Grid.Col>
        <Grid.Col span="auto" className={classes.links} sx={{ justifyContent: 'flex-end' }}>
          <Group spacing="md" align="center" noWrap>
            <Group spacing="sm" noWrap>
              {mobileCreateButton}
              {createMenu}
              {currentUser && (
                <>
                  <UploadTracker />
                  <CivitaiLinkPopover />
                </>
              )}
              <BrowsingModeIcon />
              {currentUser && <NotificationBell />}
              {currentUser && features.chat && <ChatButton />}
              {currentUser?.isModerator && <ModerationNav />}
              {currentUser && <ImpersonateButton />}
            </Group>
            {!currentUser ? (
              <Button
                component={NextLink}
                href={`/login?returnUrl=${router.asPath}`}
                rel="nofollow"
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
              zIndex={constants.imageGeneration.drawerZIndex + 1}
              // radius="lg"
              onClose={() => {
                setUserSwitching(false);
                setUserMenuOpened(false);
              }}
              withinPortal
            >
              <Menu.Target>
                {!!currentUser ? (
                  <UnstyledButton
                    className={cx(classes.user, { [classes.userActive]: userMenuOpened })}
                    onClick={() => setUserMenuOpened(true)}
                  >
                    <Group spacing={8} noWrap>
                      <UserAvatar user={creator ?? currentUser} size="md" />
                      {features.buzz && currentUser && <UserBuzz pr="sm" />}
                    </Group>
                  </UnstyledButton>
                ) : (
                  <Burger
                    opened={userMenuOpened}
                    onClick={() => setUserMenuOpened(true)}
                    size="sm"
                  />
                )}
              </Menu.Target>

              <Menu.Dropdown>
                <ScrollArea.Autosize
                  maxHeight="calc(90vh - var(--mantine-header-height))"
                  styles={{ root: { margin: -4 }, viewport: { padding: 4 } }}
                  offsetScrollbars
                >
                  {userSwitching ? (
                    <AccountSwitcher setUserSwitching={setUserSwitching} close={handleCloseMenu} />
                  ) : (
                    <>
                      {!!currentUser && (
                        <Menu.Item
                          onClick={() => setUserSwitching(true)}
                          closeMenuOnClick={false}
                          mb={4}
                        >
                          <Group w="100%" position="apart">
                            <UserAvatar user={creator ?? currentUser} withUsername />
                            <IconChevronRight />
                          </Group>
                        </Menu.Item>
                      )}
                      <BuzzMenuItem withAbbreviation={false} />
                      {userMenuItems}
                      <Divider my={4} />
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
                            onClick={() => logout()}
                          >
                            Logout
                          </Menu.Item>
                        </>
                      ) : null}
                    </>
                  )}
                </ScrollArea.Autosize>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Grid.Col>
        <Grid.Col span="auto" className={classes.burger}>
          <Group spacing={4} noWrap>
            {mobileCreateButton}
            <ActionIcon onClick={() => setShowSearch(true)}>
              <IconSearch />
            </ActionIcon>
            {currentUser && <CivitaiLinkPopover />}
            {currentUser && <NotificationBell />}
            {currentUser && features.chat && <ChatButton />}
            {/*{currentUser?.isModerator && <ModerationNav />}*/}
            {currentUser && <ImpersonateButton />}
            <Burger
              opened={burgerOpened}
              onClick={() => setBurgerOpened(!burgerOpened)}
              size="sm"
            />
            <Transition transition="scale-y" duration={200} mounted={burgerOpened}>
              {(styles) => (
                <Portal target="#main">
                  <Paper
                    className={classes.dropdown}
                    withBorder
                    shadow="md"
                    style={{ ...styles, borderLeft: 0, borderRight: 0 }}
                    radius={0}
                    sx={{ zIndex: 1002 }}
                    // ref={ref}
                  >
                    {userSwitching ? (
                      // TODO maybe move this to account switcher
                      <ScrollArea.Autosize maxHeight={'calc(100dvh - 135px)'}>
                        <AccountSwitcher
                          inMenu={false}
                          setUserSwitching={setUserSwitching}
                          close={handleCloseMenu}
                        />
                      </ScrollArea.Autosize>
                    ) : (
                      <>
                        {/* Calculate maxHeight based off total viewport height minus header + footer + static menu options inside dropdown sizes */}
                        <ScrollArea.Autosize maxHeight={'calc(100dvh - 135px)'}>
                          {!!currentUser && (
                            <Group
                              className={classes.link}
                              w="100%"
                              position="apart"
                              sx={{ cursor: 'pointer' }}
                              onClick={() => setUserSwitching(true)}
                            >
                              <UserAvatar user={creator ?? currentUser} withUsername />
                              <IconChevronRight />
                            </Group>
                          )}
                          <BuzzMenuItem mx={0} mt={0} textSize="sm" withAbbreviation={false} />
                          {burgerMenuItems}
                          {currentUser && (
                            <>
                              <Divider />
                              <Box px="md" pt="md">
                                <BrowsingModeMenu closeMenu={() => setBurgerOpened(false)} />
                              </Box>
                            </>
                          )}
                        </ScrollArea.Autosize>

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
                            {colorScheme === 'dark' ? (
                              <IconSun size={18} />
                            ) : (
                              <IconMoonStars size={18} />
                            )}
                          </ActionIcon>
                          {currentUser && (
                            <>
                              {/* {currentUser?.showNsfw && (
                            <BlurToggle iconProps={{ stroke: 1.5 }}>
                              {({ icon, toggle }) => (
                                <ActionIcon variant="default" size="lg" onClick={() => toggle()}>
                                  {icon}
                                </ActionIcon>
                              )}
                            </BlurToggle>
                          )} */}
                              <Link href="/user/account">
                                <ActionIcon
                                  variant="default"
                                  size="lg"
                                  onClick={() => setBurgerOpened(false)}
                                >
                                  <IconSettings stroke={1.5} />
                                </ActionIcon>
                              </Link>
                              <ActionIcon variant="default" onClick={() => logout()} size="lg">
                                <IconLogout
                                  stroke={1.5}
                                  color={theme.colors.red[theme.fn.primaryShade()]}
                                />
                              </ActionIcon>
                            </>
                          )}
                        </Group>
                      </>
                    )}
                  </Paper>
                </Portal>
              )}
            </Transition>
          </Group>
        </Grid.Col>
      </Grid>
    </Header>
  );
}

type Props = {
  renderSearchComponent?: (opts: RenderSearchComponentProps) => ReactElement;
  fixed?: boolean;
};
export type RenderSearchComponentProps = {
  onSearchDone?: () => void;
  isMobile: boolean;
  ref?: RefObject<HTMLInputElement>;
};
