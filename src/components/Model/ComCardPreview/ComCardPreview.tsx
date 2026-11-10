import { Anchor, Group, Switch, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { domainForcedBrowsingLevel } from '~/components/BrowsingLevel/resolve-browsing-level';
import { useServerDomains } from '~/providers/AppProvider';
import { useSyncAccount } from '~/hooks/useSyncAccount';

export function ComCardPreviewToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Switch
      size="xs"
      label="Preview civitai.com card"
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

export function RedCardLink({ path }: { path: string }) {
  const serverDomains = useServerDomains();
  const syncAccount = useSyncAccount();
  return (
    <Group gap={4}>
      <Text size="xs" c="dimmed">
        You&apos;re seeing this model&apos;s civitai.com card: its title and description differ from
        the original on civitai.red.
      </Text>
      <Anchor size="xs" href={syncAccount(`//${serverDomains.red}${path}`)}>
        See the civitai.red card
      </Anchor>
    </Group>
  );
}

// loggedIn is hard-coded: the preview toggle is only shown to a signed-in owner or moderator.
const COM_CARD_BROWSING_LEVEL = domainForcedBrowsingLevel({ canViewNsfw: false, loggedIn: true });

/** Always renders the provider so toggling the preview does not remount the page body. */
export function ComCardPreviewScope({
  previewing,
  children,
}: {
  previewing: boolean;
  children: ReactNode;
}) {
  return (
    <BrowsingLevelProvider forcedBrowsingLevel={previewing ? COM_CARD_BROWSING_LEVEL : undefined}>
      {children}
    </BrowsingLevelProvider>
  );
}

/** For queries that run above ComCardPreviewScope and so can't read its context. */
export function useComCardBrowsingLevel(previewing: boolean) {
  return previewing ? COM_CARD_BROWSING_LEVEL : undefined;
}
