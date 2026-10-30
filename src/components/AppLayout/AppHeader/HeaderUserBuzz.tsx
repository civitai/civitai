import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { UserBuzz } from '~/components/User/UserBuzz';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function HeaderUserBuzz() {
  const { hideBlueBuzzInHeader } = useCurrentUserSettings();
  const [mainBuzzColor] = useAvailableBuzz();
  const { buzzSpendPop } = useFeatureFlags();

  // Undefined, not the full list: `UserBuzz` resolves its own default, so the off state stays
  // whatever the blended header has always shown.
  return (
    <UserBuzz
      animated={buzzSpendPop}
      withDeltaPop={buzzSpendPop}
      iconGap={2}
      pr={{ base: 0, md: 'sm' }}
      accountTypes={hideBlueBuzzInHeader ? [mainBuzzColor] : undefined}
    />
  );
}
