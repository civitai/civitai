import * as z from 'zod';
import { createModeratorClient, ModeratorClientError } from '@civitai/moderation';
import type {
  CaseIntakeInput,
  CasePartyActionInput,
  CasePartyViewInput,
} from '@civitai/moderation';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

// The public takedown forms are filed in the moderator app, which owns the case engine. This client holds
// only the scoped intake credential, which the moderator app accepts for these four actions and no other.
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

const formSchema = z.object({ key: z.string(), title: z.string(), fields: z.array(fieldSchema) });
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

export async function getRequestForms(): Promise<RequestForm[]> {
  const res = z
    .object({ definitions: z.array(formSchema) })
    .parse(await casesClient.caseDefinitions());
  return res.definitions;
}

export type SubmitResult =
  | { ok: true; publicRef: string }
  | { ok: false; fieldErrors?: Record<string, string>; message: string; status?: number };

/** A refusal the person can act on keeps its message; anything else is the moderator app's fault. */
function refusal(e: unknown): Extract<SubmitResult, { ok: false }> {
  if (e instanceof ModeratorClientError && e.status && e.status >= 400 && e.status < 500)
    return { ok: false, message: e.message, fieldErrors: e.fieldErrors, status: e.status };
  return { ok: false, message: 'unavailable', status: 503 };
}

export async function submitRequest(input: CaseIntakeInput): Promise<SubmitResult> {
  try {
    const res = z.object({ publicRef: z.string() }).parse(await casesClient.caseIntake(input));
    return { ok: true, publicRef: res.publicRef };
  } catch (e) {
    return refusal(e);
  }
}

export async function viewCase(input: CasePartyViewInput) {
  try {
    return {
      ok: true as const,
      view: caseViewSchema.parse(await casesClient.casePartyView(input)),
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
