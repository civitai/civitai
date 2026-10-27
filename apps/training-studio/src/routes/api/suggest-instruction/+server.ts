import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { helperClient, suggestRequest } from '$lib/server/edit-helpers';
import { submitSuggest, suggestQuote } from '$lib/edit-helpers-core';

export const GET: RequestHandler = async ({ locals }) => {
  const client = await helperClient(locals);
  try {
    return json({ cost: await suggestQuote(client) });
  } catch (err) {
    console.warn('[training-studio] suggest quote failed', err);
    return json({ cost: null });
  }
};

export const POST: RequestHandler = async (event) => {
  const client = await helperClient(event.locals);
  const req = await suggestRequest(event);
  try {
    return json({ workflowId: await submitSuggest(client, req) });
  } catch (err) {
    console.warn('[training-studio] suggest submit failed', err);
    error(502, "Couldn't suggest an instruction. Try again.");
  }
};
