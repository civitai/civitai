import type { FieldValues } from 'react-hook-form';
import { useGenerationContextStore } from '~/components/ImageGeneration/GenerationProvider';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import type { FormProps } from '~/libs/form';
import { Form } from '~/libs/form';
import { useGenerationGraphStore } from '~/store/generation-graph.store';
import { showWarningNotification } from '~/utils/notifications';

type GenFormProps<TInput extends FieldValues, TOutput extends FieldValues> = FormProps<
  TInput,
  TOutput
> & {
  /**
   * Opt in to the rate-limited Generator_Submit telemetry emit. Default false.
   *
   * GenForm wraps two distinct call-site shapes:
   *   1. GenerationForm2 (legacy) + VideoGenerationForm — full funnel
   *      participants with success / validation-fail emits in their own
   *      handleSubmit / handleSubmitError. They MUST opt in (track) so the
   *      rate-limited stage is symmetric with the rest of their funnel.
   *   2. Orchestrator modals (UpscaleImage, UpscaleVideo, BackgroundRemoval,
   *      VideoInterpolation) — these have NO Generator_Submit instrumentation
   *      of their own. Emitting only the rate-limited branch from here would
   *      produce asymmetric data (only-blocked clicks visible, success +
   *      validation-fail invisible) AND leak whatever lastEntryAction was
   *      sitting on the panel store onto an upscale click. They stay opted
   *      out until a follow-up PR instruments the orchestrator funnel as a
   *      whole.
   */
  track?: boolean;
};

export function GenForm<
  TInput extends FieldValues = FieldValues,
  TOutput extends FieldValues = FieldValues
>({ children, onSubmit, track = false, ...props }: GenFormProps<TInput, TOutput>) {
  const generationContextStore = useGenerationContextStore();
  const { trackAction } = useTrackEvent();

  return (
    <Form
      {...props}
      onSubmit={(payload) => {
        const snapshot = generationContextStore.getState();
        if (!snapshot.canGenerate) {
          // Generation funnel telemetry — rate-limited branch. The outer
          // handleSubmit in the form component never runs when canGenerate
          // is false (we short-circuit below), so emit Generator_Submit
          // here so the data team still sees these capacity-bounded clicks
          // as a distinct funnel stage. fromAction comes from the panel
          // store, same source as the happy-path event.
          //
          // formVersion is intentionally omitted: GenForm wraps both
          // GenerationForm2 (legacy) and VideoGenerationForm (video) — no
          // way to discriminate from this layer without a prop drill. The
          // `isRateLimited: true` flag is the discriminator; the data team
          // can filter on it directly.
          //
          // Gated on `track` so the orchestrator-modal call sites (which
          // have no other funnel instrumentation) don't emit asymmetric
          // rate-limited-only events. See GenFormProps.track docs above.
          if (track) {
            try {
              const fromAction = useGenerationGraphStore.getState().lastEntryAction;
              trackAction({
                type: 'Generator_Submit',
                details: {
                  fromAction,
                  isValid: false,
                  isRateLimited: true,
                },
              }).catch(() => undefined);
            } catch {
              // Telemetry must never block UI.
            }
          }

          showWarningNotification({
            message:
              snapshot.requestsRemaining === 0
                ? `You are already generating at your limit: ${snapshot.queued.length}`
                : 'Request queued. Your generation request will begin shortly.',
          });
          return;
        }

        onSubmit?.(payload);
      }}
    >
      {children}
    </Form>
  );
}
