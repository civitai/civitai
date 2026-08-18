import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { UserBuzz } from '~/components/User/UserBuzz';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';

export function HeaderUserBuzz() {
  const { hideBlueBuzzInHeader } = useCurrentUserSettings();
  const [mainBuzzColor] = useAvailableBuzz();

  // Undefined, not the full list: `UserBuzz` resolves its own default, so the off state stays
  // whatever the blended header has always shown.
  return <UserBuzz pr="sm" accountTypes={hideBlueBuzzInHeader ? [mainBuzzColor] : undefined} />;
}
