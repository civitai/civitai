import { error } from '@sveltejs/kit';
import type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/autolabel-core';
import { AUTO_LABEL_UNAVAILABLE_CODE } from '$lib/autolabel-errors';
import type { Media } from '$lib/data/trainingModels';
import { logToAxiom } from './axiom';
import { mainAppSessionOrigin } from './main-app';

// Auto-label is free to the user, so it runs on the main app's system-paid path (the one the embed's
// host uses), called as this user with their forwarded session cookie: nothing is submitted with the
// user's own orchestrator token, which would charge them.

const TIMEOUT_MS = 15_000;
const UNAVAILABLE = 'Auto-labeling is unavailable right now.';

type Body = { message?: unknown; error?: unknown } & Record<string, unknown>;

async function callMainApp(
  cookie: string,
  init: { method: 'GET' | 'POST'; path: string; body?: unknown }
) {
  const res = await fetch(`${mainAppSessionOrigin()}/api/training-studio/auto-label${init.path}`, {
    method: init.method,
    headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as Body | null;
  return { status: res.status, ok: res.ok, body };
}

const reasonOf = (body: Body | null) =>
  typeof body?.message === 'string'
    ? body.message
    : typeof body?.error === 'string'
    ? body.error
    : undefined;

function fail(op: string, userId: number, status: number | undefined, detail?: string): never {
  logToAxiom({
    name: 'training-studio-auto-label',
    type: 'error',
    op,
    userId,
    status,
    message: detail,
  });
  error(
    502,
    op === 'submit'
      ? 'Could not start auto-labeling. Try again.'
      : 'Could not read auto-label progress.'
  );
}

/**
 * Submit one batch. A 4xx from the main app is a refusal made before any workflow existed and keeps
 * its status and reason; a 404 (the endpoint not live yet) and a missing session answer as our own
 * marked 503. Anything else is a 502, which the client keeps counted.
 */
export async function mainAppAutoLabelSubmit(
  cookie: string | null,
  userId: number,
  input: { items: AutoLabelItem[]; mode: AutoLabelMode; media: Media }
): Promise<{ workflowId: string }> {
  if (cookie === null) error(503, { message: UNAVAILABLE, code: AUTO_LABEL_UNAVAILABLE_CODE });
  let answer: Awaited<ReturnType<typeof callMainApp>>;
  try {
    answer = await callMainApp(cookie, { method: 'POST', path: '', body: input });
  } catch (err) {
    fail('submit', userId, undefined, (err as Error)?.message);
  }
  const { status, ok, body } = answer;
  if (ok && typeof body?.workflowId === 'string') return { workflowId: body.workflowId };
  if (status === 404) error(503, { message: UNAVAILABLE, code: AUTO_LABEL_UNAVAILABLE_CODE });
  if (status >= 400 && status < 500) error(status, reasonOf(body) ?? UNAVAILABLE);
  fail('submit', userId, status, reasonOf(body));
}

/** Poll one workflow. Another user's workflow answers 404 from the main app, passed through. A poll
 *  has no cap slot to return, so the 503 carries no code. */
export async function mainAppAutoLabelPoll(
  cookie: string | null,
  userId: number,
  workflowId: string
): Promise<{ done: boolean; results: AutoLabelResult[] }> {
  if (cookie === null) error(503, UNAVAILABLE);
  let answer: Awaited<ReturnType<typeof callMainApp>>;
  try {
    answer = await callMainApp(cookie, {
      method: 'GET',
      path: `?workflowId=${encodeURIComponent(workflowId)}`,
    });
  } catch (err) {
    fail('poll', userId, undefined, (err as Error)?.message);
  }
  const { status, ok, body } = answer;
  if (ok && typeof body?.done === 'boolean' && Array.isArray(body.results))
    return { done: body.done, results: body.results as AutoLabelResult[] };
  if (status >= 400 && status < 500)
    error(status, reasonOf(body) ?? 'Could not read auto-label progress.');
  fail('poll', userId, status, reasonOf(body));
}
