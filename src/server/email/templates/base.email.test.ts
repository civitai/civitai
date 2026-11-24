import { describe, expect, it, vi } from 'vitest';
import { sendEmail } from '~/server/email/client';
import { createEmail } from '~/server/email/templates/base.email';

vi.mock('~/server/email/client', () => ({ sendEmail: vi.fn() }));

// The first case is enforced by `pnpm run typecheck:tests`, not by vitest: NoInfer is erased at
// transpile, so it passes at runtime either way.
describe('createEmail resolves T from the annotated params', () => {
  it('does not take testData as an inference site', () => {
    createEmail({
      template: 'test',
      mailClass: 'transactional',
      // @ts-expect-error - T must not come from testData (NoInfer<T> in base.email.ts), so
      // `data` is unknown here. Drop the NoInfer and this line compiles, which turns the
      // directive itself into TS2578 under TypeScript 5.9.
      header: (data) => ({ subject: 'x', to: data.email }),
      html: () => '',
      testData: async () => ({ email: 'test@tester.com' }),
    });
  });

  it('sends a template whose address type is nullable', async () => {
    type Data = { user: { email: string | null } };
    const template = createEmail({
      template: 'test',
      mailClass: 'transactional',
      header: ({ user }: Data) => ({ subject: 'Subject', to: user.email }),
      html: () => '<p>body</p>',
      testData: async () => ({ user: { email: 'test@tester.com' } }),
    });

    await template.send({ user: { email: null } });

    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Subject', to: null, html: '<p>body</p>' })
    );
  });
});

describe('createEmail tags', () => {
  it('a template without its key and mail class does not typecheck', () => {
    // @ts-expect-error - `template` and `mailClass` are required (TS2578 here instead, under
    // typecheck:tests, if the requirement is ever dropped).
    createEmail({ header: () => ({ subject: 'S', to: null }), html: () => '' });
  });

  it("sends with the template's tags plus what the caller adds for this send", async () => {
    vi.mocked(sendEmail).mockClear();
    const template = createEmail({
      template: 'welcomeBack',
      mailClass: 'lifecycle',
      optOut: { type: 'welcome-back', url: () => 'https://civitai.com/unsub?u=7&t=welcome-back' },
      header: (data: { to: string }) => ({ subject: 'S', to: data.to }),
      html: () => '<p>Hi</p>',
    });
    await template.send({ to: 'a@example.com' }, { userId: 7, campaign: 'c1', variant: 'b' });
    await template.send({ to: 'a@example.com' });
    expect(vi.mocked(sendEmail).mock.calls.map(([mail]) => mail.tags)).toEqual([
      { template: 'welcomeBack', mailClass: 'lifecycle', userId: 7, campaign: 'c1', variant: 'b' },
      { template: 'welcomeBack', mailClass: 'lifecycle' },
    ]);
  });
});

describe('createEmail send', () => {
  it('sends a plain-text part derived from the HTML, link included, when there is no text()', async () => {
    vi.mocked(sendEmail).mockClear();
    const template = createEmail({
      template: 'test',
      mailClass: 'transactional',
      header: (data: { to: string }) => ({ subject: 'S', to: data.to }),
      html: () => '<p>Hi</p><a href="https://civitai.com/apps/run/x">Open your app</a>',
    });
    await template.send({ to: 'a@example.com' });
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hi\n\nOpen your app [https://civitai.com/apps/run/x]' })
    );
  });
});

describe('createEmail lifecycle mail', () => {
  it('a lifecycle template without its own opt-out is refused at definition', () => {
    expect(() =>
      createEmail({
        template: 'noOptOut',
        mailClass: 'lifecycle',
        header: () => ({ subject: 'S', to: 'a@example.com' }),
        html: () => '',
      })
    ).toThrow('noOptOut: lifecycle mail must declare its opt-out');
  });

  it("sends List-Unsubscribe one-click with the send's own id, the same link the footer shows", async () => {
    vi.mocked(sendEmail).mockClear();
    const template = createEmail({
      template: 'welcomeBack',
      mailClass: 'lifecycle',
      optOut: { type: 'welcome-back', url: () => 'https://civitai.com/unsub?u=7&t=welcome-back' },
      header: (data: { to: string }) => ({
        subject: 'S',
        to: data.to,
        headers: { 'X-Other': 'kept' },
      }),
      html: (_data, ctx) => `<p><a href="${ctx?.unsubscribeUrl}">unsubscribe</a></p>`,
    });
    await template.send({ to: 'a@example.com' }, { userId: 7 });
    const mail = vi.mocked(sendEmail).mock.calls[0]![0];
    expect(mail.sendId).toMatch(/^[0-9a-f-]{36}$/);
    const url = `https://civitai.com/unsub?u=7&t=welcome-back&e=${mail.sendId}`;
    expect(mail.headers).toEqual({
      'X-Other': 'kept',
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(mail.html).toBe(`<p><a href="${url}">unsubscribe</a></p>`);
  });

  it('transactional mail gets no List-Unsubscribe of its own', async () => {
    vi.mocked(sendEmail).mockClear();
    const template = createEmail({
      template: 'receipt',
      mailClass: 'transactional',
      header: (data: { to: string }) => ({ subject: 'S', to: data.to }),
      html: () => '<p>Hi</p>',
    });
    await template.send({ to: 'a@example.com' });
    expect(vi.mocked(sendEmail).mock.calls[0]![0].headers).toEqual({});
  });

  it('sends with the send id the caller gives, for links it built itself', async () => {
    vi.mocked(sendEmail).mockClear();
    const template = createEmail({
      template: 'receipt',
      mailClass: 'transactional',
      header: (data: { to: string }) => ({ subject: 'S', to: data.to }),
      html: () => '<p><a href="/models/1">x</a></p>',
    });
    const sendId = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    await template.send({ to: 'a@example.com' }, { userId: 3 }, { sendId });
    const mail = vi.mocked(sendEmail).mock.calls[0]![0];
    expect(mail.sendId).toBe(sendId);
    // The tracked link carries the same id.
    expect(mail.html).toContain(`e=${sendId}`);
  });
});
