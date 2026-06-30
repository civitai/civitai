import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { roleId, roleApps, listRoles, createRole, deleteRole } from '$lib/server/auth/roles';

export const load: PageServerLoad = async () => {
  const roles = await listRoles();
  return { roles, apps: roleApps(roles.map((r) => r.id)) };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    const data = await request.formData();
    const description = String(data.get('description') ?? '').trim() || null;

    const id = roleId(String(data.get('app') ?? ''), String(data.get('name') ?? ''));
    if (!id) return fail(400, { error: 'Enter a role name.' });

    const created = await createRole(id, description, locals.user?.id ?? null);
    if (!created) return fail(409, { error: `Role ${id} already exists.` });
    return { success: true, message: `Created ${id}.` };
  },

  delete: async ({ request }) => {
    const data = await request.formData();
    const id = String(data.get('id') ?? '');
    if (!id) return fail(400, { error: 'Missing role.' });
    await deleteRole(id);
    return { success: true, message: `Deleted ${id}.` };
  },
};
