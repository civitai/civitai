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
