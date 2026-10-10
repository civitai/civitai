import { Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';

/**
 * The destination, split at the end of its origin so the part that decides whether a link is safe
 * reads first and the path recedes behind it.
 *
 * 🔴 Never an `Anchor` and never link-coloured. This is the thing being warned about, not something
 * to click — styling it as a link invites exactly the click the warning exists to interrupt.
 */
function Destination({ href }: { href: string }) {
  const { origin, rest } = (() => {
    try {
      const url = new URL(href);
      return { origin: url.origin, rest: `${url.pathname}${url.search}${url.hash}` };
    } catch {
      return { origin: href, rest: '' };
    }
  })();

  return (
    <div className="rounded-md border border-gray-3 bg-gray-0 px-3 py-2 dark:border-dark-4 dark:bg-dark-6">
      <Text size="sm" className="break-all font-mono leading-snug">
        <span className="font-semibold">{origin}</span>
        {rest !== '/' && <span className="text-gray-6 dark:text-dark-2">{rest}</span>}
      </Text>
    </div>
  );
}

export function ExternalLinkWarningTitle() {
  return (
    <Group gap="xs" wrap="nowrap">
      {/* Sized down to clear the modal's own close button, which shares this line at 320px. */}
      <ThemeIcon color="yellow" variant="light" radius="xl" size="md">
        <IconExternalLink size={16} />
      </ThemeIcon>
      <Text fw={600}>You&apos;re leaving Civitai</Text>
    </Group>
  );
}

export function ExternalLinkWarningBody({ href }: { href: string }) {
  return (
    <Stack gap="sm">
      <Text size="sm">This link takes you to a site Civitai does not control:</Text>
      <Destination href={href} />
      {/* Author-neutral on purpose: this also fires on Civitai's own sitewide announcements,
          where a claim that Civitai has neither reviewed nor endorsed the destination is false. */}
      <Text size="xs" c="dimmed">
        Check the address before you continue, and never enter your Civitai password or payment
        details on another site.
      </Text>
    </Stack>
  );
}
