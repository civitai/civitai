import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  announcementsEnabled,
  getAllowance,
  getMyAnnouncements,
  removeAnnouncement,
  saveAnnouncement,
} from '$lib/server/announcements';
import { announcementFormSchema, deleteAnnouncementSchema } from '$lib/server/announcements-schema';
import { getAnnouncementMetrics } from '$lib/server/announcement-analytics';

async function assertEnabled(locals: App.Locals) {
  if (!(await announcementsEnabled(locals.user))) error(404, 'Not found');
}

export const load: PageServerLoad = async ({ locals, request }) => {
  await assertEnabled(locals);

  const [allowance, announcements] = await Promise.all([
    getAllowance(request.headers.get('cookie') ?? ''),
    getMyAnnouncements(locals.user.id),
  ]);

  // Runs after the list because the ids to ask ClickHouse about are the rows Postgres just
  // returned. `null` on failure rather than a throw: these numbers decorate a page whose real
  // job is composing and deleting announcements, and a ClickHouse outage must not take that away.
  const metrics = await getAnnouncementMetrics(
    locals.user.id,
    announcements.map((a) => a.id)
  ).catch(() => null);

  return {
    announcements,
    metrics,
    allowance: allowance.ok ? allowance.data : null,
    allowanceError: allowance.ok ? null : allowance.error,
  };
};

export const actions: Actions = {
  save: async ({ locals, request }) => {
    await assertEnabled(locals);

    const form = await request.formData();
    // Carried on every failure so the page can tell whose failure it is: one `form` object serves
    // both panels and survives until a navigation, so an unscoped message reappears against the
    // next row the creator opens.
    const subject = Number(form.get('id')) || null;

    const parsed = announcementFormSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) {
      return fail(400, {
        scope: 'save' as const,
        subject,
        error: parsed.error.issues[0]?.message ?? 'Check the form and try again.',
      });
    }

    const result = await saveAnnouncement(request.headers.get('cookie') ?? '', parsed.data);
    if (!result.ok)
      return fail(result.status, { scope: 'save' as const, subject, error: result.error });

    return { scope: 'save' as const, subject, saved: true };
  },

  delete: async ({ locals, request }) => {
    await assertEnabled(locals);

    const form = await request.formData();
    const subject = Number(form.get('id')) || null;
    const parsed = deleteAnnouncementSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success)
      return fail(400, { scope: 'delete' as const, subject, error: 'Unknown announcement.' });

    const result = await removeAnnouncement(request.headers.get('cookie') ?? '', parsed.data.id);
    if (!result.ok)
      return fail(result.status, { scope: 'delete' as const, subject, error: result.error });

    return { scope: 'delete' as const, subject, deleted: true };
  },
};
