import { reportOpensCsamHold } from '@civitai/shared/post-text-report';

export type PostTextAction = 'refuse' | 'restore' | 'hold';

/** The storyline text a report in the post queue is about, as it is now. */
export type ReportedPostText = {
  textId: number | null;
  /** Its place among the post's slides (images and texts, in reading order), 1-based. */
  position: number | null;
  slideCount: number | null;
  /** Plain text: render it as text, never as HTML (`htmlToText` on the server). */
  text: string | null;
  /** The words when reported (the report's snapshot), as plain text; null on a report without one. */
  reportedText: string | null;
  refused: boolean;
  refusedByModerator: boolean;
  /** The scan refuses it too, under the moderator's refusal: a restore leaves it hidden. */
  refusedByScan: boolean;
  /** Held for csam review: decided in the CSAM text-hold queue, never from a report. */
  held: boolean;
};

/**
 * Whether a report on a storyline text may take this action: a CSAM or minor-sexualization report
 * goes to the CSAM text-hold queue and is never refused; any other report is refused, never held.
 * Restoring lifts a moderator's refusal whatever the report said.
 */
export const postTextActionAllowed = (
  action: PostTextAction,
  report: { reason: string; details: unknown }
) => action === 'restore' || (action === 'hold') === reportOpensCsamHold(report);
