import { Button, Divider, ScrollArea, Stack } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';
import { useState } from 'react';
import { BrowsingLevelsInput } from '~/components/BrowsingLevel/BrowsingLevelInput';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { FilterChip } from '~/components/Filters/FilterChip';
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
import { useDomainColor } from '~/hooks/useDomainColor';
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

function MaybeScrollArea({
  maxHeight,
  children,
}: {
  maxHeight?: number;
  children: React.ReactNode;
}) {
  if (!maxHeight) return <>{children}</>;
  return <ScrollArea.Autosize mah={maxHeight}>{children}</ScrollArea.Autosize>;
}

const levelHint = (level: number) =>
  level ? 'Only these levels show in this hub.' : 'No limit — your own browsing settings decide.';

export function HubSourcePanel({
  hub,
  hideAdd,
  listMaxHeight,
}: {
  hub: HubPanelHub;
  hideAdd?: boolean;
  /** Cap the source list so the duplicate button below it stays in view. */
  listMaxHeight?: number;
}) {
  const invalidateHub = useInvalidateHub();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const domainColor = useDomainColor();
  // The viewer's own ceiling: account setting intersected with the domain cap. Read
  // here rather than inside the feed's provider, so it is the UNoverridden value.
  const viewerAllowedLevel = useBrowsingLevelDebounced();
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
  const isGreen = domainColor === 'green';

  if (hub.isOwner) {
    const current = pending ?? hub.sources;

    return (
      <Stack gap="sm">
        {showLevels && (
          <BrowsingLevelsInput
            compact
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
  //
  // Intersected with the viewer's OWN allowed level as well, which is the half that
  // matters: this picker feeds `BrowsingLevelProvider` as a `browsingLevelOverride`,
  // and that outranks `userBrowsingLevel` — the value where "Enable mature content"
  // lives. Without the intersection, a viewer who has mature content switched off
  // could tick X and be served it. The only other level picker on the site sits
  // under the over-18 confirmation in account settings; this one has to earn its
  // ceiling instead.
  const offeredLevels: readonly BrowsingLevel[] = browsingLevels.filter(
    (level) =>
      (!hub.forcedBrowsingLevel || Flags.hasFlag(hub.forcedBrowsingLevel, level)) &&
      Flags.hasFlag(viewerAllowedLevel, level)
  );
  const viewerLevel = sessionLevel ?? hub.forcedBrowsingLevel;

  return (
    <Stack gap="sm">
      {/* Only on a hub whose owner actually set a level. Without one the feed already
          follows the viewer's own global settings, so a picker here would be a second
          place to change the same thing. Also hidden when the intersection leaves one
          level, where a single locked chip reads as a control that does nothing. */}
      {showLevels && !!hub.forcedBrowsingLevel && offeredLevels.length > 1 && (
        <BrowsingLevelsInput
          compact
          label="Content levels"
          description={levelHint(viewerLevel)}
          value={viewerLevel}
          levels={offeredLevels}
          allowEmpty
          onChange={(level) => setSessionLevel(hub.id, level)}
        />
      )}

      {/* Green has no level picker by design — the domain caps everyone at PG-13 —
          but it does have the PG-13 opt-in, and a viewer must get their own rather
          than inherit whatever the owner saved on their hub. Gated on the DOMAIN,
          not on `canViewNsfw`: that flag is also false for a region-restricted user
          on blue/red, and the feed only reads `includePG13` on green, so they would
          get a switch that does nothing. Same control the filter menu offers. */}
      {isGreen && !!currentUser && (
        <FilterChip
          checked={sessionIncludePG13}
          onChange={(checked) => setSessionIncludePG13(hub.id, checked)}
        >
          <span>Include PG-13</span>
        </FilterChip>
      )}

      {/* Scrolled ONLY where a caller asked for it — the popover. The rail already
          renders inside a `ScrollArea.Autosize`, and nesting a second one there gives
          the rail a scroller measuring a width nothing shows, which drags the whole
          sidebar out of the layout. */}
      <MaybeScrollArea maxHeight={listMaxHeight}>
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
        />
      </MaybeScrollArea>

      {
        // Duplicating copies the owner's whole source list into an account of your
        // own, which is a write, not a view — so it is offered on a hub anyone can
        // already open, and not on a private one a moderator opened to look at it.
        //
        // Outside the scroller on purpose: it is the answer to "these are not mine to
        // change", and a long source list would bury it.
        hub.availability === Availability.Public && (
          <>
            {/* Full-bleed, so the cut-off above it reads as the edge of a footer
                rather than as a list that happens to stop there. `Popover.Dropdown`
                pads by `sm`, which this cancels. */}
            <Divider mx="-sm" />
            <LoginRedirect reason="duplicate-hub">
              <Button
                fullWidth
                size="compact-sm"
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
          </>
        )
      }
    </Stack>
  );
}
