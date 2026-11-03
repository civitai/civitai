import { describe, expect, it } from 'vitest';
import { getKlein9bNoticeHtml } from '~/server/email/templates/klein9bNotice.email';
import type { Klein9bUserRow, Klein9bVersionRow } from '~/server/services/klein9b-notice.service';
import { classifyKlein9bAudience } from '~/server/services/klein9b-notice.service';

const version = (over: Partial<Klein9bVersionRow>): Klein9bVersionRow => ({
  userId: 1,
  modelName: 'Model',
  versionName: 'v1',
  status: 'Published',
  modelStatus: 'Published',
  licensingFee: null,
  paidAccess: false,
  ...over,
});
const user = (id: number, over: Partial<Klein9bUserRow> = {}): Klein9bUserRow => ({
  id,
  email: `u${id}@example.com`,
  username: `u${id}`,
  bannedAt: null,
  deletedAt: null,
  ...over,
});

describe('classifyKlein9bAudience', () => {
  it('sends the charged notice for a fee or open paid access in any status, listing only charged versions', () => {
    const { recipients } = classifyKlein9bAudience(
      [
        version({ userId: 1, modelName: 'A', versionName: 'fee', licensingFee: 5 }),
        version({ userId: 1, modelName: 'A', versionName: 'free' }),
        version({
          userId: 2,
          modelName: 'B',
          versionName: 'gated draft',
          status: 'Draft',
          paidAccess: true,
        }),
      ],
      [user(1), user(2)]
    );
    expect(recipients.map((r) => [r.id, r.variant, r.versions])).toEqual([
      [1, 'charged', ['A: fee']],
      [2, 'charged', ['B: gated draft']],
    ]);
  });

  it('sends the uncharged notice only for a published version on a published model, nothing charged', () => {
    const { recipients } = classifyKlein9bAudience(
      [
        version({ userId: 3 }),
        version({ userId: 4, status: 'Draft' }),
        version({ userId: 5, status: 'Unpublished', licensingFee: 0 }),
        version({ userId: 9, modelStatus: 'Draft' }),
      ],
      [user(3), user(4), user(5), user(9)]
    );
    expect(recipients.map((r) => [r.id, r.variant])).toEqual([[3, 'uncharged']]);
  });

  it('skips banned and deleted accounts and counts them', () => {
    const { recipients, excluded } = classifyKlein9bAudience(
      [version({ userId: 6, licensingFee: 5 }), version({ userId: 7 }), version({ userId: 8 })],
      [user(6, { bannedAt: new Date() }), user(7, { deletedAt: new Date() }), user(8)]
    );
    expect(recipients.map((r) => r.id)).toEqual([8]);
    expect(excluded).toBe(2);
  });
});

describe('getKlein9bNoticeHtml', () => {
  it('fills the name, date and the charged versions, escaped', () => {
    const html = getKlein9bNoticeHtml({
      variant: 'charged',
      username: '<b>Ann</b>',
      date: 'November 4th',
      versions: ['My <LoRA>: v2'],
    });
    expect(html).toContain('Hi &lt;b&gt;Ann&lt;/b&gt;,');
    expect(html).toContain('As of November 4th, here');
    expect(html).toContain('<li>My &lt;LoRA&gt;: v2</li>');
    expect(html).toContain('FLUX Non-Commercial License v2.1');
    expect(html).not.toMatch(/\{(username|date|versions)\}/);
  });

  it('the uncharged notice has no version list', () => {
    const html = getKlein9bNoticeHtml({
      variant: 'uncharged',
      username: 'Ann',
      date: 'November 4th',
    });
    expect(html).toContain('Generation earnings stop');
    expect(html).not.toMatch(/\{(username|date|versions)\}/);
  });
});
