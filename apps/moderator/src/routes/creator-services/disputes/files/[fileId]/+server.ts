import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDealFileUrl } from '$lib/server/creator-services-disputes.service';
import { int4Id } from '$lib/server/query';

// Asks the main app for a signed link as the acting moderator, then sends the browser there, so no
// main-app session has to reach the browser from this host. Page access is the central gate.
export const GET: RequestHandler = async ({ params }) => {
  const fileId = int4Id.safeParse(params.fileId);
  if (!fileId.success) error(400, 'Invalid file id.');

  const link = await getDealFileUrl(fileId.data);
  if (!link.ok) error(link.status, link.error);
  redirect(302, link.url);
};
