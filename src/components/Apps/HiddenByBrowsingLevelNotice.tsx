import { Button, Center, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { appHiddenByBrowsingLevelCopy } from '~/components/Apps/appHiddenByBrowsingLevel';
import type { HiddenMatureRating } from '~/server/services/blocks/app-listing-store-gate';

/**
 * The hidden state for an R/X app the viewer's browsing level excludes — shown on the app's
 * detail page and its run page in place of a 404. It names the rating and the one way to change
 * it, and nothing else of the app (no name, description or media). See
 * `appHiddenByBrowsingLevel.ts` for the copy.
 */
export function HiddenByBrowsingLevelNotice({
  contentRating,
  signedIn,
}: {
  contentRating: HiddenMatureRating;
  signedIn: boolean;
}) {
  const router = useRouter();
  const copy = appHiddenByBrowsingLevelCopy({
    contentRating,
    signedIn,
    returnUrl: router.asPath,
  });
  return (
    <Center py="xl" px="md" data-testid="app-hidden-by-browsing-level">
      <Stack align="center" gap="sm" maw={460} ta="center">
        <ThemeIcon size={56} radius="xl" variant="light" color="gray">
          <IconEyeOff size={28} />
        </ThemeIcon>
        <Title order={3}>{copy.title}</Title>
        <Text c="dimmed">{copy.body}</Text>
        <Button component={Link} href={copy.action.href} variant="light">
          {copy.action.label}
        </Button>
      </Stack>
    </Center>
  );
}
