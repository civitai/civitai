import * as z from 'zod';
import { caseIntakeInput, createModeratorClient, ModeratorClientError } from '@civitai/moderation';
import type {
  CaseIntakeInput,
  CasePartyActionInput,
  CasePartyViewInput,
} from '@civitai/moderation';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { createTtlMemo } from '~/server/utils/ttl-memoize';

// Filed in the moderator app, which owns the case engine. This client holds only the scoped intake
// credential (MOD_CASES_TOKEN).
const casesClient = createModeratorClient({
  endpoint: env.MODERATOR_APP_INTERNAL_URL || env.MODERATOR_APP_URL,
  token: env.MOD_CASES_TOKEN,
  onFailure: (failure) =>
    logToAxiom({ type: 'error', name: 'takedown-request-failed', ...failure }, 'moderator-app'),
});

export const takedownRequestsConfigured = () => !!env.MOD_CASES_TOKEN;

const fieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['text', 'textarea', 'email', 'url', 'urlList', 'checkbox', 'signature', 'select']),
  required: z.boolean(),
  help: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});
export type RequestField = z.infer<typeof fieldSchema>;

const formSchema = z.object({
  key: z.string(),
  title: z.string(),
  mailbox: z.string().email(),
  fields: z.array(fieldSchema),
});
export type RequestForm = z.infer<typeof formSchema>;

const caseViewSchema = z.object({
  publicRef: z.string(),
  title: z.string(),
  role: z.string(),
  state: z.object({ id: z.string(), label: z.string(), terminal: z.boolean() }),
  receivedAt: z.string(),
  items: z.array(z.object({ url: z.string(), state: z.string() })),
  actions: z.array(z.object({ id: z.string(), label: z.string(), fields: z.array(fieldSchema) })),
});
export type CaseView = z.infer<typeof caseViewSchema>;

/** The moderator app answers every action as `{ ok, result }` (modActionResponse). */
const resultOf = <T extends z.ZodType>(schema: T, answer: unknown): z.infer<T> =>
  schema.parse(z.object({ result: z.unknown() }).parse(answer).result);

// Definitions change only by a hand-applied version, so a minute's staleness costs nothing and keeps
// every form page view from being a cross-app call (single-flight, failures not cached).
export const getRequestForms = createTtlMemo(
  async (): Promise<RequestForm[]> =>
    resultOf(z.object({ definitions: z.array(formSchema) }), await casesClient.caseDefinitions())
      .definitions,
  60_000
);

export type SubmitResult =
  | { ok: true; publicRef: string }
  | { ok: false; fieldErrors?: Record<string, string>; message: string; status?: number };

/**
 * Only a refusal the moderator app worded for the person keeps its message. Anything else, including an
 * ingress 4xx (a bad credential, an action one app doesn't know yet), is "unavailable", so the page
 * offers the mailbox instead of internal text or a false "link expired".
 */
function refusal(e: unknown): Extract<SubmitResult, { ok: false }> {
  if (e instanceof ModeratorClientError && e.isPublic && e.status)
    return { ok: false, message: e.message, fieldErrors: e.fieldErrors, status: e.status };
  return { ok: false, message: 'unavailable', status: 503 };
}

/** Answers past the wire limits, by field, without logging or echoing what they hold. */
function oversized(values: unknown): Record<string, string> | null {
  const parsed = caseIntakeInput.shape.values.safeParse(values);
  if (parsed.success) return null;
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const id = issue.path[0];
    if (typeof id === 'string') errors[id] = 'This answer is too long.';
  }
  return Object.keys(errors).length ? errors : { form: 'Some answers are too long.' };
}

export async function submitRequest(
  input: Omit<CaseIntakeInput, 'values'> & { values: unknown }
): Promise<SubmitResult> {
  const tooLong = oversized(input.values);
  if (tooLong)
    return { ok: false, message: 'Some answers are too long.', fieldErrors: tooLong, status: 400 };
  try {
    const res = resultOf(
      z.object({ publicRef: z.string() }),
      await casesClient.caseIntake(input as CaseIntakeInput)
    );
    return { ok: true, publicRef: res.publicRef };
  } catch (e) {
    return refusal(e);
  }
}

export async function viewCase(input: CasePartyViewInput) {
  try {
    return {
      ok: true as const,
      view: resultOf(caseViewSchema, await casesClient.casePartyView(input)),
    };
  } catch (e) {
    return refusal(e);
  }
}

export async function actOnCase(input: CasePartyActionInput) {
  try {
    await casesClient.casePartyAction(input);
    return { ok: true as const };
  } catch (e) {
    return refusal(e);
  }
}
