import { describe, expect, it } from 'vitest';
import { collapseRulings, probabilityLabel } from '../../../decisions';
import {
  CATALOG_WARN_AT,
  STALE_ROUTING_MINUTES,
  chDate,
  founderPosition,
  headerWarnings,
  mapListRow,
  mapMember,
  mapTicket,
  probabilities,
  resolveVersion,
} from '../support';

/**
 * The support adapter's pure decisions. Each one is a place where a wrong answer renders plausibly:
 * a "0%" that was never measured, a timestamp shifted by the viewer's offset, a representative that
 * is not the founder.
 */

const member = (over: Partial<Parameters<typeof mapMember>[0]> = {}) => ({
  ticket_id: '10001',
  ticket_created_at: '2026-09-24 22:54:21.000',
  p_group: 0.88,
  p_novel: 0.07,
  p_topic: 0.91,
  chosen_topic: 'billing-buzz',
  assigned_at: '2026-10-05 19:15:22.841',
  routed_ticket_id: '10001',
  ticket_subject: 'Charged twice',
  ticket_status: 'open',
  member_tier: 'gold',
  is_paying_priority: 1,
  is_novel: 0,
  civitai_user_id: '123',
  question_spec_hash: 'aaaaaaaaaaaa',
  ...over,
});

describe('absent probabilities render "—", never "0%"', () => {
  it('a SEED founder: all three were never measured', () => {
    const p = probabilities({
      createdBy: 'seed',
      isFounder: true,
      pTopic: 0,
      pGroup: 0,
      pNovel: 0,
    });
    expect(p).toEqual({ topic: null, group: null, novel: null });
    expect([p.topic, p.group, p.novel].map(probabilityLabel)).toEqual(['—', '—', '—']);
  });

  it('a router_no_candidates founder: group and novel absent, topic is real', () => {
    const p = probabilities({
      createdBy: 'router_no_candidates',
      isFounder: true,
      pTopic: 0.62,
      pGroup: 0,
      pNovel: 0,
    });
    expect(p).toEqual({ topic: 0.62, group: null, novel: null });
    expect(probabilityLabel(p.group)).toBe('—');
    expect(probabilityLabel(p.topic)).toBe('62%');
  });

  it('a normal routed member renders percentages — including a REAL zero', () => {
    const p = probabilities({
      createdBy: 'router',
      isFounder: false,
      pTopic: 0.97,
      pGroup: 0.71,
      pNovel: 0,
    });
    expect([p.topic, p.group, p.novel].map(probabilityLabel)).toEqual(['97%', '71%', '0%']);
  });

  it('a non-founder member of a seed group was routed — its values are real', () => {
    const p = probabilities({
      createdBy: 'seed',
      isFounder: false,
      pTopic: 0.8,
      pGroup: 0.9,
      pNovel: 0.05,
    });
    expect(p).toEqual({ topic: 0.8, group: 0.9, novel: 0.05 });
  });

  it('a seed founder the router later RE-ROUTED carries real values, and they render', () => {
    const p = probabilities({
      createdBy: 'seed',
      isFounder: true,
      pTopic: 0.7,
      pGroup: 0.66,
      pNovel: 0.1,
    });
    expect(p).toEqual({ topic: 0.7, group: 0.66, novel: 0.1 });
  });

  it('mapMember applies it on the founder row of a seed group', () => {
    const founder = mapMember(
      member({ p_group: 0, p_novel: 0, p_topic: 0, routed_ticket_id: '', ticket_subject: '' }),
      { createdBy: 'seed', foundedTicketId: '10001' }
    );
    expect(founder.isFounder).toBe(true);
    expect(founder.routed).toBe(false);
    expect(founder.probabilities).toEqual({ topic: null, group: null, novel: null });
    // A LEFT JOIN miss fills '' — never-routed fields read as unknown, not as empty values.
    expect(founder.subject).toBeNull();
    expect(founder.civitaiUserId).toBeNull();
  });

  it('mapTicket applies it to a routed row that founded a router_no_candidates group', () => {
    const t = mapTicket(
      {
        ticket_id: '9',
        ticket_created_at: '2026-10-04 09:40:00.000',
        ticket_updated_at: '2026-10-04 09:41:00.000',
        ticket_status: 'open',
        ticket_subject: 's',
        civitai_user_id: null,
        member_tier: '',
        is_paying_priority: 0,
        body_excerpt: '',
        chosen_topic: 'crypto',
        p_topic: 0.5,
        group_key: '',
        p_group: 0,
        p_novel: 0,
        is_novel: 1,
        usage_input_tokens: 10,
        usage_cost_micro_usd: 1,
        latency_ms: 2,
        router_version: 'v',
        question_spec_hash: 'h',
        model: 'm',
        ingested_at: '2026-10-04 09:52:00.000',
      },
      {
        group_key: 'g_x',
        title: 't',
        created_by: 'router_no_candidates',
        founded_ticket_id: '9',
        assigned_at: '2026-10-04 09:52:00.000',
      },
      false
    );
    expect(t.probabilities).toEqual({ topic: 0.5, group: null, novel: null });
    expect('requesterEmail' in t).toBe(false);
    // A novel routed row carries group_key '' — the group it FOUNDED comes from the member row.
    expect(t.membership).toEqual({
      groupKey: 'g_x',
      title: 't',
      createdBy: 'router_no_candidates',
      isFounder: true,
      assignedAt: '2026-10-04T09:52:00.000Z',
    });
    expect(t.ticketUrl).toMatch(/\/a\/tickets\/9$/);
  });

  it('a seed founder re-routed with p_group 0 but a real p_novel keeps BOTH real values', () => {
    expect(
      probabilities({ createdBy: 'seed', isFounder: true, pTopic: 0.4, pGroup: 0, pNovel: 0.93 })
    ).toEqual({ topic: 0.4, group: 0, novel: 0.93 });
    expect(
      probabilities({ createdBy: 'seed', isFounder: true, pTopic: 0.4, pGroup: 0.3, pNovel: 0 })
    ).toEqual({ topic: 0.4, group: 0.3, novel: 0 });
  });

  it('each member links to ITS OWN ticket, not the founder', () => {
    const m = mapMember(member({ ticket_id: '10002' }), {
      createdBy: 'router',
      foundedTicketId: '1',
    });
    expect(m.ticketUrl).toMatch(/\/a\/tickets\/10002$/);
  });

  it('mapListRow: a seed founder (no routed subject) falls back to the title; the alarm is at 10', () => {
    const base = {
      group_key: 'g1',
      title: 'Group title',
      topic: 'crypto',
      founded_ticket_id: '555',
      founded_at: '2026-10-01 00:00:00.000',
      n_members: '3',
      last_seen: '2026-10-02 00:00:00.000',
      low_conf_members: '1',
      created_by: 'seed',
      new_24h: '10',
      n_topics: '2',
      rep_subject: '',
    };
    const out = mapListRow(base);
    expect(out).toMatchObject({
      title: 'Group title',
      members: 3,
      new24h: 10,
      new24hAlarm: true,
      topicCount: 2,
      lowConfidence: 1,
      lastSeen: '2026-10-02T00:00:00.000Z',
    });
    expect(out.ticketUrl).toMatch(/\/a\/tickets\/555$/);
    expect(mapListRow({ ...base, new_24h: '9', rep_subject: 'Subject' })).toMatchObject({
      title: 'Subject',
      new24hAlarm: false,
    });
  });

  it('collapseRulings: empty is null, agreement is the value, disagreement is mixed', () => {
    expect(collapseRulings([])).toBeNull();
    expect(collapseRulings(['belongs', 'belongs'])).toBe('belongs');
    expect(collapseRulings(['belongs', null])).toBe('mixed');
  });
});

