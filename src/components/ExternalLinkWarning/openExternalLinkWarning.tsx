import { Anchor, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';

const hostOf = (href: string) => {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
};

/**
 * 🔴 `noopener` is not cosmetic here: without it the destination gets a live `window.opener`
 * handle back to the Civitai tab and can navigate it.
 */
export function openExternalLinkWarning(href: string) {
  openConfirmModal({
    title: "You're leaving Civitai",
    centered: true,
    labels: { cancel: 'Cancel', confirm: 'Continue' },
    children: (
      <Stack gap="xs">
        <Text size="sm">This link takes you to a site Civitai does not control:</Text>
        <Anchor component="span" fw={600} className="break-all">
          {hostOf(href)}
        </Anchor>
        <Text size="xs" c="dimmed" className="break-all">
          {href}
        </Text>
        {/* Author-neutral on purpose: this also fires on Civitai's own sitewide announcements,
            where a claim that Civitai has neither reviewed nor endorsed the destination is false. */}
        <Text size="sm">
          Check the address before you continue, and never enter your Civitai password or payment
          details on another site.
        </Text>
      </Stack>
    ),
    onConfirm: () => {
      window.open(href, '_blank', 'noopener,noreferrer');
    },
  });
}
