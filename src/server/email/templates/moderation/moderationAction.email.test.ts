import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  moderationActionEmail,
  SUPPORT_URL,
  type ModerationActionEmailData,
  type ModerationActionKind,
} from '~/server/email/templates/moderation/moderationAction.email';
import { sendEmail } from '~/server/email/client';

vi.mock('~/server/email/client', () => ({ sendEmail: vi.fn() }));

const mockSendEmail = vi.mocked(sendEmail);

const cases: Array<{
  kind: ModerationActionKind;
  heading: string;
  subject: string;
  positive: boolean;
}> = [
  {
    kind: 'account-banned',
    heading: 'Account Banned',
    subject: 'Civitai - Your account has been banned',
    positive: false,
  },
  {
    kind: 'account-unbanned',
    heading: 'Account Reinstated',
    subject: 'Civitai - Your account has been reinstated',
    positive: true,
  },
  {
    kind: 'restriction-upheld',
    heading: 'Account Restriction Upheld',
    subject: 'Civitai - Account restriction upheld',
    positive: false,
  },
  {
    kind: 'restriction-overturned',
    heading: 'Account Restriction Lifted',
    subject: 'Civitai - Account restriction lifted',
    positive: true,
  },
  {
    kind: 'appeal-rejected',
    heading: 'Appeal Decision',
    subject: 'Civitai - Appeal decision',
    positive: false,
  },
  {
    kind: 'appeal-approved',
    heading: 'Appeal Approved',
    subject: 'Civitai - Appeal approved',
    positive: true,
  },
];

const baseData = (
  kind: ModerationActionKind,
  reason?: string
): ModerationActionEmailData => ({
  to: 'user@example.com',
  username: 'TestUser',
  kind,
  reason,
});

describe('moderationActionEmail', () => {
  beforeEach(() => mockSendEmail.mockClear());

  it.each(cases)('renders heading and username for $kind', ({ kind, heading }) => {
    const html = moderationActionEmail.getHtml(baseData(kind));
    expect(html).toContain(heading);
    expect(html).toContain('TestUser');
  });

  it.each(cases)('renders reason when present for $kind', ({ kind }) => {
    const reason = 'A specific moderator-supplied reason.';
    const html = moderationActionEmail.getHtml(baseData(kind, reason));
    expect(html).toContain(reason);
  });

  it.each(cases)(
    'omits reason block when reason absent for $kind',
    ({ kind }) => {
      const html = moderationActionEmail.getHtml(baseData(kind));
      expect(html).not.toContain('Reason:');
    }
  );

  it.each(cases)(
    'renders Contact Support button only for negative kinds ($kind)',
    ({ kind, positive }) => {
      const html = moderationActionEmail.getHtml(baseData(kind));
      if (positive) {
        expect(html).not.toContain(SUPPORT_URL);
        expect(html).not.toContain('Contact Support');
      } else {
        expect(html).toContain(SUPPORT_URL);
        expect(html).toContain('Contact Support');
      }
    }
  );

  it.each(cases)('sends with the expected subject for $kind', async ({ kind, subject }) => {
    await moderationActionEmail.send(baseData(kind));
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject }));
  });

  it('uses a ctaUrl override for negative kinds', () => {
    const html = moderationActionEmail.getHtml({
      ...baseData('account-banned'),
      ctaUrl: 'https://civitai.com/appeal/123',
    });
    expect(html).toContain('https://civitai.com/appeal/123');
    expect(html).not.toContain(SUPPORT_URL);
  });

  it('escapes HTML in username and reason to prevent markup injection', () => {
    const html = moderationActionEmail.getHtml({
      to: 'user@example.com',
      username: '<script>alert(1)</script>',
      kind: 'account-banned',
      reason: 'Used <b>blocked</b> content & violated ToS',
    });
    // raw markup must not survive
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<b>blocked</b>');
    // escaped entities are present instead
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;blocked&lt;/b&gt;');
    expect(html).toContain('&amp;');
  });
});
