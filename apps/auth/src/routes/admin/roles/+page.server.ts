import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { ROLE_APPS, roleId, listRoles, createRole, deleteRole } from '$lib/server/auth/roles';

export const load: PageServerLoad = async () => ({
  roles: await listRoles(),
  apps: [...ROLE_APPS],
});

export const actions: Actions = {
  create: async ({ request, locals }) => {
    const data = await request.formData();
    const app = String(data.get('app') ?? '');
    const description = String(data.get('description') ?? '').trim() || null;
    if (!(ROLE_APPS as readonly string[]).includes(app)) return fail(400, { error: 'Pick a valid app.' });

    const id = roleId(app, String(data.get('name') ?? ''));
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
