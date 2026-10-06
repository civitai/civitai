import { Text } from '@mantine/core';
import type { ResolutionNote } from 'form-graph';

/**
 * "We changed this for you" — rendered under a control whose value the resolver corrected.
 *
 * The generation defs correct an out-of-contract value rather than refusing it, because a
 * refusal blocks the submit over a value the user usually did not choose (a remix carries the
 * source's resolution, prompt length, image count). That correction was SILENT: `Controller`
 * has handed every control a `note` since the port — "Set when `correct` replaced this value
 * this pass — render 'we adjusted this' inline" — and no call site read it.
 *
 * Silence is fine where the user never picked the value. It is not fine where the field reads
 * as a deliberate choice and the generation is billed against it: moving someone from 4k to 1k,
 * or clamping a video duration, changes what they get and what they pay without a word. Those
 * controls render this; the rest stay quiet on purpose.
 *
 * 🔴 WHICH FIELDS CAN ACTUALLY SHOW ONE. A note exists only where a hook corrected a value, so
 * the field has to RECEIVE an out-of-contract value in the first place. A family-scoped field
 * (`resolution@Ming`) never receives one by switching ecosystems — the target reads its own
 * bucket and takes its default — so its note appears on ingestion alone: remix, replay, preset,
 * or a value typed into the control. A bare-keyed field like `seed` carries everywhere and so
 * notes on every path. Adding a message for a scoped field and testing it by switching families
 * will look broken when it is not.
 */

/**
 * One line per reason a generation def emits. Phrased from the user's side — what changed and
 * why — not in the reason's own vocabulary.
 *
 * A reason with no entry renders nothing rather than leaking a slug into the UI. That is the
 * right default for the dozen-odd reasons on fields that correct silently by design, so this
 * is the opt-in list, not a lookup table that has to stay exhaustive.
 *
 * 🔴 The join to the defs is by STRING and nothing type-checks it. Rename a reason and the
 * control goes back to correcting in silence, which is the failure this exists to end and the
 * direction nobody notices. `__tests__/field-correction-note.test.ts` pins every kind here to
 * a def that emits it.
 */
const MESSAGES: Record<string, (detail: Record<string, unknown>) => string> = {
  option_unavailable: (d) => `${fmt(d.from)} isn't available here — using ${fmt(d.to)}.`,
  out_of_range: (d) => `Adjusted to ${fmt(d.to)}, the closest value this model allows.`,
  duration_range: (d) => `Adjusted to ${fmt(d.to)}s, the closest length this model allows.`,
  quantity_out_of_range: (d) => `Adjusted to ${fmt(d.to)} — the most you can queue here.`,
  seed_unreproducible: () =>
    'Seed cleared: it was outside the range this generator can reproduce, so a random one is used.',
};

export const CORRECTION_MESSAGE_KINDS = Object.keys(MESSAGES);

function fmt(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'none';
  return String(value);
}

/** The rendered sentence for a note, or undefined when this kind is corrected silently. */
export function correctionMessage(note: ResolutionNote | undefined): string | undefined {
  if (!note) return undefined;
  return MESSAGES[note.kind]?.(note.detail ?? {});
}

export function FieldCorrectionNote({ note }: { note: ResolutionNote | undefined }) {
  const message = correctionMessage(note);
  if (!message) return null;

  return (
    <Text size="xs" c="yellow" role="status">
      {message}
    </Text>
  );
}