describe('DateTime64(3) through clickhouseDate', () => {
  it('YYYY-MM-DD HH:MM:SS.mmm becomes a valid UTC ISO string', () => {
    const iso = chDate('2026-10-06 15:30:25.410');
    expect(iso).toBe('2026-10-06T15:30:25.410Z');
    expect(new Date(iso!).toISOString()).toBe('2026-10-06T15:30:25.410Z');
  });

  it('a whole-second DateTime still parses', () => {
    expect(new Date(chDate('2026-10-04 10:33:29')!).getTime()).toBe(
      Date.UTC(2026, 9, 4, 10, 33, 29)
    );
  });

  it('NULL and empty stay null rather than becoming "Z"', () => {
    expect(chDate(null)).toBeNull();
    expect(chDate('')).toBeNull();
  });
});

describe('founder-first ordering invariant', () => {
  it('first when the founder is the oldest member', () => {
    expect(founderPosition(['1', '2', '3'], '1')).toBe('first');
  });
  it('not-first when an older member precedes it — the router invariant broke', () => {
    expect(founderPosition(['0', '1', '2'], '1')).toBe('not-first');
  });
  it('absent when the founder was re-routed out — a different state, a different warning', () => {
    expect(founderPosition(['2', '3'], '1')).toBe('absent');
  });
  it('mapMember marks only the founding ticket as founder', () => {
    const g = { createdBy: 'router', foundedTicketId: '2' };
    expect([
      mapMember(member({ ticket_id: '1' }), g).isFounder,
      mapMember(member({ ticket_id: '2' }), g).isFounder,
    ]).toEqual([false, true]);
  });
});

