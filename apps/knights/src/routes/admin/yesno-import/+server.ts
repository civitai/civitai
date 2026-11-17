// Temporary: remove after the Knights v2 launch import
import { json } from '@sveltejs/kit';
import { logToAxiom } from '$lib/server/axiom';
import { db } from '$lib/server/db';
import { importYesNoChunk } from '$lib/server/yesno/import';
import type { RequestHandler } from './$types';

const refuse = (status: number, message: string) => json({ ok: false, message }, { status });

export const POST: RequestHandler = async ({ request, locals }) => {
  if (locals.user?.isModerator !== true) return refuse(403, 'Moderators only.');

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return refuse(400, 'Send a JSON body.');
  }
  const { csv, dryRun } = (payload ?? {}) as { csv?: unknown; dryRun?: unknown };
  if (typeof csv !== 'string' || typeof dryRun !== 'boolean') {
    return refuse(400, 'Send { csv: string, dryRun: boolean }.');
  }

  try {
    const summary = await importYesNoChunk(db, csv, { dryRun });
    if (!dryRun) {
      void logToAxiom({
        type: 'info',
        name: 'knights-yesno-import',
        message: 'Knights yes/no import chunk',
        userId: locals.user.id,
        read: summary.read,
        toImport: summary.toImport,
        skipped: summary.skipped,
        retire: summary.retire,
        ...summary.result,
      });
    }
    return json({ ok: true, dryRun, ...summary });
  } catch (error) {
    console.error('knights: yes/no import chunk failed', { error });
    return refuse(500, 'This chunk failed; nothing is lost, retry it.');
  }
};
