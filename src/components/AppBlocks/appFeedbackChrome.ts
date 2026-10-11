import type {
  AppFeedbackContext,
  AppFeedbackTarget,
  CreateAppFeedbackInput,
} from '~/server/schema/app-feedback.schema';
import {
  APP_FEEDBACK_READERS,
  FEEDBACK_MESSAGE_MAX_LENGTH,
} from '~/shared/constants/feedback.constants';
import { isPageSlot } from '~/shared/constants/slot-registry';
import { sanitizeAppChromeName } from './appChromeName';
import type { BlockHostSurface } from './blockInitFragmentGate';

/**
 * Pure decisions behind the chrome's "Send feedback to developer" entry and modal. They live
 * here, not in the components, so the node `unit` project covers them: the `*.browser.test.tsx`
 * suites do not gate merges.
 */

/** What the chrome tells the server about where the feedback came from. */
export type AppFeedbackRequest = {
  target: AppFeedbackTarget;
  context: AppFeedbackContext;
};

/**
 * The page host threads the listing slug; the model slot has only the AppBlock id. The server
 * resolves either to the listing, so the client never names a listing id.
 */
export function resolveAppFeedbackRequest({
  slug,
  appBlockId,
  slotId,
  modelId,
}: {
  slug?: string;
  appBlockId?: string;
  slotId?: string;
  modelId?: number;
}): AppFeedbackRequest | null {
  const target: AppFeedbackTarget | null = slug ? { slug } : appBlockId ? { appBlockId } : null;
  if (!target) return null;

  // An omitted slotId is a model surface, matching how `AppBlockChrome` treats it.
  const surface = slotId != null && isPageSlot(slotId) ? 'page' : 'slot';
  const context: AppFeedbackContext =
    surface === 'slot' && modelId != null && Number.isInteger(modelId) && modelId > 0
      ? { surface, modelId }
      : { surface };
  return { target, context };
}

/**
 * Which host surfaces offer "Send feedback to developer". The server stamps every report with the
 * listing's PUBLISHED version and sha, so the button belongs only where the published app is what
 * is running:
 *
 * - `dev-tunnel` runs the author's unpublished local code, and its viewer is by construction an
 *   owner or collaborator — exactly the people the server now admits — so a report there would be
 *   filed against a version that never ran.
 * - `review-preview` runs a pending version under moderation, with the same mis-attribution.
 * - `private-run` serves the published code of a delisted or suspended app; the server's own
 *   status check decides whether it may take feedback.
 *
 * A total `Record`, so a new `BlockHostSurface` member is a compile error here until someone
 * decides.
 */
export const APP_FEEDBACK_HOST_SURFACES: Record<BlockHostSurface, boolean> = {
  'model-slot': true,
  'page-run': true,
  'private-run': true,
  'dev-tunnel': false,
  'review-preview': false,
};

/**
 * The request to ask eligibility for, or `null` when the button must not mount at all. Every term
 * only ever hides: a signed-out viewer is refused by the procedure, without store access the
 * server's store scope is `none`, which admits no listing kind, and a host surface that is not in
 * {@link APP_FEEDBACK_HOST_SURFACES} (or was not named) offers no feedback at all.
 */
export function appFeedbackEntryRequest({
  isSignedIn,
  hasStoreAccess,
  hostSurface,
  request,
}: {
  isSignedIn: boolean;
  hasStoreAccess: boolean;
  hostSurface: BlockHostSurface | undefined;
  request: AppFeedbackRequest | null;
}): AppFeedbackRequest | null {
  if (!isSignedIn || !hasStoreAccess) return null;
  if (!hostSurface || !APP_FEEDBACK_HOST_SURFACES[hostSurface]) return null;
  return request;
}

/** The exact `appFeedback.create` input. Text and the server-whitelisted context, nothing else. */
export function buildAppFeedbackCreateInput(
  request: AppFeedbackRequest,
  message: string
): CreateAppFeedbackInput {
  return { target: request.target, message: message.trim(), context: request.context };
}

export function canSubmitAppFeedback(message: string): boolean {
  const length = message.trim().length;
  return length > 0 && length <= FEEDBACK_MESSAGE_MAX_LENGTH;
}

/**
 * The send dialog's privacy notice, after its bold "Private." lead. Names the same readers as the
 * developer's inbox (one shared phrase), collaborators included, since an accepted collaborator
 * reads the inbox too.
 */
export const APP_FEEDBACK_PRIVATE_NOTICE = `Only ${APP_FEEDBACK_READERS} can read this. It won't appear on the app's page. They will see your username.`;

export function appFeedbackModalTitle(appName: string | null | undefined): string {
  const name = sanitizeAppChromeName(appName);
  return name
    ? `Send private feedback to ${name}'s developer`
    : "Send private feedback to this app's developer";
}

/**
 * Must name everything stored about what the user was viewing (app version, model), or the
 * modal's "Nothing else is collected" is false. The stored `surface` (page vs model slot) is left
 * unnamed: it is where the modal itself was opened.
 */
export function appFeedbackSentWithLine(
  appBlockVersion: string | null | undefined,
  context: AppFeedbackContext
): string {
  const version = sanitizeAppChromeName(appBlockVersion);
  const parts = [
    version ? `app version ${version}` : null,
    context.modelId != null ? 'the model you were viewing' : null,
  ].filter((part): part is string => part !== null);
  return parts.length
    ? `Sent with: ${parts.join(' and ')}. Nothing else is collected.`
    : 'Nothing else is collected with your message.';
}

/** The second sentence is held to the server's notified statuses by appFeedbackChrome.test.ts. */
export const APP_FEEDBACK_SENT_MESSAGE =
  "Sent to the developer. You'll get a notification if they mark it resolved or won't fix.";

export const APP_FEEDBACK_NOT_AVAILABLE_MESSAGE =
  "This app isn't accepting feedback from you right now.";
export const APP_FEEDBACK_SIGNED_OUT_MESSAGE = 'Sign in to send feedback.';
export const APP_FEEDBACK_INVALID_MESSAGE =
  'Your feedback could not be sent. Check the message and try again.';
export const APP_FEEDBACK_GENERIC_ERROR_MESSAGE =
  'Something went wrong sending your feedback. Please try again.';

type SubmitError = { message?: string | null; data?: { code?: string | null } | null };

/** A zod refusal arrives as BAD_REQUEST whose message is the JSON-encoded issue list. */
function isJsonMessage(message: string): boolean {
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Server messages for these codes are user-facing, except NOT_FOUND, which deliberately conflates
 * "hidden", "not approved" and "missing" — "App not found" would read wrong, so it gets one
 * neutral sentence.
 */
export function appFeedbackSubmitErrorMessage(error: SubmitError): string {
  const code = error.data?.code;
  const message = error.message?.trim() ?? '';
  switch (code) {
    case 'TOO_MANY_REQUESTS':
    case 'FORBIDDEN':
      return message || APP_FEEDBACK_GENERIC_ERROR_MESSAGE;
    case 'BAD_REQUEST':
      return message && !isJsonMessage(message) ? message : APP_FEEDBACK_INVALID_MESSAGE;
    case 'NOT_FOUND':
      return APP_FEEDBACK_NOT_AVAILABLE_MESSAGE;
    case 'UNAUTHORIZED':
      return APP_FEEDBACK_SIGNED_OUT_MESSAGE;
    default:
      return APP_FEEDBACK_GENERIC_ERROR_MESSAGE;
  }
}