describe('version resolution', () => {
  it('uses the version that routed most recently by default', () => {
    expect(resolveVersion(null, 'v-latest')).toEqual({
      version: 'v-latest',
      overridden: false,
    });
  });
  it('?version= wins', () => {
    expect(resolveVersion('v0.0-old', 'v0.1-new')).toEqual({
      version: 'v0.0-old',
      overridden: true,
    });
  });
  it('no data and no override is null, not a guessed constant', () => {
    expect(resolveVersion(undefined, null)).toEqual({ version: null, overridden: false });
  });
});

describe('header warnings', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  const fresh = new Date(now - 5 * 60_000).toISOString();

  it('nothing to warn about on a healthy header', () => {
    expect(headerWarnings({ activeGroups: 119, lastRoutedAt: fresh, specCount: 1 }, now)).toEqual(
      []
    );
  });
  it('warns at the catalog threshold — 90% of the cap — and not one below it', () => {
    expect(CATALOG_WARN_AT).toBe(216);
    expect(headerWarnings({ activeGroups: 215, lastRoutedAt: fresh, specCount: 1 }, now)).toEqual(
      []
    );
    const w = headerWarnings({ activeGroups: 216, lastRoutedAt: fresh, specCount: 1 }, now);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/216 of 240/);
  });
  it('warns ADMINS on more than one question spec under one version', () => {
    expect(
      headerWarnings({ activeGroups: 1, lastRoutedAt: fresh, specCount: 2 }, now, false, true)[0]
    ).toMatch(/2 different question specs/);
  });
  it('does not show the question-spec note to a moderator, who cannot act on it', () => {
    expect(headerWarnings({ activeGroups: 1, lastRoutedAt: fresh, specCount: 2 }, now)).toEqual([]);
  });
  it('the cap and stopped-routing warnings reach everyone, admin or not', () => {
    const old = new Date(now - (STALE_ROUTING_MINUTES + 1) * 60_000).toISOString();
    for (const admin of [false, true]) {
      const w = headerWarnings(
        { activeGroups: 230, lastRoutedAt: old, specCount: 1 },
        now,
        false,
        admin
      );
      expect(w).toHaveLength(2);
      expect(w[0]).toMatch(/230 of 240/);
      expect(w[1]).toMatch(/No ticket routed for over/);
    }
  });
  it('does not call a PINNED (usually retired) version stopped', () => {
    const old = new Date(now - (STALE_ROUTING_MINUTES + 1) * 60_000).toISOString();
    expect(headerWarnings({ activeGroups: 1, lastRoutedAt: old, specCount: 1 }, now, true)).toEqual(
      []
    );
  });

  it('warns when routing has gone quiet past the threshold, and when nothing was ever routed', () => {
    const old = new Date(now - (STALE_ROUTING_MINUTES + 1) * 60_000).toISOString();
    expect(headerWarnings({ activeGroups: 1, lastRoutedAt: old, specCount: 1 }, now)).toHaveLength(
      1
    );
    expect(headerWarnings({ activeGroups: 1, lastRoutedAt: null, specCount: 0 }, now)[0]).toMatch(
      /No ticket has been routed/
    );
  });
});
