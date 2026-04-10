import { Alert, Button, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useSelectedBuzzType } from '~/components/generation_v2/FormFooter';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { colorDomains } from '~/shared/constants/domain.constants';

const BLUE_BUZZ_ACKNOWLEDGED_KEY = 'blue-buzz-mature-acknowledged';

/**
 * Hook to check if the blue buzz warning should be shown.
 * Shows on civitai.red for non-members when blue buzz is selected.
 *
 * Returns:
 * - `canShow`: whether the upsell is relevant at all
 * - `acknowledged`: whether the user has dismissed the full warning
 * - `needsAcknowledgment`: true when the full warning is blocking the footer
 */
export function useMembershipUpsell() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { selectedType } = useSelectedBuzzType();
  const [acknowledged] = useLocalStorage({
    key: BLUE_BUZZ_ACKNOWLEDGED_KEY,
    defaultValue:
      typeof window !== 'undefined'
        ? window.localStorage?.getItem(BLUE_BUZZ_ACKNOWLEDGED_KEY) === 'true'
        : false,
  });

  const isRelevant = !features.isGreen && !currentUser?.isPaidMember && selectedType === 'blue';

  return {
    canShow: isRelevant,
    acknowledged,
    needsAcknowledgment: isRelevant && !acknowledged,
  };
}

export function MembershipUpsell() {
  const { canShow, acknowledged } = useMembershipUpsell();
  const { setBuzzType } = useSelectedBuzzType();
  const [, setAcknowledged] = useLocalStorage({
    key: BLUE_BUZZ_ACKNOWLEDGED_KEY,
    defaultValue: false,
  });

  const pricingUrl = colorDomains.green ? `//${colorDomains.green}/pricing` : '/pricing';

  if (!canShow) return null;

  // First time: full warning — blocks the footer submit buttons
  if (!acknowledged) {
    return (
      <Alert p="md" pb="sm" color="yellow" variant="outline">
        <div className="flex flex-col gap-3">
          <div>
            <Text size="sm" fw={700} className="flex items-center gap-1.5">
              <IconAlertTriangle size={16} color="var(--mantine-color-yellow-6)" />
              Blue Buzz can&apos;t generate mature content
            </Text>
            <Text size="sm" mt={4}>
              Your generation will be blocked if it produces mature results. Blue Buzz is limited to
              safe-for-work content.
            </Text>
          </div>
          <div className="rounded-md border border-solid border-gray-4 p-2.5 dark:border-dark-4">
            <Text size="sm" fw={600}>
              Unlock mature content with a membership
            </Text>
            <Text size="xs" c="dimmed">
              Members can generate mature content on Civitai.red with Blue Buzz — your membership
              carries over automatically.
            </Text>
          </div>
          <div className="flex gap-2">
            <Button
              component="a"
              href={pricingUrl}
              target="_blank"
              rel="noreferrer nofollow"
              variant="filled"
              size="sm"
              className="flex-1"
            >
              Become a member
            </Button>
            <Button
              variant="default"
              size="sm"
              className="flex-1"
              onClick={() => setAcknowledged(true)}
            >
              Continue anyway
            </Button>
          </div>
        </div>
      </Alert>
    );
  }

  // After acknowledging: compact reminder
  return (
    <Alert p="xs" color="yellow" icon={<IconAlertTriangle size={14} />}>
      <Text size="xs">
        Blue Buzz is limited to safe-for-work content.{' '}
        <Text
          span
          c="blue.4"
          className="cursor-pointer"
          component="a"
          href={pricingUrl}
          target="_blank"
          rel="noreferrer nofollow"
          size="xs"
        >
          Get a membership
        </Text>{' '}
        to unlock mature generation, or{' '}
        <Text
          span
          c="blue.4"
          className="cursor-pointer"
          onClick={() => setBuzzType('yellow')}
          size="xs"
        >
          switch to Yellow Buzz
        </Text>
        .
      </Text>
    </Alert>
  );
}
