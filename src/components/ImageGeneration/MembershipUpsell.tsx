import { Alert, Button, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useSelectedBuzzType } from '~/components/generation_v2/FormFooter';
import {
  encodeGenerationHandoff,
  GENERATION_HANDOFF_PARAM,
} from '~/components/generation_v2/utils/generation-url-handoff';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useGraph } from '~/libs/data-graph/react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import { syncAccount } from '~/utils/sync-account';

const BLUE_BUZZ_ACKNOWLEDGED_KEY = 'blue-buzz-mature-acknowledged';

export type MembershipUpsellVariant = 'blue-on-red' | 'yellow-on-green' | null;

/**
 * Hook to check if a buzz-type routing warning should be shown.
 *
 * Two variants:
 * - `blue-on-red`: non-members on civitai.red who selected Blue Buzz. Acknowledgable
 *   (after first display, the full warning collapses to a compact reminder).
 * - `yellow-on-green`: anyone on civitai.com who selected Yellow Buzz. Always blocking
 *   — Yellow can't be spent on .com, so the user must reroute or switch back to Green.
 *
 * Returns:
 * - `canShow`: whether an upsell variant is relevant at all
 * - `acknowledged`: whether the user has dismissed the full blue-on-red warning
 * - `needsAcknowledgment`: true when the warning is blocking the footer submit
 * - `variant`: which variant applies (or null)
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

  let variant: MembershipUpsellVariant = null;
  if (features.isGreen && selectedType === 'yellow') {
    variant = 'yellow-on-green';
  } else if (!features.isGreen && !currentUser?.isPaidMember && selectedType === 'blue') {
    variant = 'blue-on-red';
  }

  const canShow = variant !== null;
  const needsAcknowledgment =
    variant === 'yellow-on-green' || (variant === 'blue-on-red' && !acknowledged);

  return { canShow, acknowledged, needsAcknowledgment, variant };
}

export function MembershipUpsell() {
  const { canShow, acknowledged, variant } = useMembershipUpsell();
  const { setBuzzType } = useSelectedBuzzType();
  const serverDomains = useServerDomains();
  const [, setAcknowledged] = useLocalStorage({
    key: BLUE_BUZZ_ACKNOWLEDGED_KEY,
    defaultValue: false,
  });

  const pricingUrl = `//${serverDomains.green}/pricing`;

  if (!canShow) return null;

  if (variant === 'yellow-on-green') {
    return <YellowOnGreenAlert onSwitchToGreen={() => setBuzzType('green')} />;
  }

  // blue-on-red — first time: full warning — blocks the footer submit buttons
  if (!acknowledged) {
    return (
      <Alert color="yellow" className="-m-2 rounded-none rounded-t-xl">
        <Text
          size="sm"
          fw={700}
          c="var(--mantine-color-yellow-light-color)"
          className="flex items-center gap-1.5"
        >
          <IconAlertTriangle size={16} />
          Blue Buzz can&apos;t generate mature content
        </Text>
        <Text size="xs" mt={4}>
          Your generation will be blocked if it produces mature results. Blue Buzz is limited to
          safe-for-work content only.
        </Text>
        <div className="mt-3 rounded-md border border-solid border-yellow-8/40 bg-white/40 p-2.5 dark:bg-dark-6/60">
          <Text size="xs" fw={600}>
            Unlock mature content with a membership
          </Text>
          <Text size="xs" style={{ opacity: 0.7 }}>
            Members can generate mature content on Civitai.red. Your membership from Civitai.com
            carries over automatically.
          </Text>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            component="a"
            href={syncAccount(pricingUrl)}
            target="_blank"
            rel="noreferrer nofollow"
            variant="filled"
            className="flex-1"
          >
            Become a member
          </Button>
          <Text
            size="xs"
            fw={700}
            className="cursor-pointer hover:underline"
            style={{ opacity: 0.6 }}
            onClick={() => setAcknowledged(true)}
          >
            Continue anyway
          </Text>
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

/**
 * Lives in its own component so `useGraph` is only invoked when the yellow-on-green
 * variant fires — by that point the user is interacting with the form, so the
 * DataGraphProvider is guaranteed to be in scope.
 */
function YellowOnGreenAlert({ onSwitchToGreen }: { onSwitchToGreen: () => void }) {
  const serverDomains = useServerDomains();
  const graph = useGraph<GenerationGraphTypes>();

  const buildRedUrl = () => {
    const snapshot = graph.getSnapshot() as Record<string, unknown>;
    const handoff = encodeGenerationHandoff(snapshot, {
      computedKeys: graph.getComputedKeys(),
    });
    const base = `//${serverDomains.red}/generate`;
    const withHandoff = handoff ? `${base}?${GENERATION_HANDOFF_PARAM}=${handoff}` : base;
    return syncAccount(withHandoff);
  };

  const handleGoToRed = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    window.open(buildRedUrl(), '_blank', 'noopener,noreferrer');
  };

  return (
    <Alert color="yellow" className="-m-2 rounded-none rounded-t-xl">
      <Text
        size="sm"
        fw={700}
        c="var(--mantine-color-yellow-light-color)"
        className="flex items-center gap-1.5"
      >
        <IconAlertTriangle size={16} />
        Yellow Buzz can&apos;t be used on Civitai.com
      </Text>
      <Text size="xs" mt={4}>
        Yellow Buzz is unrestricted. However, Civitai.com only allows safe for work content
        creation. To fully utilize your Yellow Buzz, go to Civitai.red.
      </Text>
      <div className="mt-3 flex items-center gap-3">
        <Button
          component="a"
          href={buildRedUrl()}
          onClick={handleGoToRed}
          target="_blank"
          rel="noreferrer nofollow"
          variant="filled"
          className="flex-1"
        >
          Go to Civitai.red
        </Button>
        <Text
          size="xs"
          fw={700}
          className="cursor-pointer hover:underline"
          style={{ opacity: 0.6 }}
          onClick={onSwitchToGreen}
        >
          Switch to Green Buzz
        </Text>
      </div>
    </Alert>
  );
}
