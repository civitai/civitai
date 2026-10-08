import { Badge } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconClock, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';

import { describeBuildFailure } from '~/components/Apps/buildFailure';
import {
  isStaleDeploy,
  isStrandedDeploy,
  type DeployLifecycleRow,
} from '~/components/Apps/deploy-status';

/**
 * Copy for the STRANDED state, shared by the badge tooltip and the alert below the entry
 * so the two can never drift. The author cannot fix this themselves — the approval is
 * durable and only a moderator can re-fire the build — so the guidance is to ask, NOT to
 * resubmit at a new version.
 */
export const STRANDED_DEPLOY_MESSAGE =
  'This version was approved but its build never started, so the code was never deployed. ' +
  'This is not something you can fix by editing your app — contact a moderator to re-run the build.';

/**
 * Tooltip for a build or deploy with no recorded progress past the stale threshold. A
 * stuck pipeline is never the author's code, so it does not tell them to resubmit.
 */
export const STALLED_DEPLOY_MESSAGE =
  "No progress for a while — the build may be stuck. This isn't something you need to fix in your app; contact us if it doesn't go live.";

export type DeployStatusRow = DeployLifecycleRow & { deployDetail?: string | null };

/**
 * The build/deploy chip for an APPROVED version, or `null` when there is nothing to say
 * beyond "approved" (a non-approved row, a legacy row with no recorded lifecycle, a
 * approved row with no state yet that is not old enough to count as stranded, or a live version that is no longer
 * the published one). Callers render the request status themselves.
 *
 * Order matters: STRANDED and STALLED are checked before the plain state, because both
 * would otherwise read as healthy (`approved`) or as progressing (`building`).
 */
export function deployStatusBadge(
  row: DeployStatusRow,
  opts: {
    /** Only the currently published version wears "live"; an older one says nothing. */
    isCurrentlyPublished: boolean;
    now?: number;
  }
): ReactNode {
  if (row.status !== 'approved') return null;
  const now = opts.now ?? Date.now();
  if (isStrandedDeploy(row, now)) {
    return (
      <Badge
        color="orange"
        leftSection={<IconAlertTriangle size={12} />}
        title={STRANDED_DEPLOY_MESSAGE}
      >
        build never started
      </Badge>
    );
  }
  if (isStaleDeploy(row, now)) {
    return (
      <Badge
        color="orange"
        leftSection={<IconAlertTriangle size={12} />}
        title={STALLED_DEPLOY_MESSAGE}
      >
        {row.deployState} (stalled)
      </Badge>
    );
  }
  switch (row.deployState) {
    case 'building':
      return (
        <Badge color="blue" leftSection={<IconClock size={12} />}>
          building
        </Badge>
      );
    case 'deploying':
      return (
        <Badge color="indigo" leftSection={<IconClock size={12} />}>
          deploying
        </Badge>
      );
    case 'failed':
      // The label comes from the same classifier as the detail block, so the chip can
      // never say "deploy failed" for what was a build or scan failure.
      return (
        <Badge color="red" leftSection={<IconX size={12} />}>
          {describeBuildFailure(row.deployDetail).badge}
        </Badge>
      );
    case 'live':
      return opts.isCurrentlyPublished ? (
        <Badge color="green" leftSection={<IconCheck size={12} />}>
          live
        </Badge>
      ) : null;
    default:
      return null;
  }
}
