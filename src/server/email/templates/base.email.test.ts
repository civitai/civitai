import { describe, expect, it, vi } from 'vitest';
import { sendEmail } from '~/server/email/client';
import { createEmail } from '~/server/email/templates/base.email';

vi.mock('~/server/email/client', () => ({ sendEmail: vi.fn() }));

// The first case is enforced by `pnpm run typecheck`, not by vitest: NoInfer is erased at
// transpile, so it passes at runtime either way. It lives OUTSIDE __tests__ deliberately —
// tsconfig excludes src/**/__tests__/**, so moving this file there disarms it silently.
describe('createEmail resolves T from the annotated params', () => {
  it('does not take testData as an inference site', () => {
    createEmail({
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
