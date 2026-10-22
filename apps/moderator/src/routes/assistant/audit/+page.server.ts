import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { listAuditTurns, type AuditRow } from '$lib/server/assistant/store';
import { usersByIds } from '$lib/server/users.service';
import { canSeeAddresses } from '$lib/server/access';
import { redactAddresses } from '$lib/server/redact-addresses';
import { redactEmails } from '$lib/server/assistant/email';
import { moderatorDbStatus } from '$lib/moderator-db-status';
import { assistantStoreMessage } from '../store-status';

// Every moderator's turns, newest first: who asked what, which lookups ran with which arguments and how
// many rows came back, the answer, the model and the tokens. Its own page grant, held by nobody until
// ticked on /admin, because it reads other moderators' investigations.

const PAGE = 50;
const querySchema = z.object({
  moderator: z.coerce.number().int().positive().optional().catch(undefined),
  before: z.coerce.number().int().positive().optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const { moderator, before } = parseQuery(url, querySchema);
  let rows: AuditRow[] = [];
  let storeError: string | null = null;
  try {
    rows = await listAuditTurns({ moderatorId: moderator, before, limit: PAGE + 1 });
  } catch (e) {
    console.error('[assistant] audit unavailable', e);
    storeError = assistantStoreMessage(moderatorDbStatus(e));
  }
  const page = rows.slice(0, PAGE);
  const names = await usersByIds(page.map((r) => r.moderatorId));
  // The audit is its own grant; holding it is not holding User Lookup's addresses, nor the emails a
  // pilot's assistant may have quoted.
  const addresses = canSeeAddresses(locals);
  const emails = addresses && !!locals.grants['assistant.emails'];
  const redact = (text: string) => {
    const t = addresses ? text : redactAddresses(text);
    return emails ? t : redactEmails(t);
  };
  const shown =
    addresses && emails
      ? page
      : page.map((r) => ({
          ...r,
          chatTitle: redact(r.chatTitle),
          prompt: redact(r.prompt),
          answer: r.answer && redact(r.answer),
          reasoning: r.reasoning && redact(r.reasoning),
          toolCalls: r.toolCalls.map((c) => ({
            ...c,
            args: JSON.parse(redact(JSON.stringify(c.args))) as unknown,
          })),
        }));
  return {
    storeError,
    moderator: moderator ?? null,
    turns: shown.map((r) => ({ ...r, moderatorName: names.get(r.moderatorId)?.username ?? null })),
    nextBefore: rows.length > PAGE ? page[page.length - 1].id : null,
  };
};
