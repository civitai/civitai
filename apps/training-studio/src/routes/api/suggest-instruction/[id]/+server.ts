import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { helperClient } from '$lib/server/edit-helpers';
import { pollSuggest } from '$lib/edit-helpers-core';

// The token scopes to the caller, so only the caller's own runs are readable.
export const GET: RequestHandler = async ({ locals, params }) => {
  const client = await helperClient(locals);
  try {
    return json(await pollSuggest(client, params.id));
  } catch (err) {
    console.warn('[training-studio] suggest poll failed', err);
    error(502, 'Could not read the suggestion.');
  }
};
