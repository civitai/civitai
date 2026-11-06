import { Card, Checkbox, Text } from '@mantine/core';
import { useEffect, useState } from 'react';

import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  FORK_OPT_IN_DESCRIPTION,
  FORK_OPT_IN_LABEL,
  FORK_OPT_IN_UNAVAILABLE_NOTE,
} from '~/shared/constants/app-fork.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const FORK_SETTING_SAVED_ON = 'Others can now fork this app.';
export const FORK_SETTING_SAVED_OFF = 'New forks of this app are turned off.';

/**
 * The author's "Let others fork this app's source" setting, on an on-site app's Details tab.
 *
 * 🔴 SAVES IMMEDIATELY, through `appListings.updateListing` with a `{ forkable }` patch — NOT
 * through the Details form beside it. That form saves an APPROVED listing as a revision for
 * moderator review (`updateRevisionDraft` + `submitListingRevision`), and the opt-in is trivial and
 * never staged: `updateRevisionDraft` refuses the key. `updateListing` applies a trivial patch to
 * the live listing in place, with no review, for owners and accepted collaborators alike.
 *
 * Shown while the `app-blocks-fork` rollout flag is on for the viewer — and ALSO, with the flag off,
 * on a listing that is already forkable, so an author can withdraw consent after a rollback (the
 * server refuses only turning it ON with the flag off). In that state the box can be unticked but
 * not ticked again. `forkableAvailable: false` means the database migration has not been applied
 * in this environment, so the panel says so instead of offering a write the server would refuse.
 */
type ListingForkSettingProps = {
  appListingId: string;
  forkable: boolean;
  forkableAvailable: boolean;
};

export function ListingForkSetting(props: ListingForkSettingProps) {
  const features = useFeatureFlags();
  const canEnable = !!features.appBlocksFork;
  // Flag off and nothing to withdraw ⇒ nothing below mounts, so no mutation hook is created.
  if (!canEnable && !props.forkable) return null;
  return <ListingForkSettingCard {...props} canEnable={canEnable} />;
}

function ListingForkSettingCard({
  appListingId,
  forkable,
  forkableAvailable,
  canEnable,
}: ListingForkSettingProps & { canEnable: boolean }) {
  const utils = trpc.useUtils();
  // Local so the box moves on click; re-synced whenever the server value changes.
  const [checked, setChecked] = useState(forkable);
  useEffect(() => setChecked(forkable), [forkable]);

  const save = trpc.appListings.updateListing.useMutation({
    onSuccess: async (_data, vars) => {
      showSuccessNotification({
        title: 'Saved',
        message: vars.patch.forkable ? FORK_SETTING_SAVED_ON : FORK_SETTING_SAVED_OFF,
      });
      await utils.appListings.getAuthoringContext.invalidate({ appListingId });
    },
    onError: (err, vars) => {
      // Put the box back where the server still has it.
      setChecked(!vars.patch.forkable);
      showErrorNotification({ title: 'Could not save', error: new Error(err.message) });
    },
  });

  return (
    <Card withBorder data-testid="apps-fork-setting">
      <Text fw={600} size="sm" mb="xs">
        Forking
      </Text>
      {forkableAvailable ? (
        <Checkbox
          label={FORK_OPT_IN_LABEL}
          description={FORK_OPT_IN_DESCRIPTION}
          checked={checked}
          disabled={save.isPending || (!canEnable && !checked)}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            setChecked(next);
            save.mutate({ listingId: appListingId, patch: { forkable: next } });
          }}
          data-testid="apps-fork-setting-checkbox"
        />
      ) : (
        <Text size="sm" c="dimmed" data-testid="apps-fork-setting-unavailable">
          {FORK_OPT_IN_UNAVAILABLE_NOTE}
        </Text>
      )}
    </Card>
  );
}
