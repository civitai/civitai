import { Button } from '@mantine/core';
import { IconGavel } from '@tabler/icons-react';
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

/** Drops the judge into the newest open crucible that still has pairs for them. */
export function CrucibleJudgeNextButton() {
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
        { browsingLevel, limit: 12 },
        { staleTime: 0 }
      );
      // Hidden users, tags and words are client-side only; the server can't apply them.
      const [next] = filterPreferences({
        type: 'crucibles',
        data: suggestions,
        hiddenPreferences,
        browsingLevel,
        currentUser,
        canViewNsfw,
        poiDisabled: browsingSettingsAddons.settings.disablePoi,
        minorDisabled: browsingSettingsAddons.settings.disableMinor,
      }).items;
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

  return (
    <Button
      variant="light"
      radius="xl"
      leftSection={<IconGavel size={18} />}
      loading={loading}
      onClick={handleClick}
    >
      Start Judging
    </Button>
  );
}
