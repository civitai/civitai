/**
 * App Store Listings — the MOD "message this app's owner" COMPOSER view model (pure,
 * React-free).
 *
 * Extracted from `MessageAppOwnerModal` for the same reason
 * `appListingModerationTableView` was extracted from the mgmt table: the browser-mode
 * suites are REPORT-ONLY in this repo's CI, so a correctness gate that lives only in a
 * `.browser.test.tsx` blocks nothing. The submit gate on a moderator-authored message —
 * the thing that decides whether a half-typed message can be sent to a developer — is
 * pinned in the blocking node `unit` project instead.
 *
 * 🔴 EVERY BOUND HERE IS IMPORTED FROM THE SERVER SCHEMA, NEVER RETYPED. The floors and
 * ceilings are `messageAppOwnerSchema`'s, and zod re-checks them (as does
 * `validateMessageText` in the service, deliberately independent of the schema). A
 * hand-typed copy that drifted would either offer a moderator a field they can fill and
 * can never send, or gate a message the server would have accepted. Pinned by
 * `appModeratorMessageForm.callSites.test.ts`.
 */

import {
  MOD_MESSAGE_BODY_MAX,
  MOD_MESSAGE_BODY_MIN,
  MOD_MESSAGE_SUBJECT_MAX,
  MOD_MESSAGE_SUBJECT_MIN,
} from '~/server/schema/blocks/app-moderator-message.schema';

/** One field's live state: what the counter renders and whether it clears its bounds. */
export type ModMessageFieldState = {
  /** TRIMMED length — the server trims before it validates, so the UI must too. */
  length: number;
  min: number;
  max: number;
  tooShort: boolean;
  tooLong: boolean;
  /** Within `[min, max]` after trimming. */
  ok: boolean;
};

function fieldState(value: string, min: number, max: number): ModMessageFieldState {
  // 🔴 TRIMMED, because `messageAppOwner` trims BEFORE it validates
  // (`app-moderator-message.service.ts`). An untrimmed client check would let a body of
  // 25 spaces open the gate, fire the mutation, and come back INVALID_TEXT → a
  // BAD_REQUEST toast on a field the moderator was just told was long enough.
  const length = value.trim().length;
  const tooShort = length < min;
  const tooLong = length > max;
  return { length, min, max, tooShort, tooLong, ok: !tooShort && !tooLong };
}

export function modMessageSubjectState(subject: string): ModMessageFieldState {
  return fieldState(subject, MOD_MESSAGE_SUBJECT_MIN, MOD_MESSAGE_SUBJECT_MAX);
}

export function modMessageBodyState(body: string): ModMessageFieldState {
  return fieldState(body, MOD_MESSAGE_BODY_MIN, MOD_MESSAGE_BODY_MAX);
}

/**
 * Which gate is closed, if any. Ordered so the hint names the field a moderator is
 * most likely looking at: the SUBJECT is the first input in the modal, so a closed
 * subject gate is reported before a closed body gate.
 */
export type ModMessageGateBlocker =
  | 'subject-too-short'
  | 'subject-too-long'
  | 'body-too-short'
  | 'body-too-long';

export type ModMessageGate = {
  /** True only when BOTH fields clear BOTH of their bounds. */
  open: boolean;
  /** `null` iff `open`. */
  blockedBy: ModMessageGateBlocker | null;
  /** Hover copy for the disabled submit. `undefined` iff `open`. */
  tooltip: string | undefined;
};

/**
 * The submit gate for the composer.
 *
 * 🔴 The CEILINGS are gated, not only the floors, and that asymmetry was the whole
 * reason to write this as a function. `ReasonGatedField` — the shared atom every other
 * moderator action uses — enforces a MINIMUM only, because every other moderator
 * free-text field is a `reason` with no server ceiling worth surfacing. This one has
 * two ceilings (200 / 2000) that zod rejects. Gating on the floor alone would let a
 * moderator paste a long message into an enabled button and lose it to a `BAD_REQUEST`
 * toast, with the text still in the box but no indication of which field was too long.
 */
export function modMessageGate(input: { subject: string; body: string }): ModMessageGate {
  const subject = modMessageSubjectState(input.subject);
  const body = modMessageBodyState(input.body);

  const blockedBy: ModMessageGateBlocker | null = subject.tooShort
    ? 'subject-too-short'
    : subject.tooLong
    ? 'subject-too-long'
    : body.tooShort
    ? 'body-too-short'
    : body.tooLong
    ? 'body-too-long'
    : null;

  if (blockedBy === null) return { open: true, blockedBy: null, tooltip: undefined };
  return { open: false, blockedBy, tooltip: MOD_MESSAGE_GATE_TOOLTIPS[blockedBy] };
}

const MOD_MESSAGE_GATE_TOOLTIPS: Record<ModMessageGateBlocker, string> = {
  'subject-too-short': `Enter a subject — at least ${MOD_MESSAGE_SUBJECT_MIN} characters.`,
  'subject-too-long': `Shorten the subject to ${MOD_MESSAGE_SUBJECT_MAX} characters or fewer.`,
  'body-too-short': `Enter a message — at least ${MOD_MESSAGE_BODY_MIN} characters.`,
  'body-too-long': `Shorten the message to ${MOD_MESSAGE_BODY_MAX} characters or fewer.`,
};

/**
 * The exact payload the mutation is called with.
 *
 * 🔴 TRIMMED HERE TOO. The service trims and then audits the TRIMMED text, so sending
 * the raw value would record something different from what the moderator sees echoed
 * back in the notification. There is no `appListingId` normalisation to do — the proc
 * accepts a shadow revision id and resolves it to the parent itself.
 *
 * 🔴 `includeCollaborators` is sent ONLY when true. The schema's default is
 * `undefined`→falsey and the field's docstring makes the false case the deliberate
 * one; sending an explicit `false` is equivalent but makes the audit row's
 * `after.includeCollaborators` read as an active choice on every single message.
 */
export function modMessagePayload(input: {
  appListingId: string;
  subject: string;
  body: string;
  includeCollaborators: boolean;
}): {
  appListingId: string;
  subject: string;
  body: string;
  includeCollaborators?: boolean;
} {
  return {
    appListingId: input.appListingId,
    subject: input.subject.trim(),
    body: input.body.trim(),
    ...(input.includeCollaborators ? { includeCollaborators: true } : {}),
  };
}

/**
 * Success-toast copy. Reads the proc's `recipientCount` rather than asserting "sent to
 * the owner": with `includeCollaborators` on, the real recipient set is the owner PLUS
 * the accepted collaborators, and the moderator should be told how many people just
 * received a message they may have intended for one person.
 */
export function modMessageSentSummary(recipientCount: number): string {
  return recipientCount === 1
    ? 'Message sent to the app owner.'
    : `Message sent to ${recipientCount} recipients.`;
}
