import { describe, expect, it } from 'vitest';
import { SEARCH_QUERY_MAX_CHARS, moderationQuery, statusQuery, unclassifiedQuery } from './queries';
import { TICKET_ROUTING } from './routing';

describe('Freshdesk search expressions', () => {
  it('stay within the length Freshdesk accepts', () => {
    for (const q of [moderationQuery(), unclassifiedQuery(), statusQuery(9000)])
      expect(q.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX_CHARS);
  });

  it('the moderation query asks for every routing feature and status, and only live tickets', () => {
    const q = moderationQuery();
    for (const f of TICKET_ROUTING.moderationFeatures) expect(q).toContain(`cf_feature:'${f}'`);
    for (const s of TICKET_ROUTING.moderationStatuses) expect(q).toContain(`status:${s}`);
    expect(q).not.toMatch(/status:[45]\b/);
  });

  it('the unclassified query asks for a null cf_feature among live tickets', () => {
    expect(unclassifiedQuery()).toMatch(/^cf_feature:null AND \(status:2 OR /);
  });
});
