import { Autocomplete, Button, Group, Header, Title } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconSearch } from '@tabler/icons';
import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import { ColorSchemeToggle } from '~/components/ColorSchemeToggle/ColorSchemeToggle';

export function AppHeader({ links }: Props) {
  const { data: session } = useSession();

  return (
    <Header p="sm" height={70}>
      <Group align="center" sx={{ justifyContent: 'space-between' }}>
        <Group>
          <Link href="/">
            <Title>MS</Title>
          </Link>
          <Autocomplete
            placeholder="Search"
            icon={<IconSearch size={16} stroke={1.5} />}
            data={['React', 'Angular', 'Vue', 'Next.js', 'Riot.js', 'Svelte', 'Blitz.js']}
          />
        </Group>
        <Group>
          <Group ml={50} spacing={5}>
            {links?.map((link) => (
              <a key={link.label} href={link.url} onClick={(event) => event.preventDefault()}>
                {link.label}
              </a>
            ))}
          </Group>
          <ColorSchemeToggle />
          {session ? (
            <Button onClick={() => signOut({ callbackUrl: '/' })}>Sign Out</Button>
          ) : (
            <Button component={NextLink} href="/login">
              Sign In
            </Button>
          )}
        </Group>
      </Group>
    </Header>
  );
}

type Props = {
  links?: Array<{ url: string; label: string }>;
};
