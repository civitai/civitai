import { Autocomplete, Button, Group, Header, Title } from '@mantine/core';
import { IconSearch } from '@tabler/icons';
import { ColorSchemeToggle } from '~/components/ColorSchemeToggle/ColorSchemeToggle';

export function AppHeader({ links }: Props) {
  return (
    <Header height={60} p="sm">
      <Group align="center" sx={{ justifyContent: 'space-between' }}>
        <Group>
          <Title>MS</Title>
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
          <Button>Sign In</Button>
        </Group>
      </Group>
    </Header>
  );
}

type Props = {
  links?: Array<{ url: string; label: string }>;
};
