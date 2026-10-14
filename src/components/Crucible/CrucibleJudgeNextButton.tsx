import { Button } from '@mantine/core';
import { IconArrowRight, IconGavel } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { filterPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import {
  pickNextCrucible,
  pickWeightedCrucible,
} from '~/components/Crucible/judging-next-crucible';
import type { CrucibleCyclePoint } from '~/components/Crucible/judging-next-crucible';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CRUCIBLE_JUDGING_SUGGESTION_CANDIDATES } from '~/shared/constants/crucible.constants';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showInfoNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Props = {
  /**
   * The crucible being judged. "Next" steps from it through the open crucibles in order, so
   * repeated presses visit each one. Without it, the pick is random, weighted toward crucibles
   * closing soon and with many pairs left.
   */
  cycleFrom?: CrucibleCyclePoint;
  /**
   * `primary` is the filled call to action, for where moving on is the main next step. `link` is
   * the quiet header action; on phones it shrinks to its arrow.
   */
  variant?: 'button' | 'link' | 'primary';
  label?: string;
};

/** Drops the judge into an open crucible that still has pairs for them. */
export function CrucibleJudgeNextButton({
  cycleFrom,
  variant = 'button',
  label = 'Start Judging',
}: Props = {}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const browsingLevel = useBrowsingLevelDebounced();
  const hiddenPreferences = useHiddenPreferencesContext();
  const currentUser = useCurrentUser();
  const { canViewNsfw } = useFeatureFlags();
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    setLoading(true);
    try {
      const suggestions = await utils.crucible.getJudgingSuggestions.fetch(
        { browsingLevel, limit: CRUCIBLE_JUDGING_SUGGESTION_CANDIDATES },
        { staleTime: 0 }
      );
      // Hidden users, tags and words are client-side only; the server can't apply them.
      // filterPreferences returns every feed's item union; useApplyHiddenPreferences casts the same way.
      const visible = filterPreferences({
        type: 'crucibles',
        data: suggestions,
        hiddenPreferences,
        browsingLevel,
        currentUser,
        canViewNsfw,
        poiDisabled: browsingSettingsAddons.settings.disablePoi,
        minorDisabled: browsingSettingsAddons.settings.disableMinor,
      }).items as typeof suggestions;
      const next = cycleFrom ? pickNextCrucible(visible, cycleFrom) : pickWeightedCrucible(visible);
      if (!next) {
        showInfoNotification({
          title: 'Nothing to judge right now',
          message: "You're caught up on every open crucible. New entries open new pairs.",
        });
        return;
      }
      await router.push(`/crucibles/${next.id}/judge`);
    } catch (error) {
      showErrorNotification({
        title: 'Could not find a crucible to judge',
        error: error as Error,
      });
    } finally {
      setLoading(false);
    }
  };

  if (variant === 'link') {
    return (
      <Button
        variant="subtle"
        color="blue"
        size="compact-sm"
        aria-label={label}
        className="max-md:px-1.5"
        loading={loading}
        onClick={handleClick}
      >
        <span className="flex items-center gap-1.5">
          <span className="max-md:hidden">{label}</span>
          <IconArrowRight size={16} />
        </span>
      </Button>
    );
  }

  if (variant === 'primary') {
    return (
      <Button
        variant="filled"
        color="blue"
        rightSection={<IconArrowRight size={16} />}
        loading={loading}
        onClick={handleClick}
      >
        {label}
      </Button>
    );
  }

  return (
    <Button
      variant="light"
      radius="xl"
      leftSection={<IconGavel size={18} />}
      loading={loading}
      onClick={handleClick}
    >
      {label}
    </Button>
  );
}
