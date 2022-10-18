import {
  Anchor,
  Autocomplete,
  Avatar,
  Burger,
  Button,
  createStyles,
  Group,
  Header,
  Menu,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import {
  IconChevronDown,
  IconFile,
  IconHeart,
  IconLogout,
  IconSearch,
  IconSettings,
  IconStar,
} from '@tabler/icons';
import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import { useState } from 'react';
import { ColorSchemeToggle } from '~/components/ColorSchemeToggle/ColorSchemeToggle';

const useStyles = createStyles((theme) => ({
  inner: {
    height: 70,
    justifyContent: 'space-between',
  },

  burger: {
    [theme.fn.largerThan('xs')]: {
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
    padding: '8px 12px',
    borderRadius: theme.radius.sm,
    textDecoration: 'none',
    color: theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.colors.gray[7],
    fontSize: theme.fontSizes.sm,
    fontWeight: 500,

    '&:hover': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    },
  },

  user: {
    color: theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.black,
    padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
    borderRadius: theme.radius.sm,
    transition: 'background-color 100ms ease',

    '&:hover': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
    },

    [theme.fn.smallerThan('xs')]: {
      display: 'none',
    },
  },

  userActive: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
  },
}));

export function AppHeader({ links }: Props) {
  const { data: session } = useSession();
  const [burgerOpened, { toggle: toggleBurger }] = useDisclosure(false);
  const [userMenuOpened, setUserMenuOpened] = useState(false);
  const { classes, cx, theme } = useStyles();

  return (
    <Header px="md" height={70}>
      <Group align="center" className={classes.inner}>
        <Group spacing="sm">
          <Burger
            className={classes.burger}
            opened={burgerOpened}
            onClick={toggleBurger}
            size="sm"
          />
          <Link href="/" passHref>
            <Anchor variant="text">
              <Title>MS</Title>
            </Anchor>
          </Link>
          <Autocomplete
            className={classes.search}
            placeholder="Search"
            icon={<IconSearch size={16} stroke={1.5} />}
            data={['React', 'Angular', 'Vue', 'Next.js', 'Riot.js', 'Svelte', 'Blitz.js']}
          />
        </Group>
        <Group spacing="sm">
          <Group spacing="sm" className={classes.links}>
            {links?.map((link) => (
              <Link key={link.label} href={link.url} passHref>
                <Anchor className={classes.link} variant="text">
                  {link.label}
                </Anchor>
              </Link>
            ))}
          </Group>
          <Group spacing="xs">
            {session ? (
              <Button component={NextLink} href="/models/create" variant="subtle">
                Upload a model
              </Button>
            ) : null}
            <ColorSchemeToggle />
            {session ? (
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
                    <Group spacing={7}>
                      <Avatar
                        src={session?.user?.image}
                        alt={session?.user?.name ?? 'User avatar'}
                        radius="xl"
                        size={20}
                      />
                      <IconChevronDown size={12} stroke={1.5} />
                    </Group>
                  </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    icon={<IconHeart size={14} color={theme.colors.red[6]} stroke={1.5} />}
                  >
                    Liked models
                  </Menu.Item>
                  <Menu.Item
                    icon={<IconStar size={14} color={theme.colors.yellow[6]} stroke={1.5} />}
                  >
                    Saved models
                  </Menu.Item>
                  <Menu.Item
                    icon={<IconFile size={14} color={theme.colors.blue[6]} stroke={1.5} />}
                  >
                    Your models
                  </Menu.Item>

                  <Menu.Label>Settings</Menu.Label>
                  <Menu.Item icon={<IconSettings size={14} stroke={1.5} />}>
                    Account settings
                  </Menu.Item>
                  <Menu.Item
                    icon={<IconLogout size={14} color={theme.colors.red[9]} stroke={1.5} />}
                    onClick={() => signOut()}
                  >
                    Logout
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            ) : (
              <Button component={NextLink} href="/login" variant="outline">
                Sign In
              </Button>
            )}
          </Group>
        </Group>
      </Group>
    </Header>
  );
}

type Props = {
  links?: Array<{ url: string; label: string }>;
};
