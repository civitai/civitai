import { Alert, Button, Stack, Switch, Text } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';
import { useState } from 'react';
import { BrowsingLevelsInput } from '~/components/BrowsingLevel/BrowsingLevelInput';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { HubSourceEditor } from '~/components/Hubs/HubSourceEditor';
import HubUpsertModal from '~/components/Hubs/HubUpsertModal';
import { buildDuplicateHubInput, useInvalidateHub } from '~/components/Hubs/hub.utils';
import {
  useHubExcludedSources,
  useHubSessionBrowsingLevel,
  useHubSessionIncludePG13,
  useSetHubSessionBrowsingLevel,
  useSetHubSessionIncludePG13,
  useToggleHubSessionSource,
} from '~/components/Hubs/hub-session.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { hubSourceKey } from '~/server/schema/user-hub.schema';
import type { BrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { Availability } from '~/shared/utils/prisma/enums';
import { Flags } from '~/shared/utils/flags';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type HubPanelHub = {
  id: number;
  name: string;
  forcedBrowsingLevel: number;
  availability: Availability;
  isOwner: boolean;
  sources: HubSourceValue[];
};

const levelHint = (level: number) =>
  level ? 'Only these levels show in this hub.' : 'No limit — your own browsing settings decide.';

export function HubSourcePanel({ hub, hideAdd }: { hub: HubPanelHub; hideAdd?: boolean }) {
  const invalidateHub = useInvalidateHub();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const [pending, setPending] = useState<HubSourceValue[] | null>(null);

  const excluded = useHubExcludedSources(hub.id);
  const toggleSessionSource = useToggleHubSessionSource();
  const sessionLevel = useHubSessionBrowsingLevel(hub.id);
  const setSessionLevel = useSetHubSessionBrowsingLevel();
  const sessionIncludePG13 = useHubSessionIncludePG13(hub.id);
  const setSessionIncludePG13 = useSetHubSessionIncludePG13();

  const upsert = trpc.userHub.upsert.useMutation({
    onSuccess: async () => {
      await invalidateHub(hub.id);
      setPending(null);
    },
    onError: (error) => {
      // Roll the optimistic list back — leaving it applied would show a source the
      // server refused (a private or rating-capped collection) as if it were saved.
      setPending(null);
      showErrorNotification({ title: 'Could not save sources', error: new Error(error.message) });
    },
  });

  // A level picker is only meaningful where the viewer could choose something above
  // PG-13 in the first place. Anonymous viewers are capped to PG server-side on
  // every domain, so offering them the picker would be offering them a lie.
  const showLevels = features.canViewNsfw && !!currentUser;

  if (hub.isOwner) {
    const current = pending ?? hub.sources;

    return (
      <Stack gap="sm">
        {showLevels && (
          <BrowsingLevelsInput
            label="Content levels"
            description={levelHint(hub.forcedBrowsingLevel)}
            value={hub.forcedBrowsingLevel}
            allowEmpty
            onChange={(forcedBrowsingLevel) => upsert.mutate({ id: hub.id, forcedBrowsingLevel })}
          />
        )}
        <HubSourceEditor
          value={current}
          hideAdd={hideAdd}
          disabled={upsert.isPending}
          emptyMessage="Nothing here yet. Add a creator, a model or a public collection."
          onChange={(next) => {
            setPending(next);
            upsert.mutate({ id: hub.id, sources: next.map((s, index) => ({ ...s, index })) });
          }}
        />
      </Stack>
    );
  }

  // --- A hub you do not own. Nothing below writes.

  // Only what the owner has switched on: a source they switched off contributes
  // nothing, so listing it would offer a toggle that cannot change the feed.
  const ownerEnabled = hub.sources.filter((source) => source.enabled);
  const excludedKeys = new Set(excluded.map(hubSourceKey));
  const view = ownerEnabled.map((source) => ({
    ...source,
    enabled: !excludedKeys.has(hubSourceKey(source)),
  }));

  // Under the hub's own cap, never above it: the owner's level is what the server
  // enforces, so offering a level it would strip back out would be a control that
  // does nothing.
  const offeredLevels: readonly BrowsingLevel[] = hub.forcedBrowsingLevel
    ? browsingLevels.filter((level) => Flags.hasFlag(hub.forcedBrowsingLevel, level))
    : browsingLevels;
  const viewerLevel = sessionLevel ?? hub.forcedBrowsingLevel;

  return (
    <Stack gap="sm">
      {showLevels ? (
        <BrowsingLevelsInput
          label="Content levels"
          description={levelHint(viewerLevel)}
          value={viewerLevel}
          levels={offeredLevels}
          allowEmpty
          onChange={(level) => setSessionLevel(hub.id, level)}
        />
      ) : (
        // Green has no level picker by design — the domain caps everyone at PG-13 —
        // but it does have the PG-13 opt-in, and a viewer must get their own rather
        // than inherit whatever the owner saved on their hub.
        !!currentUser && (
          <Switch
            size="xs"
            label="Include PG-13"
            checked={sessionIncludePG13}
            onChange={(event) => setSessionIncludePG13(hub.id, event.currentTarget.checked)}
          />
        )
      )}

      <HubSourceEditor
        readOnly
        value={view}
        emptyMessage="This hub has no sources switched on."
        onChange={(next) => {
          for (const source of next) {
            const was = !excludedKeys.has(hubSourceKey(source));
            if (was !== source.enabled) toggleSessionSource(hub.id, source, source.enabled);
          }
        }}
        footer={
          // Duplicating copies the owner's whole source list into an account of your
          // own, which is a write, not a view — so it is offered on a hub anyone can
          // already open, and not on a private one a moderator opened to look at it.
          hub.availability === Availability.Public ? (
            <Alert p="xs" radius="md" variant="light">
              <Stack gap={6} align="flex-start">
                <Text size="xs">Want to customize sources? Duplicate this hub.</Text>
                <LoginRedirect reason="duplicate-hub">
                  <Button
                    size="compact-xs"
                    leftSection={<IconCopy size={14} />}
                    onClick={() =>
                      dialogStore.trigger({
                        component: HubUpsertModal,
                        props: { duplicateOf: buildDuplicateHubInput(hub) },
                      })
                    }
                  >
                    Duplicate this hub
                  </Button>
                </LoginRedirect>
              </Stack>
            </Alert>
          ) : null
        }
      />
    </Stack>
  );
}
