/**
 * GenerationLayout
 *
 * Layout shell for the generation form. Children render as the main content.
 * A single `footer` slot (via GenerationFooter) lets workflow branches declare
 * their own footer content from anywhere in the tree.
 *
 * GenerationLayoutFooter handles generation status, the terms gates (FooterTermsGate),
 * daily boost, and the dismissible status message. Footer slot content only renders
 * while no takeover panel owns the footer.
 */

import clsx from 'clsx';
import { useMemo, type ReactNode } from 'react';
import { Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconAlertTriangle } from '@tabler/icons-react';

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
import { useSelfHostedBlock, SelfHostedBlockedAlert } from '~/components/Generation/footer-parts';
import { useGenerationFormValue } from '~/components/Generate/useGenerationFormBridge';
import { useGenerationLicenseFor } from '~/components/form-graph/generation/useGenerationLicense';
import { FooterTermsGate, pickFooterTakeover } from '~/components/generation_v2/FooterTermsGate';
import { FooterStrips, footerStripsFrame } from '~/components/generation_v2/FooterStrips';
import { useMobileGenerator } from '~/hooks/useMobileGenerator';
import classes from './GenerationLayout.module.scss';

// =============================================================================
// Slots
// =============================================================================

// `setupModel`: the form's model and versions draw into the model card at the top (WorkflowRow).
const { SlotProvider, Footer, RenderFooter, SetupModel, RenderSetupModel, useHasSlots } =
  createSlots(['footer', 'setupModel']);

export { Footer as GenerationFooter };
export { SetupModel as GenerationSetupModel, RenderSetupModel as RenderGenerationSetupModel };
export { SlotProvider as GenerationSlotProvider };
export { useHasSlots as useHasGenerationSlots };

// =============================================================================
// GenerationLayout
// =============================================================================

export function GenerationLayout({ children }: { children: ReactNode }) {
  return (
    <SlotProvider>
      <div className={clsx(classes.root, 'flex size-full flex-1 flex-col')}>
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
  // When the selected ecosystem is disabled by the self-hosted toggle, take over
  // the footer with the blocked alert and hide the form controls — same slot /
  // treatment as MembershipUpsell. The model picker (above the footer) stays
  // usable, so switching models clears the block.
  const { blockedEcosystem: selfHostedBlocked } = useSelfHostedBlock();
  const [reviewed, setReviewed] = useLocalStorage({
    key: 'review-generation-terms',
    defaultValue: window?.localStorage?.getItem('review-generation-terms') === 'true',
  });

  const ecosystem = useGenerationFormValue<string>('ecosystem');
  const license = useGenerationLicenseFor(ecosystem);
  const takeover = pickFooterTakeover({
    available: status.available,
    selfHostedBlocked: !!selfHostedBlocked,
    termsReviewed: reviewed,
    licenseBlocked: license.blocked,
    membershipNeedsAcknowledgment: membershipUpsell.needsAcknowledgment,
  });

  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : null),
    [status.message]
  );

  const showFooterContent = !takeover;
  // In the mobile generator the status message joins the strips above the Generate row; elsewhere it
  // renders below the form.
  const mobileGenerator = useMobileGenerator();

  const statusMessage = status.available && status.message && messageHash && (
    <DismissibleAlert color="yellow" title="Generation Status Alert" id={messageHash}>
      <CustomMarkdown allowedElements={['a', 'strong']} unwrapDisallowed>
        {status.message}
      </CustomMarkdown>
    </DismissibleAlert>
  );

  return (
    // On a phone the generator fills the viewport, so this bar is the viewport bottom — hence
    // the safe-area padding.
    <div
      data-generator-footer
      className={clsx(
        'shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 pb-[max(0.5rem,var(--safe-area-inset-bottom))] dark:bg-dark-7',
        mobileGenerator && footerStripsFrame
      )}
    >
      <FooterStrips>
        {mobileGenerator && statusMessage}
        {/* `data-strip-full`: what stops generating is read in full, not folded to one line. */}
        {takeover === 'unavailable' ? (
          <div data-strip-full>
            <AlertWithIcon
              color="yellow"
              title="Generation Status Alert"
              icon={<IconAlertTriangle size={20} />}
              iconColor="yellow"
            >
              {status.message}
            </AlertWithIcon>
          </div>
        ) : takeover === 'selfHostedBlocked' ? (
          <div data-strip-full>
            <SelfHostedBlockedAlert />
          </div>
        ) : takeover === 'generationTerms' ? (
          <FooterTermsGate
            title="Image Generation Terms"
            tourId="gen:terms"
            confirmLabel="I Confirm, Start Generating"
            onConfirm={() => {
              setReviewed(true);
              if (running) helpers?.next();
            }}
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
          </FooterTermsGate>
        ) : takeover === 'generationLicense' && license.terms ? (
          <FooterTermsGate
            title={license.terms.title}
            confirmLabel="I agree to these terms"
            onConfirm={license.accept}
            loading={license.accepting}
          >
            <div className="flex flex-col gap-2">
              <Text size="xs">{license.terms.intro}</Text>
              <ul className="list-disc pl-5">
                {license.terms.restrictions.map((line) => (
                  <li key={line}>
                    <Text size="xs">{line}</Text>
                  </li>
                ))}
              </ul>
              <Text size="xs">
                Read the{' '}
                <Text
                  component="a"
                  href={license.terms.licenseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  td="underline"
                  inherit
                >
                  {license.terms.licenseName}
                </Text>
                .
              </Text>
            </div>
          </FooterTermsGate>
        ) : takeover === 'membershipUpsell' ? (
          // A choice to make, not a notice: it keeps its full height.
          <div data-strip-full>
            <MembershipUpsell />
          </div>
        ) : (
          dailyBoost.canShow && (
            // A wrapper, so the button is not itself a strip: it keeps its shape and stretches.
            <div className="flex flex-col">
              <DailyBoostRewardClaim />
            </div>
          )
        )}
      </FooterStrips>

      {/* Always keep the slot target in the DOM so portals can resolve it.
          Hidden while a takeover panel owns the footer. */}
      <div className={!showFooterContent ? 'hidden' : undefined}>{children}</div>

      {/* Dismissible status message — shown regardless of review state */}
      {!mobileGenerator && statusMessage}
    </div>
  );
}
