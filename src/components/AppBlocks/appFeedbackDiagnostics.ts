import type { AppFeedbackRecentError } from '~/server/schema/app-feedback.schema';
import {
  APP_FEEDBACK_ERROR_MESSAGE_MAX,
  APP_FEEDBACK_RECENT_ERRORS_MAX,
} from '~/server/schema/app-feedback.schema';

/**
 * The diagnostics a feedback report carries about the running APP (never about civitai.com):
 * the replies the host sent it that reported a failure. Pure, so the node `unit` project covers
 * them; `usePostMessage` keeps the buffer.
 */

/** Older failures are dropped: they describe an earlier stretch of the session, not this report. */
export const APP_FEEDBACK_RECENT_ERRORS_MAX_AGE_MS = 30 * 60 * 1000;

const BRIDGE_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** `failureSnapshot`'s placeholder id for a workflow that never got one. */
const NO_WORKFLOW_ID = 'failed';
const FALLBACK_MESSAGE = 'request failed';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

export function clampErrorText(text: string): string {
  const flat = text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= APP_FEEDBACK_ERROR_MESSAGE_MAX) return flat;
  return `${flat.slice(0, APP_FEEDBACK_ERROR_MESSAGE_MAX - 1)}…`;
}

function opaqueId(value: unknown, max = 128): string | undefined {
  return typeof value === 'string' && value.length <= max && OPAQUE_ID.test(value)
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The failure a host→app message reports, or `null` when it reports none. The reply shapes are the
 * bridge's own: a workflow snapshot with `status: 'failed'`, an `ok: false` refusal, or a bare
 * `error`. Reads only those fields — never `token`, `value`, `snapshot.output` or anything else the
 * payload carries.
 */
export function failureFromHostMessage(
  type: string,
  payload: unknown,
  at: number
): AppFeedbackRecentError | null {
  if (!BRIDGE_TYPE.test(type)) return null;
  const body = asRecord(payload);
  if (!body) return null;

  let message: unknown;
  let workflowId: string | undefined;
  let code = opaqueId(body.code, 64);
  const snapshot = asRecord(body.snapshot);
  const error = asRecord(body.error);
  if (snapshot?.status === 'failed') {
    message = snapshot.error;
    const id = opaqueId(snapshot.workflowId);
    workflowId = id === NO_WORKFLOW_ID ? undefined : id;
  } else if (typeof body.error === 'string' && body.error.length > 0) {
    message = body.error;
  } else if (error) {
    message = error.message;
    code ??= opaqueId(error.code, 64);
  } else if (body.ok === false) {
    message = undefined;
  } else {
    return null;
  }

  const text = typeof message === 'string' ? clampErrorText(message) : '';
  return {
    method: type,
    message: text || FALLBACK_MESSAGE,
    ...(code ? { code } : {}),
    ...(workflowId ? { workflowId } : {}),
    at,
    count: 1,
  };
}

const ENUM_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type AppFeedbackRequestHint = {
  /** The app's request type, e.g. `SUBMIT_WORKFLOW`, named in place of the reply's. */
  method: string;
  input?: NonNullable<AppFeedbackRecentError['input']>;
};

/**
 * What a failure entry may say about the app's request: its type, and from a workflow `body` only
 * the `kind` / `step` enum keys and the checkpoint `modelVersionId`. Prompts, params, images and
 * every other field are never read.
 */
export function requestHintFromBlockMessage(
  type: string,
  payload: unknown
): AppFeedbackRequestHint | null {
  if (!BRIDGE_TYPE.test(type)) return null;
  const body = asRecord(asRecord(payload)?.body);
  if (!body) return { method: type };
  const enumKey = (value: unknown) =>
    typeof value === 'string' && ENUM_KEY.test(value) ? value : undefined;
  const kind = enumKey(body.kind);
  const step = enumKey(body.step);
  const modelVersionId =
    typeof body.modelVersionId === 'number' &&
    Number.isSafeInteger(body.modelVersionId) &&
    body.modelVersionId > 0
      ? body.modelVersionId
      : undefined;
  const input = {
    ...(kind ? { kind } : {}),
    ...(step ? { step } : {}),
    ...(modelVersionId ? { modelVersionId } : {}),
  };
  return Object.keys(input).length ? { method: type, input } : { method: type };
}

/** The failure, named after the request it answered when the bridge saw that request. */
export function withRequestHint(
  failure: AppFeedbackRecentError,
  hint: AppFeedbackRequestHint | undefined
): AppFeedbackRecentError {
  if (!hint) return failure;
  return { ...failure, method: hint.method, ...(hint.input ? { input: hint.input } : {}) };
}

const sameFailure = (a: AppFeedbackRecentError, b: AppFeedbackRecentError) =>
  a.method === b.method &&
  a.message === b.message &&
  a.code === b.code &&
  a.workflowId === b.workflowId &&
  JSON.stringify(a.input ?? null) === JSON.stringify(b.input ?? null);

/**
 * Append a failure, newest last. A repeat of the newest entry (a poll failing the same way each
 * time) bumps its count instead of evicting older, different failures.
 */
export function pushRecentError(
  list: readonly AppFeedbackRecentError[],
  entry: AppFeedbackRecentError
): AppFeedbackRecentError[] {
  const last = list[list.length - 1];
  if (last && sameFailure(last, entry))
    return [...list.slice(0, -1), { ...entry, count: Math.min(last.count + 1, 10_000) }];
  return [...list, entry].slice(-APP_FEEDBACK_RECENT_ERRORS_MAX);
}

/** The entries still inside the time box at `now`. */
export function recentErrorsAt(
  list: readonly AppFeedbackRecentError[],
  now: number
): AppFeedbackRecentError[] {
  return list.filter((e) => now - e.at <= APP_FEEDBACK_RECENT_ERRORS_MAX_AGE_MS);
}
