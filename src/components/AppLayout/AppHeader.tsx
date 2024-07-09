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
  Table,
  UnstyledButton,
  Modal,
  useMantineColorScheme,
  Stack,
  SimpleGrid,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { Currency } from '@prisma/client';
import {
  IconEye,
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
  IconPointerQuestion,
  IconBriefcase,
  IconAd2,
  IconBrandDiscord,
  IconBrandReddit,
  IconBrandX,
  IconBrandTwitch,
  IconBrandInstagram,
  IconBrandGithub,
  IconBrandYoutube,
  IconBrandTiktok,
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
import dynamic from 'next/dynamic';

const FeatureIntroductionModal = dynamic(() =>
  import('~/components/FeatureIntroduction/FeatureIntroduction').then(
    (m) => m.FeatureIntroductionModal
  )
);

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
    paddingBottom: '20px',
    top: HEADER_HEIGHT,
    left: 0,
    right: 0,
    zIndex: 0,
    borderTopRightRadius: 0,
    borderTopLeftRadius: 0,
    borderTopWidth: 0,
    overflow: 'auto',
    height: `calc(100% - ${HEADER_HEIGHT}px)`,
    maxWidth: '100%',

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
    width: '100%',
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
  const [showBrowsingModeMenu, setShowBrowsingModeMenu] = useState(false);
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
          <Group className="flex flex-col md:flex-row items-center gap-2 text-xs md:text-md">
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
          <Group className="flex flex-col md:flex-row items-center gap-2 text-xs md:text-md">
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
          <Group className="flex flex-col md:flex-row items-center gap-2 text-xs md:text-md">
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
          <Group className="flex flex-col md:flex-row items-center gap-2 text-xs md:text-md">
            <IconUpload stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            Upload model
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/models/train',
        visible: !isMuted && features.imageTraining,
        redirectReason: 'train-model',
        label: (
          <Group className="flex flex-col md:flex-row items-center gap-2 text-xs md:text-md">
            <IconBarbell stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            <Group className="gap-1 md:gap-2">
              <Text span inline>
                Train a LoRA
              </Text>
              <CurrencyIcon currency={Currency.BUZZ} size={16} />
            </Group>
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/articles/create',
        visible: !isMuted,
        redirectReason: 'create-article',
        label: (
          <Group className="flex flex-col md:flex-row items-center gap-2 text-xs md:text-md">
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
          <Group className="flex flex-col md:flex-row items-center gap-2 text-xs md:text-md">
            <IconMoneybag stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            <Group className="gap-1 md:gap-2">
              <Text>Create a bounty</Text>
              <CurrencyIcon currency={Currency.BUZZ} size={16} />
            </Group>
          </Group>
        ),
        rel: 'nofollow',
      },
      {
        href: '/clubs/create',
        visible: !isMuted && features.clubs,
        redirectReason: 'create-club',
        label: (
          <Group className="flex flex-col md:flex-row items-center gap-2 text-xs md:text-md">
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
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconUser stroke={1.5} color={theme.colors.blue[theme.fn.primaryShade()]} />
            Your profile
          </Group>
        ),
      },
      {
        href: `/user/${currentUser?.username}/models?section=training`,
        visible: !!currentUser && features.imageTrainingResults,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconBarbell stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            Training
          </Group>
        ),
      },
      {
        href: `/collections`,
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconBookmark stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            My collections
          </Group>
        ),
      },
      {
        href: `/collections/${bookmarkedModelsCollection?.id}`,
        visible: !!currentUser && !isMobile,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <ThumbsUpIcon stroke={1.5} color={theme.colors.green[theme.fn.primaryShade()]} />
            Liked models
          </Group>
        ),
      },
      {
        href: `/collections/${bookmarkedArticlesCollection?.id}`,
        visible: !!currentUser && !!bookmarkedArticlesCollection,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
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
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
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
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconClubs stroke={1.5} color={theme.colors.pink[theme.fn.primaryShade()]} />
            My clubs
          </Group>
        ),
      },
      {
        href: '/user/buzz-dashboard',
        visible: !!currentUser && features.buzz,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconProgressBolt stroke={1.5} color={theme.colors.yellow[7]} />
            Buzz dashboard
          </Group>
        ),
      },
      {
        href: '/user/vault',
        visible: !!currentUser && features.vault && !isMobile,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconCloudLock stroke={1.5} color={theme.colors.yellow[7]} />
            My vault
          </Group>
        ),
      },
      {
        href: '',
        visible: !!currentUser && !isMobile,
        label: <Divider my={4} />,
      },
      {
        href: '/leaderboard/overall',
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconCrown stroke={1.5} color={theme.colors.yellow[theme.fn.primaryShade()]} />
            Leaderboard
          </Group>
        ),
      },
      {
        href: '/product/link',
        visible: !isMobile,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconLink stroke={1.5} />
            Download Link App
          </Group>
        ),
      },
      {
        href: `/user/${currentUser?.username}/following`,
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconUsers stroke={1.5} />
            Creators you follow
          </Group>
        ),
      },
      {
        href: '',
        visible: !!currentUser && isMobile,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconEye stroke={1.5} />
            Browsing mode
          </Group>
        ),
      },
      {
        href: '/user/downloads',
        visible: !!currentUser,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconHistory stroke={1.5} />
            Download history
          </Group>
        ),
      },
      {
        href: '/questions',
        visible: !!currentUser && features.questions && !isMobile,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
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
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md" onClick={() => {
            dialogStore.trigger({
              component: FeatureIntroductionModal,
              props: {
                feature: 'getting-started',
                contentSlug: ['feature-introduction', 'welcome'],
              },
            });
          }}
          >
            <IconPlayerPlayFilled stroke={1.5} />
            Getting Started
          </Group>
        ),
      },
      {
        href: `/login?returnUrl=${router.asPath}`,
        visible: !currentUser,
        label: (
          <Group align="center" spacing="xs" className="flex flex-col md:flex-row text-xs md:text-md">
            <IconUserCircle stroke={1.5} />
            Sign In/Sign up
          </Group>
        ),
        rel: 'nofollow',
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

  const visibleLinks = links.filter(({ visible }) => visible !== false);
  const columnCount = 3
  const rows = visibleLinks.reduce((acc, item, index) => {
    const rowIndex = Math.floor(index / columnCount);
    if (!acc[rowIndex]) acc[rowIndex] = [];
    acc[rowIndex].push(item);
    return acc;
  }, [] as MenuLink[][]);

  if (rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    while (lastRow.length < columnCount) {
      lastRow.push({ href: '', label: '', visible: true });
    }
  }

  const burgerMenuItems = useMemo(
    () => (
      <>
        <Group spacing="xl" px="md" py="lg" sx={() => ({
          maxWidth: "100%",
          overflowX: 'auto',
          overflowY: 'hidden',
          flexWrap: 'nowrap',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          '&::-webkit-scrollbar': {
            display: 'none'
          },
          '& > *': {
            flexShrink: 0,
          },
        })}>
          {mainActions
            .filter(({ visible }) => visible !== false)
            .map((link, index) => {
              const item = link.href ? (
                <Button
                  key={index}
                  component={Link}
                  href={link.href}
                  as={link.as}
                  variant="light"
                  compact
                  onClick={() => setBurgerOpened(false)}
                  rel={link.rel}
                >
                  {link.label}
                </Button>
              ) : null;

              return link.redirectReason && item ? (
                <LoginRedirect key={link.href} reason={link.redirectReason} returnUrl={link.href}>
                  {item as ReactElement}
                </LoginRedirect>
              ) : (
                item
              );
            })}
        </Group>

        <Table
          withBorder
          withColumnBorders
          sx={(theme) => ({
            borderLeft: 'none',
            borderRight: 'none',
            '& td': {
              paddingTop: '20px !important',
              paddingBottom: '20px !important',
            },
          })}
        >
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((link, colIndex) => (
                  <td key={colIndex} style={{ width: `${100 / columnCount}%` }}>
                    {link.href ? (
                      <Anchor
                        variant='text'
                        href={link.href}
                        onClick={() => setBurgerOpened(false)}
                        className={cx({ [classes.linkActive]: router.asPath === link.href })}
                        rel={link.rel}
                      >
                        {link.label}
                      </Anchor>
                    ) : (
                      <div
                        onClick={() => setShowBrowsingModeMenu(!showBrowsingModeMenu)}
                      >
                        {link.label}
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>

        <Modal
          opened={showBrowsingModeMenu}
          onClose={() => setShowBrowsingModeMenu(false)}
          withCloseButton={false}
          centered
          mx={16}
        >
          <BrowsingModeMenu
            closeMenu={() => {
              setShowBrowsingModeMenu(false);
              setBurgerOpened(false);
            }}
          />
        </Modal>

      </>
    ),
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

  const additionalLinks = [
    {
      href: '/feedback',
      label: 'Feature Request',
      icon: IconPointerQuestion,
      external: true,
    },
    {
      href: '/content/careers',
      label: 'Join Us',
      icon: IconBriefcase,
      external: true,
    },
    {
      href: '/advertise-with-us',
      label: 'Advertise',
      icon: IconAd2,
      external: true,
    },
  ];

  const socialLinks = [
    { icon: IconBrandDiscord, href: 'https://discord.gg/civitai' },
    { icon: IconBrandReddit, href: 'https://www.reddit.com/r/civitai/' },
    { icon: IconBrandX, href: 'https://twitter.com/civitai' },
    { icon: IconBrandTwitch, href: 'https://www.twitch.tv/civitai' },
    { icon: IconBrandInstagram, href: 'https://www.instagram.com/hellocivitai/' },
    { icon: IconBrandGithub, href: 'https://github.com/civitai' },
    { icon: IconBrandYoutube, href: 'https://www.youtube.com/@civitai' },
    { icon: IconBrandTiktok, href: 'https://www.tiktok.com/@hellocivitai' },
  ];

  const footerLinks = [
    {
      label: 'Creators',
      items: [
        { name: 'Residency', href: 'https://air.civitai.com/' },
        { name: 'Creators', href: '/creators-program' },
        { name: 'API', href: 'https://github.com/civitai/civitai/wiki/REST-API-Reference' },
        { name: 'Education', href: 'https://education.civitai.com/' },
        { name: 'Safety Center', href: '/safety' }
      ]
    },
    {
      label: 'Docs',
      items: [
        { name: 'Terms of Service', href: '/content/tos' },
        { name: 'Privacy', href: '/content/privacy' },
        { name: 'Newsroom', href: '/newsroom' },
        { name: 'Wiki', href: 'https://wiki.civitai.com/wiki/Main_Page' },
        { name: 'Status', href: 'https://status.civitai.com/status/public' }
      ]
    },
  ];

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
              Buy
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
          <Group spacing={12} noWrap>
            <ActionIcon onClick={() => setShowSearch(true)}>
              <IconSearch />
            </ActionIcon>
            {currentUser && <CivitaiLinkPopover />}
            {currentUser && <NotificationBell />}
            {/*{currentUser?.isModerator && <ModerationNav />}*/}
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
                        <Group
                          sx={{ display: 'flex', alignItems: 'center', padding: '10px', justifyContent: 'space-between' }}
                          onClick={() => setUserSwitching(true)}
                        >
                          {!!currentUser && (
                            <Group
                              p={4}
                              pr={6}
                              sx={{ cursor: 'pointer', boxShadow: '0 0 0 0.5px grey', borderRadius: '24px' }}
                            >
                              <UserAvatar user={creator ?? currentUser} withUsername />
                              <IconChevronRight size={18} />
                            </Group>
                          )}
                          <BuzzMenuItem mx={0} bg="none" mt={0} textSize="sm" withAbbreviation={false} />
                        </Group>
                        <Divider />
                        {burgerMenuItems}

                        <Stack spacing={0}>
                          {additionalLinks.map((link, index) => (
                            <Fragment key={link.href}>
                              <Box px="md">
                                <UnstyledButton
                                  component={Link}
                                  href={link.href}
                                  target={link.external ? "_blank" : undefined}
                                  rel={link.external ? "noopener noreferrer" : undefined}
                                >
                                  <Group position="apart" py="md" noWrap>
                                    <Group>
                                      <link.icon size={20} stroke={1.5} />
                                      <Text size="sm">{link.label}</Text>
                                    </Group>
                                    <IconChevronRight size={18} stroke={1.5} />
                                  </Group>
                                </UnstyledButton>
                              </Box>
                              {index < additionalLinks.length - 1 && <Divider />}
                            </Fragment>
                          ))}

                          <Divider />
                          <Box px="md">
                            <Group position="apart" py="md" noWrap>
                              <Group>
                                {colorScheme === 'dark' ? (
                                  <IconMoonStars size={20} stroke={1.5} />
                                ) : (
                                  <IconSun size={20} stroke={1.5} />
                                )}
                                <Text size="sm">Dark mode</Text>
                              </Group>
                              <Switch
                                checked={colorScheme === 'dark'}
                                onChange={() => toggleColorScheme()}
                                size="sm"
                              />
                            </Group>
                          </Box>

                          <Divider />
                          <Box px="md" py="md">
                            <SimpleGrid cols={8} spacing="xs">
                              {socialLinks.map((link, index) => (
                                <ActionIcon
                                  key={index}
                                  component="a"
                                  href={link.href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  variant="subtle"
                                >
                                  <link.icon size={16} />
                                </ActionIcon>
                              ))}
                            </SimpleGrid>
                          </Box>

                          <Divider />
                          <Box px="md" py="xl">
                            <SimpleGrid cols={2} spacing="md">
                              {footerLinks.map((section, index) => (
                                <div key={index}>
                                  <Text weight={300} opacity={0.8} mb="xs" size='sm'>{section.label}</Text>
                                  <Stack spacing="xs">
                                    {section.items.map((item, itemIndex) => (
                                      <Text
                                        key={itemIndex}
                                        component="a"
                                        href={item.href}
                                        size="xs"
                                        sx={(theme) => ({
                                          color: theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.colors.gray[7],
                                          textDecoration: 'none',
                                          '&:hover': {
                                            textDecoration: 'underline',
                                          },
                                        })}
                                      >
                                        {item.name}
                                      </Text>
                                    ))}
                                  </Stack>
                                </div>
                              ))}
                            </SimpleGrid>
                          </Box>
                        </Stack>

                        <Group p="md" position="apart" grow>
                          {currentUser && (
                            <>
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
    </Header >
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
