import { useEffect } from 'react';

import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { nextTourSteps } from '~/components/Tours/tour-step-updates';
import {
  contentGenerationTour,
  remixContentGenerationTour,
} from '~/components/Tours/tours/content-gen.tour';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useGenerationGraphStore } from '~/store/generation-graph.store';
import { useRemixStore } from '~/store/remix.store';

/**
 * Starts and shapes the content-generation tour. Called by whichever generation
 * form is mounted — it reads no form state, only generator readiness, so both
 * lanes share one implementation rather than one lane silently having no tour.
 */
export function useGenerationTour() {
  const currentUser = useCurrentUser();
  const { runTour, running, paused, currentStep, steps, setSteps, activeTour } = useTourContext();
  const status = useGenerationStatus();
  const loadingGeneratorData = useGenerationGraphStore((state) => state.loading);
  const remixOfId = useRemixStore((state) => state.data?.remixOfId);
  const [loadingGenQueueRequests, hasGeneratedImages] = useGenerationContext((state) => [
    state.requestsLoading,
    state.hasGeneratedImages,
  ]);

  useEffect(() => {
    if (!status.available || status.isLoading || loadingGeneratorData) return;
    // `paused` is a tour mid-step, waiting on its own `onNext` hook — and picking a remix
    // option moves `remixOfId` inside exactly that window. Reading only `running` there
    // re-entered `runTour({ key })`, which reinstates the UNFILTERED step array under a
    // step index meant for the filtered one.
    if (!running && !paused)
      runTour({ key: remixOfId ? 'remix-content-generation' : 'content-generation' });
  }, [
    status.isLoading,
    status.available,
    loadingGenQueueRequests,
    hasGeneratedImages,
    remixOfId,
    loadingGeneratorData,
    paused,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const through = (steps: typeof contentGenerationTour, target: string) => {
      const end = steps.findIndex((step) => step.target === `[data-tour="${target}"]`);
      return end === -1 ? steps : steps.slice(0, end + 1);
    };

    if (!running || loadingGeneratorData) return;
    const isRemix = remixOfId && activeTour === 'remix-content-generation';
    let genSteps = isRemix ? remixContentGenerationTour : contentGenerationTour;

    // Both cuts name the step they end on. As positional indexes they silently
    // re-aimed at whatever moved into the slot — inserting the remix-menu step
    // pushed `gen:submit` out of the signed-out tour, and nothing failed.
    if (!loadingGenQueueRequests && !hasGeneratedImages) genSteps = through(genSteps, 'gen:feed');
    if (!currentUser) genSteps = through(genSteps, 'gen:submit');

    const alreadyReviewedTerms =
      window?.localStorage?.getItem('review-generation-terms') === 'true';
    if (alreadyReviewedTerms)
      genSteps = genSteps.filter((x) => x.target !== '[data-tour="gen:terms"]');

    // Recomputed on every input change, not only at step 0: `hasGeneratedImages` flips the
    // moment the user generates — which this tour asks them to do — and freezing the array
    // there left a first-timer's tour permanently cut at `gen:feed`, without the select and
    // post steps that hand over to the post-generation tour.
    const next = nextTourSteps(steps, genSteps, currentStep);
    if (next) setSteps(next);
  }, [
    loadingGenQueueRequests,
    hasGeneratedImages,
    remixOfId,
    currentUser,
    running,
    activeTour,
    loadingGeneratorData,
    currentStep,
  ]); // eslint-disable-line react-hooks/exhaustive-deps
}
