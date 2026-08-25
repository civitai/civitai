import { Alert, Button, Chip, Group, Stack, Text } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';
import { useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { HubSourceEditor } from '~/components/Hubs/HubSourceEditor';
import HubUpsertModal from '~/components/Hubs/HubUpsertModal';
import { buildDuplicateHubInput, useInvalidateHub } from '~/components/Hubs/hub.utils';
import {
  hubSourceKey,
  useHubExcludedSources,
  useHubSessionBrowsingLevel,
  useSetHubSessionBrowsingLevel,
  useToggleHubSessionSource,
} from '~/components/Hubs/hub-session.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { browsingLevelLabels, browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type HubPanelHub = {
  id: number;
  name: string;
  nsfwLevel: number;
  isOwner: boolean;
  sources: HubSourceValue[];
};

/**
 * The level control, which lives in Sources rather than in the filter menu because
 * it is a property of the hub and not of this visit (subtask 868kwp5f2). It does
 * not render on green at all: there is no level to pick above the domain's own cap,
 * and the PG-13 opt-in in the filter menu already covers what a green viewer can
 * change.
 */
function HubLevelSelector({
  value,
  offered,
  disabled,
  onChange,
}: {
  value: number;
  offered: readonly number[];
  disabled?: boolean;
  onChange: (level: number) => void;
}) {
  return (
    <Stack gap={4}>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed">
        Content levels
      </Text>
      <Chip.Group
        multiple
        value={Flags.instanceToArray(value).map(String)}
        onChange={(next) => onChange(Flags.arrayToInstance(next.map(Number)))}
      >
        <Group gap={4}>
          {offered.map((level) => (
            <Chip key={level} value={String(level)} size="xs" disabled={disabled}>
              {browsingLevelLabels[level as keyof typeof browsingLevelLabels]}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      <Text size="xs" c="dimmed">
        {value
          ? 'Only these levels show in this hub.'
          : 'No limit — your own browsing settings decide.'}
      </Text>
    </Stack>
  );
}

export function HubSourcePanel({ hub, hideAdd }: { hub: HubPanelHub; hideAdd?: boolean }) {
  const invalidateHub = useInvalidateHub();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const [pending, setPending] = useState<HubSourceValue[] | null>(null);

  const excluded = useHubExcludedSources(hub.id);
  const toggleSessionSource = useToggleHubSessionSource();
  const sessionLevel = useHubSessionBrowsingLevel(hub.id);
  const setSessionLevel = useSetHubSessionBrowsingLevel();

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

  // A level control is only meaningful where the viewer could pick something above
  // PG-13 in the first place. Anonymous viewers are capped to PG server-side on
  // every domain, so offering them the control would be offering them a lie.
  const showLevels = features.canViewNsfw && !!currentUser;

  if (hub.isOwner) {
    const current = pending ?? hub.sources;

    return (
      <Stack gap="sm">
        {showLevels && (
          <HubLevelSelector
            value={hub.nsfwLevel}
            offered={browsingLevels}
            disabled={upsert.isPending}
            onChange={(nsfwLevel) => upsert.mutate({ id: hub.id, nsfwLevel })}
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
  const offeredLevels = hub.nsfwLevel
    ? browsingLevels.filter((level) => Flags.hasFlag(hub.nsfwLevel, level))
    : browsingLevels;

  return (
    <Stack gap="sm">
      {showLevels && (
        <HubLevelSelector
          value={sessionLevel ?? hub.nsfwLevel}
          offered={offeredLevels}
          onChange={(level) => setSessionLevel(hub.id, level)}
        />
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
        }
      />
    </Stack>
  );
}
