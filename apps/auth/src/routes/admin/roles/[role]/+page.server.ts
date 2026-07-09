import { error, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { getRole, listMembers, addMember, removeMember } from '$lib/server/auth/roles';

export const load: PageServerLoad = async ({ params }) => {
  const role = await getRole(params.role);
  if (!role) error(404, 'Role not found.');
  return { role, members: await listMembers(role.id) };
};

export const actions: Actions = {
  add: async ({ params, request, locals }) => {
    const data = await request.formData();
    const userRaw = String(data.get('user') ?? '').trim();
    const note = String(data.get('note') ?? '').trim() || null;
    if (!userRaw) return fail(400, { error: 'Enter a user id or username.' });

    const res = await addMember(params.role, userRaw, note, locals.user?.id ?? null);
    if (!res.ok) return fail(409, { error: res.error });
    return { success: true, message: `Added ${res.user.username ?? `user #${res.user.id}`}.` };
  },

  remove: async ({ params, request }) => {
    const data = await request.formData();
    const userId = Number(data.get('userId'));
    if (!Number.isInteger(userId)) return fail(400, { error: 'Invalid user.' });

    await removeMember(params.role, userId);
    return { success: true, message: 'Removed member.' };
  },
};
