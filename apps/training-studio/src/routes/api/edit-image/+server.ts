import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { editImageRequest, helperClient } from '$lib/server/edit-helpers';
import { editImageQuote, submitEditImage } from '$lib/edit-helpers-core';

export const GET: RequestHandler = async ({ locals }) => {
  const client = await helperClient(locals);
  try {
    return json({ cost: await editImageQuote(client) });
  } catch (err) {
    console.warn('[training-studio] edit image quote failed', err);
    return json({ cost: null });
  }
};

export const POST: RequestHandler = async (event) => {
  const client = await helperClient(event.locals);
  const req = await editImageRequest(event);
  try {
    return json({ workflowId: await submitEditImage(client, req) });
  } catch (err) {
    console.warn('[training-studio] edit image submit failed', err);
    error(502, "Couldn't create the image. Try again.");
  }
};
