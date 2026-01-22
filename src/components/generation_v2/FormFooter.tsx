/**
 * FormFooter
 *
 * Footer component for the generation form with quantity input,
 * submit button, reset button, and queue snackbar.
 * Includes alerts for terms agreement, generation status, and errors.
 */

import { Alert, Button, Card, Notification, NumberInput, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconAlertTriangle, IconCheck, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import { MembershipUpsell } from '~/components/ImageGeneration/MembershipUpsell';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Controller, useGraph } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import { hashify } from '~/utils/string-helpers';
import { useWhatIfFromGraph } from './hooks/useWhatIfFromGraph';

// =============================================================================
// SubmitButton Component
// =============================================================================

interface SubmitButtonProps {
  isLoading?: boolean;
}

function SubmitButton({ isLoading }: SubmitButtonProps) {
  const features = useFeatureFlags();
  const { running, helpers } = useTourContext();

  // Get whatIf data for cost estimation (only fetches when graph is valid)
  const { data, isError, isInitialLoading, isValid } = useWhatIfFromGraph({
    enabled: features.creatorComp,
  });

  const generateButton = (
    <GenerateButton
      type="submit"
      data-tour="gen:submit"
      className="h-full flex-1 px-2"
      loading={isInitialLoading || isLoading}
      cost={data?.cost?.total ?? 0}
      disabled={isError || !isValid}
      onClick={() => {
        if (running) helpers?.next();
      }}
      transactions={data?.transactions}
      allowMatureContent={data?.allowMatureContent}
    />
  );

  if (!features.creatorComp) return generateButton;

  return (
    <div className="flex flex-1 items-center gap-1 rounded-md bg-gray-2 p-1 pr-1.5 dark:bg-dark-5">
      {generateButton}
      <GenerationCostPopover width={300} workflowCost={data?.cost ?? {}} />
    </div>
  );
}

// =============================================================================
// FormFooter Component
// =============================================================================

export function FormFooter() {
  const graph = useGraph<GenerationGraphTypes>();
  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const { running, helpers } = useTourContext();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [reviewed, setReviewed] = useLocalStorage({
    key: 'review-generation-terms',
    defaultValue: window?.localStorage?.getItem('review-generation-terms') === 'true',
  });

  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : null),
    [status.message]
  );

  const clearWarning = () => setPromptWarning(null);

  const handleSubmit = async () => {
    console.log({ snapshot: graph.getSnapshot() });
    const result = graph.validate();

    if (!result.success) {
      console.log('Validation failed:', result.errors);
      return;
    }

    setIsSubmitting(true);
    setSubmitError(undefined);
    setPromptWarning(null);

    try {
      // Filter out computed nodes (they're derived, not input)
      const inputData = Object.fromEntries(
        Object.entries(result.data).filter(([k]) => result.nodes[k]?.kind !== 'computed')
      );

      console.log('Submitting:', inputData);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // TODO: Replace with actual submission logic
      // await mutateAsync({ resources, params, tips, remixOfId })
      //   .catch((error) => {
      //     if (error.message?.startsWith('Your prompt was flagged') || error.message?.includes('POI')) {
      //       setPromptWarning(error.message);
      //       currentUser?.refresh();
      //     } else {
      //       setSubmitError(error.message ?? 'An unexpected error occurred. Please try again later.');
      //     }
      //   });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'An unexpected error occurred';
      setSubmitError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    // Don't exclude 'model' - it should be reset to match the baseModel
    // The checkpointNode factory will select a default model for the baseModel
    graph.reset({ exclude: ['workflow', 'baseModel'] });
    clearWarning();
    setSubmitError(undefined);
  };

  // Render prohibited prompt warning
  if (promptWarning) {
    return (
      <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
        <Alert color="red" title="Prohibited Prompt">
          <Text className="whitespace-pre-wrap">{promptWarning}</Text>
          <Button
            color="red"
            variant="light"
            onClick={clearWarning}
            style={{ marginTop: 10 }}
            leftSection={<IconCheck />}
            fullWidth
          >
            I Understand, Continue Generating
          </Button>
        </Alert>
        {currentUser?.username && (
          <Text size="xs" c="dimmed" mt={4}>
            Is this a mistake?{' '}
            <Text
              component="a"
              td="underline"
              href={`https://forms.clickup.com/8459928/f/825mr-9671/KRFFR2BFKJCROV3B8Q?Civitai Username=${currentUser.username}`}
              target="_blank"
            >
              Submit your prompt for review
            </Text>{' '}
            so we can refine our system.
          </Text>
        )}
      </div>
    );
  }

  // Render generation unavailable alert
  if (!status.available) {
    return (
      <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
        <AlertWithIcon
          color="yellow"
          title="Generation Status Alert"
          icon={<IconAlertTriangle size={20} />}
          iconColor="yellow"
        >
          {status.message}
        </AlertWithIcon>
      </div>
    );
  }

  return (
    <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
      {/* Daily Boost and Membership Upsell */}
      <DailyBoostRewardClaim />
      <MembershipUpsell />

      {/* Terms Agreement Alert */}
      {!reviewed && (
        <Alert color="yellow" title="Image Generation Terms" data-tour="gen:terms">
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
      )}

      {/* Main form footer - only show when terms are reviewed */}
      {reviewed && (
        <>
          {/* Submit Error Notification */}
          {submitError ? (
            <Notification
              icon={<IconX size={18} />}
              color="red"
              onClose={() => setSubmitError(undefined)}
              className="whitespace-pre-wrap rounded-md bg-red-8/20"
            >
              {submitError}
            </Notification>
          ) : (
            <QueueSnackbar />
          )}

          {/* Quantity Input, Submit Button, Reset Button */}
          <div className="flex gap-2">
            <Controller
              graph={graph}
              name="quantity"
              render={({ value, meta, onChange }) => (
                <Card withBorder className="flex max-w-[88px] flex-col p-0">
                  <Text className="pr-6 text-center text-xs font-semibold" c="dimmed">
                    Quantity
                  </Text>
                  <NumberInput
                    value={value ?? 1}
                    onChange={(val) => onChange(Number(val) || 1)}
                    min={meta.min}
                    max={meta.max}
                    step={meta.step}
                    size="md"
                    variant="unstyled"
                    styles={{
                      input: {
                        textAlign: 'center',
                        fontWeight: 700,
                        fontSize: 20,
                        padding: 0,
                      },
                    }}
                  />
                </Card>
              )}
            />
            <SubmitButton isLoading={isSubmitting} />
            <Button onClick={handleReset} variant="default" className="h-auto px-3">
              Reset
            </Button>
          </div>
        </>
      )}

      {/* Dismissible Status Message */}
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
