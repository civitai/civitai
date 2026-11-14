import { error, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import {
  getSystemClient,
  parseSystemClientDetails,
  updateSystemClient,
} from '$lib/server/oauth/system-clients';

// Edit a system app's name, description and redirect URIs. Other apps are edited by their owner on the
// main site; access mode, skip consent and the token limit stay on /admin/access.

export const load: PageServerLoad = async ({ params }) => {
  const client = await getSystemClient(params.id);
  if (!client) error(404, 'System app not found.');
  return { client };
};

export const actions: Actions = {
  default: async ({ params, request, locals }) => {
    const details = parseSystemClientDetails(await request.formData());
    if ('error' in details) return fail(400, { error: details.error });
    const result = await updateSystemClient(params.id, details, locals.user!.id);
    if (!result) return fail(404, { error: 'That system app no longer exists.' });
    if ('refusedRedirectUri' in result) {
      return fail(400, {
        error: `This app skips the consent screen, so every redirect URI must be https and not localhost. Remove ${result.refusedRedirectUri}, or turn off skip consent first.`,
      });
    }
    if ('conflict' in result) {
      return fail(409, {
        error: 'This app changed while you were saving. Reload the page and try again.',
      });
    }
    return { success: true };
  },
};
