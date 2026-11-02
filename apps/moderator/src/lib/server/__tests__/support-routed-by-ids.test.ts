import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));

import { getRoutedTicketContext, routedByIdsSql } from '../decision-sources/support';

describe('routedByIdsSql', () => {
  it('selects the requester address only with the PII grant', () => {
    expect(routedByIdsSql(false)).not.toMatch(/requester_email/);
    expect(routedByIdsSql(true)).toMatch(/requester_email/);
  });

  it('reads the router table with FINAL, as a parameterised select', () => {
    for (const sql of [routedByIdsSql(false), routedByIdsSql(true)]) {
      expect(sql).toMatch(/support_tickets_routed FINAL/);
      expect(sql).toMatch(/^\s*SELECT\b/);
      expect(sql).toContain('{ids:Array(String)}');
    }
  });
});

describe('getRoutedTicketContext', () => {
  const client = (rows: unknown[]) => {
    const query = vi.fn(async ({ query }: { query: string }) => ({
      json: async <T>() =>
        (query.includes('GROUP BY router_version')
          ? [{ router_version: 'v9' }]
          : rows) as unknown as T[],
    }));
    return { query };
  };

  it('keeps the address out of the result without the grant, even if a row carried one', async () => {
    const c = client([
      {
        ticket_id: '7',
        chosen_topic: 'nsfw-moderation',
        civitai_user_id: 5,
        requester_email: 'a@b.c',
      },
    ]);
    const out = await getRoutedTicketContext(['7'], false, c);
    expect(out.get('7')).toEqual({ topic: 'nsfw-moderation', civitaiUserId: 5 });
  });

  it('returns the address with the grant, and drops ids that are not Freshdesk ids', async () => {
    const c = client([
      { ticket_id: '7', chosen_topic: '', civitai_user_id: 0, requester_email: 'a@b.c' },
    ]);
    const out = await getRoutedTicketContext(['7', "7' OR 1=1"], true, c);
    expect(out.get('7')).toEqual({ topic: null, civitaiUserId: null, requesterEmail: 'a@b.c' });
    const params = c.query.mock.calls.at(-1)![0] as unknown as { query_params: { ids: string[] } };
    expect(params.query_params.ids).toEqual(['7']);
  });
});
