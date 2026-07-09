import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { db } from '$lib/server/db/db';
import { invalidateDomainCache } from '$lib/server/oauth/first-party';

// Admin editor for the TrustedSpokeDomain registry (the first-party login host allowlist read by
// $lib/server/oauth/first-party.ts). Gated to admins by /admin/+layout.server.ts. After every write we
// invalidateDomainCache() so the change is live on this instance immediately (other instances pick it up
// on their ~60s TTL).

// A bare host only — no scheme, no port, no path. Lower-cased. Examples: civitai.com, test-auth.civitai.red,
// civitaic.com, localhost. (The wildcard is expressed by the includeSubdomains flag, never in the string.)
const HOST_RE = /^(localhost|([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/;

function normalizeDomain(raw: string): { domain: string } | { error: string } {
  let value = raw.trim().toLowerCase();
  if (!value) return { error: 'Domain is required.' };
  // Be forgiving about a pasted URL/origin — strip scheme, any path, and a trailing port.
  value = value.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (value.length > 253) return { error: 'Domain is too long.' };
  if (!HOST_RE.test(value)) {
    return { error: `"${value}" is not a valid host (use a bare hostname like civitai.red — no scheme or port).` };
  }
  return { domain: value };
}

// pg unique-constraint violation (duplicate domain). Kysely surfaces the driver error verbatim.
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

const checkbox = (v: FormDataEntryValue | null) => v === 'true' || v === 'on';

export const load: PageServerLoad = async () => {
  const domains = await db
    .selectFrom('TrustedSpokeDomain')
    .select(['id', 'domain', 'includeSubdomains', 'label', 'enabled', 'createdAt', 'updatedAt'])
    .orderBy('domain', 'asc')
    .execute();
  return { domains };
};

export const actions: Actions = {
  // Add a new host to the registry.
  create: async ({ request }) => {
    const data = await request.formData();
    const result = normalizeDomain(String(data.get('domain') ?? ''));
    const includeSubdomains = checkbox(data.get('includeSubdomains'));
    const enabled = checkbox(data.get('enabled'));
    const labelRaw = String(data.get('label') ?? '').trim();
    const label = labelRaw || null;

    if ('error' in result) {
      return fail(400, { action: 'create', error: result.error, values: { includeSubdomains, enabled, label: labelRaw } });
    }

    const inserted = await db
      .insertInto('TrustedSpokeDomain')
      .values({ domain: result.domain, includeSubdomains, label, enabled })
      .onConflict((oc) => oc.column('domain').doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!inserted) {
      return fail(409, { action: 'create', error: `"${result.domain}" is already in the registry.`, values: { includeSubdomains, enabled, label: labelRaw } });
    }

    invalidateDomainCache();
    return { action: 'create', success: true, domain: result.domain };
  },

  // Update an existing row (domain / label / flags).
  update: async ({ request }) => {
    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!Number.isInteger(id)) return fail(400, { action: 'update', error: 'Missing row id.' });

    const result = normalizeDomain(String(data.get('domain') ?? ''));
    if ('error' in result) return fail(400, { action: 'update', id, error: result.error });

    const includeSubdomains = checkbox(data.get('includeSubdomains'));
    const enabled = checkbox(data.get('enabled'));
    const label = String(data.get('label') ?? '').trim() || null;

    try {
      const updated = await db
        .updateTable('TrustedSpokeDomain')
        .set({ domain: result.domain, includeSubdomains, label, enabled, updatedAt: new Date() })
        .where('id', '=', id)
        .returning('id')
        .executeTakeFirst();
      if (!updated) return fail(404, { action: 'update', id, error: 'That row no longer exists.' });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(409, { action: 'update', id, error: `Another row already uses "${result.domain}".` });
      }
      throw err;
    }

    invalidateDomainCache();
    return { action: 'update', success: true, id, domain: result.domain };
  },

  // Remove a row entirely.
  delete: async ({ request }) => {
    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!Number.isInteger(id)) return fail(400, { action: 'delete', error: 'Missing row id.' });

    await db.deleteFrom('TrustedSpokeDomain').where('id', '=', id).execute();
    invalidateDomainCache();
    return { action: 'delete', success: true, id };
  },
};
