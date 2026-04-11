/**
 * GenerationLayout
 *
 * Layout shell for the generation form. Children render as the main content.
 * A single `footer` slot (via GenerationFooter) lets workflow branches declare
 * their own footer content from anywhere in the tree.
 *
 * GenerationLayoutFooter handles generation status, terms agreement, daily boost,
 * and the dismissible status message. Footer slot content only renders when
 * terms are reviewed and generation is available.
 */

import { useMemo, type ReactNode } from 'react';
import { Alert, Button, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import {
  DailyBoostRewardClaim,
  useDailyBoostReward,
} from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import {
  MembershipUpsell,
  useMembershipUpsell,
} from '~/components/ImageGeneration/MembershipUpsell';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useTourContext } from '~/components/Tours/ToursProvider';
import createSlots from '~/libs/slots/create-slots';
import { hashify } from '~/utils/string-helpers';

// =============================================================================
// Slots
// =============================================================================

const { SlotProvider, Footer, RenderFooter, useHasSlots } = createSlots(['footer']);

export { Footer as GenerationFooter };
export { useHasSlots as useHasGenerationSlots };

// =============================================================================
// GenerationLayout
// =============================================================================

export function GenerationLayout({ children }: { children: ReactNode }) {
  return (
    <SlotProvider>
      <div className="flex size-full flex-1 flex-col">
        <div className="flex w-full flex-1 flex-col gap-3 p-2">{children}</div>
        <GenerationLayoutFooter>
          <RenderFooter className="flex flex-col gap-2" />
        </GenerationLayoutFooter>
      </div>
    </SlotProvider>
  );
}

// =============================================================================
// GenerationLayoutFooter
// =============================================================================

function GenerationLayoutFooter({ children }: { children: ReactNode }) {
  const status = useGenerationStatus();
  const { running, helpers } = useTourContext();
  const dailyBoost = useDailyBoostReward();
  const membershipUpsell = useMembershipUpsell();
  const [reviewed, setReviewed] = useLocalStorage({
    key: 'review-generation-terms',
    defaultValue: window?.localStorage?.getItem('review-generation-terms') === 'true',
  });

  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : null),
    [status.message]
  );

  const showFooterContent =
    status.available && reviewed && !membershipUpsell.needsAcknowledgment;

  return (
    <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
      {!status.available ? (
        <AlertWithIcon
          color="yellow"
          title="Generation Status Alert"
          icon={<IconAlertTriangle size={20} />}
          iconColor="yellow"
        >
          {status.message}
        </AlertWithIcon>
      ) : !reviewed ? (
        <Alert
          color="yellow"
          title="Image Generation Terms"
          data-tour="gen:terms"
          className="-m-2 rounded-none rounded-t-xl"
        >
          <Text size="xs">
            By using the image generator you confirm that you have read and agree to our{' '}
            <Text component={Link} href="/content/tos" td="underline">
              Terms of Service
            </Text>{' '}
            presented during onboarding. Failure to abide by{' '}
            <Text component={Link} href="/safety#content-policies" td="underline">
              our content policies
            </Text>{' '}
            will result in the loss of your access to the image generator. Illegal or exploitative
            content will be removed and reported.
          </Text>
          <Button
            color="yellow"
            variant="light"
            onClick={() => {
              setReviewed(true);
              if (running) helpers?.next();
            }}
            style={{ marginTop: 10 }}
            leftSection={<IconCheck />}
            fullWidth
          >
            I Confirm, Start Generating
          </Button>
        </Alert>
      ) : membershipUpsell.needsAcknowledgment ? (
        <MembershipUpsell />
      ) : (
        <>{dailyBoost.canShow && <DailyBoostRewardClaim />}</>
      )}

      {/* Always keep the slot target in the DOM so portals can resolve it.
          Hidden when generation is unavailable or terms not yet reviewed. */}
      <div className={!showFooterContent ? 'hidden' : undefined}>{children}</div>

      {/* Dismissible status message — shown regardless of review state */}
      {status.available && status.message && messageHash && (
        <DismissibleAlert color="yellow" title="Generation Status Alert" id={messageHash}>
          <CustomMarkdown allowedElements={['a', 'strong']} unwrapDisallowed>
            {status.message}
          </CustomMarkdown>
        </DismissibleAlert>
      )}
    </div>
  );
}
