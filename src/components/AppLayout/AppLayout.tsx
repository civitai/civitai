import {
  AppShell,
  Button,
  Center,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { IconBan } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';
import React from 'react';
import { InstantSearch, InstantSearchProps } from 'react-instantsearch-hooks-web';

import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader } from '~/components/AppLayout/AppHeader';
import { FloatingGenerationButton } from '~/components/ImageGeneration/FloatingGenerationButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client.mjs';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);
const searchClient: InstantSearchProps['searchClient'] = {
  ...meilisearch,
  search(requests) {
    // Prevent making a request if there is no query
    // @see https://www.algolia.com/doc/guides/building-search-ui/going-further/conditional-requests/react/#detecting-empty-search-requests
    // @see https://github.com/algolia/react-instantsearch/issues/1111#issuecomment-496132977
    if (requests.every(({ params }) => !params?.query)) {
      return Promise.resolve({
        results: requests.map(() => ({
          hits: [],
          nbHits: 0,
          nbPages: 0,
          page: 0,
          processingTimeMS: 0,
          hitsPerPage: 0,
          exhaustiveNbHits: false,
          query: '',
          params: '',
        })),
      });
    }

    return meilisearch.search(requests);
  },
};

export function AppLayout({ children, navbar }: Props) {
  const theme = useMantineTheme();
  const user = useCurrentUser();
  const isBanned = !!user?.bannedAt;
  const flags = useFeatureFlags();

  return (
    <InstantSearch searchClient={searchClient} indexName="models" routing>
      <AppShell
        padding="md"
        header={!isBanned ? <AppHeader /> : undefined}
        footer={<AppFooter />}
        className={`theme-${theme.colorScheme}`}
        navbar={navbar}
        styles={{
          body: {
            display: 'block',
            maxWidth: '100vw',
          },
          main: {
            paddingLeft: 0,
            paddingRight: 0,
            paddingBottom: 61,
            maxWidth: '100%',
          },
        }}
      >
        {!isBanned ? (
          <>
            {children}
            {flags.imageGeneration && <FloatingGenerationButton />}
          </>
        ) : (
          <Center py="xl">
            <Stack align="center">
              <ThemeIcon size={128} radius={100} color="red">
                <IconBan size={80} />
              </ThemeIcon>
              <Title order={1} align="center">
                You have been banned
              </Title>
              <Text size="lg" align="center">
                This account has been banned and cannot access the site
              </Text>
              <Button onClick={() => signOut()}>Sign out</Button>
            </Stack>
          </Center>
        )}
      </AppShell>
    </InstantSearch>
  );
}

type Props = {
  children: React.ReactNode;
  navbar?: React.ReactElement;
};
