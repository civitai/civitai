import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import {
  addPlaybookVersion,
  getPlaybookHistory,
  reviewProposal,
  setPlaybookArchived,
} from '$lib/server/assistant/store';
import { usersByIds } from '$lib/server/users.service';
import { canSeeAddresses } from '$lib/server/access';
import { redactAddresses } from '$lib/server/redact-addresses';
import { firstIssue, playbookDraftSchema, playbookSlugSchema } from '../playbook-form';

function slugOf(raw: string) {
  const slug = playbookSlugSchema.safeParse(raw);
  if (!slug.success) error(404, 'No such playbook.');
  return slug.data;
}

export const load: PageServerLoad = async ({ params, locals }) => {
  const slug = slugOf(params.slug);
  const history = await getPlaybookHistory(slug);
  if (!history) error(404, 'No such playbook.');
  const people = await usersByIds(history.versions.flatMap((v) => [v.authorId, v.reviewedBy ?? 0]));
  // A draft the assistant wrote can carry the addresses its chat was shown.
  const text = canSeeAddresses(locals) ? (t: string) => t : redactAddresses;
  const versions = history.versions.map((v) => ({
    ...v,
    summary: text(v.summary),
    body: text(v.body),
    note: v.note && text(v.note),
  }));
  const current = versions.find((v) => v.status === 'accepted') ?? null;
  // Saved from a redacted form, an edit would overwrite every address with `[address]`.
  const raw = history.versions.find((v) => v.status === 'accepted');
  const redacted =
    !!raw && !!current && (raw.body !== current.body || raw.summary !== current.summary);
  return {
    slug,
    archived: history.archived,
    current,
    redacted,
    versions: versions.map((v) => ({
      ...v,
      author: people.get(v.authorId)?.username ?? `#${v.authorId}`,
      reviewer: v.reviewedBy ? people.get(v.reviewedBy)?.username ?? `#${v.reviewedBy}` : null,
    })),
  };
};

const reviewSchema = z.object({
  version: z.coerce.number().int().positive(),
  decision: z.enum(['accept', 'reject']),
});

export const actions: Actions = {
  edit: requiresGrant('assistant.use', async ({ request, params, locals }) => {
    const slug = slugOf(params.slug);
    const draft = playbookDraftSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!draft.success) return fail(400, { error: firstIssue(draft.error) });
    if (!(await getPlaybookHistory(slug))) return fail(404, { error: 'No such playbook.' });
    const { version } = await addPlaybookVersion({
      slug,
      draft: draft.data,
      authorId: locals.user.id,
      byAssistant: false,
      sourceTurnId: null,
    });
    return { success: true, version };
  }),

  review: requiresGrant('assistant.use', async ({ request, params, locals }) => {
    const parsed = reviewSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: 'Invalid review.' });
    const ok = await reviewProposal({
      slug: slugOf(params.slug),
      version: parsed.data.version,
      accept: parsed.data.decision === 'accept',
      reviewerId: locals.user.id,
    });
    return ok
      ? { success: true }
      : fail(409, {
          error:
            'That draft is no longer waiting for review, or a newer version was accepted after it was written. Edit the playbook to bring its changes in.',
        });
  }),

  archive: requiresGrant('assistant.use', async ({ request, params }) => {
    const archived = (await request.formData()).get('archived') === '1';
    const ok = await setPlaybookArchived(slugOf(params.slug), archived);
    return ok ? { success: true } : fail(404, { error: 'No such playbook.' });
  }),
};
