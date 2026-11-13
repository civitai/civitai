import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { canSeeAddresses, requiresGrant } from '$lib/server/access';
import { redactAddresses } from '$lib/server/redact-addresses';
import {
  addPlaybookVersion,
  getPlaybookHistory,
  listPlaybooks,
  listUnservedPlaybooks,
} from '$lib/server/assistant/store';
import { moderatorDbStatus } from '$lib/moderator-db-status';
import { assistantStoreMessage } from '../store-status';
import { firstIssue, playbookDraftSchema, playbookSlugSchema } from './playbook-form';

export const load: PageServerLoad = async ({ locals }) => {
  const text = canSeeAddresses(locals) ? (t: string) => t : redactAddresses;
  try {
    const [playbooks, unserved] = await Promise.all([listPlaybooks(), listUnservedPlaybooks()]);
    return {
      playbooks: playbooks.map(({ slug, title, summary, version, pending }) => ({
        slug,
        title,
        summary: text(summary),
        version,
        pending,
      })),
      unserved,
      storeError: null,
    };
  } catch (e) {
    console.error('[assistant] playbooks unavailable', e);
    return { playbooks: [], unserved: [], storeError: assistantStoreMessage(moderatorDbStatus(e)) };
  }
};

export const actions: Actions = {
  create: requiresGrant('assistant.use', async ({ request, locals }) => {
    const form = Object.fromEntries(await request.formData());
    const slug = playbookSlugSchema.safeParse(form.slug);
    if (!slug.success) return fail(400, { error: firstIssue(slug.error) });
    const draft = playbookDraftSchema.safeParse(form);
    if (!draft.success) return fail(400, { error: firstIssue(draft.error) });
    if (await getPlaybookHistory(slug.data))
      return fail(409, { error: `A playbook named "${slug.data}" already exists.` });
    await addPlaybookVersion({
      slug: slug.data,
      draft: draft.data,
      authorId: locals.user.id,
      byAssistant: false,
      sourceTurnId: null,
    });
    redirect(303, `/assistant/playbooks/${slug.data}`);
  }),
};
