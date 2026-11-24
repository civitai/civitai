import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DIGEST_EVENTS_TABLE,
  digestEventRow,
  digestTargetPath,
  getDigestClickUrl,
  safeSitePath,
} from '~/server/notifications/digest-tracking';

const CYCLE = new Date('2026-11-16T12:00:00.000Z');
const click = {
  userId: 42,
  cycleStartedAt: CYCLE,
  position: 3,
  notificationType: 'new-comment',
  to: '/images/7?tab=comments#c9',
};

describe('which digest links are tracked', () => {
  it('a site path or a url on this site is tracked; anything off the site is not', () => {
    expect(digestTargetPath('/models/1')).toBe('/models/1');
    expect(digestTargetPath('http://localhost:3000/models/1?v=2')).toBe('/models/1?v=2');
    expect(digestTargetPath('https://elsewhere.example/models/1')).toBeNull();
    expect(digestTargetPath('//elsewhere.example/models/1')).toBeNull();
    expect(digestTargetPath(undefined)).toBeNull();
  });

  it('a link is never minted for a destination off the site', () => {
    expect(safeSitePath('/ok')).toBe('/ok');
    expect(safeSitePath(`/${'a'.repeat(3000)}`)).toBeNull();
    expect(() => getDigestClickUrl({ ...click, to: '//evil.example' })).toThrow();
  });
});

// A row key the table lacks fails the whole insert inside a swallowed catch, so the two are pinned.
describe('notificationDigestEvents row and DDL', () => {
  it('writes exactly the columns the table declares, for every event', () => {
    const sql = readFileSync(
      path.resolve(
        __dirname,
        '../../clickhouse/migrations/2026-11-24-notification-digest-events.sql'
      ),
      'utf8'
    );
    const open = `${DIGEST_EVENTS_TABLE}\n(`;
    const columns = sql
      .slice(sql.indexOf(open) + open.length, sql.indexOf('\n)\nENGINE'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0]);
    expect(columns.length).toBeGreaterThan(5);
    const at = new Date(CYCLE.getTime() + 1000);
    for (const row of [
      digestEventRow(
        { event: 'send', userId: 1, cycleStartedAt: CYCLE, sentAt: CYCLE, itemCount: 4 },
        at
      ),
      digestEventRow({ ...click, event: 'click', userAgent: 'x' }, at),
      digestEventRow({ event: 'unsubscribe', userId: 1, cycleStartedAt: null }, at),
    ])
      expect(new Set(Object.keys(row))).toEqual(new Set(columns));
  });
});
