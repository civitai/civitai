import { Button } from '@mantine/core';
import { IconArrowRight, IconGavel } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { filterPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showInfoNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Props = {
  /** Leaves this crucible out, so "next" from a judge page never lands back on it. */
  excludeCrucibleId?: number;
  /** `primary` is the filled call to action, for where moving on is the main next step. */
  variant?: 'button' | 'link' | 'primary';
  label?: string;
};

/** Drops the judge into the newest open crucible that still has pairs for them. */
export function CrucibleJudgeNextButton({
  excludeCrucibleId,
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
        { browsingLevel, limit: 12, excludeCrucibleId },
        { staleTime: 0 }
      );
      // Hidden users, tags and words are client-side only; the server can't apply them.
      // filterPreferences returns every feed's item union; useApplyHiddenPreferences casts the same way.
      const [next] = filterPreferences({
        type: 'crucibles',
        data: suggestions,
        hiddenPreferences,
        browsingLevel,
        currentUser,
        canViewNsfw,
        poiDisabled: browsingSettingsAddons.settings.disablePoi,
        minorDisabled: browsingSettingsAddons.settings.disableMinor,
      }).items as typeof suggestions;
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
        rightSection={<IconArrowRight size={14} />}
        loading={loading}
        onClick={handleClick}
      >
        {label}
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
