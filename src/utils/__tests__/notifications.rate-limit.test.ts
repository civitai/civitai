// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MantineNotifications from '@mantine/notifications';
import { showErrorNotification } from '~/utils/notifications';

const showNotification = vi.hoisted(() => vi.fn());
vi.mock('@mantine/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineNotifications>()),
  showNotification,
}));

const rateLimit = { retryAfterSeconds: 900, retryAt: '2030-02-03T16:12:00.000Z' };

beforeEach(() => showNotification.mockClear());

describe('showErrorNotification', () => {
  it('adds the retry time to a rate-limited error', () => {
    showErrorNotification({
      error: Object.assign(new Error('Slow down.'), { data: { rateLimit } }),
    });
    expect(showNotification.mock.calls[0][0].message).toMatch(/^Slow down\. Try again at .+\.$/);
  });

  it('leaves any other error as its message', () => {
    showErrorNotification({ error: new Error('Nope.') });
    expect(showNotification.mock.calls[0][0].message).toBe('Nope.');
  });

  it('links a plan-limit refusal to the Usage limits pane', () => {
    showErrorNotification({
      error: Object.assign(new Error('Daily limit.'), {
        data: { rateLimit: { ...rateLimit, kind: 'product' } },
      }),
    });
    const message = showNotification.mock.calls[0][0].message as {
      props: { children: unknown[] };
    };
    const hrefs = message.props.children.map(
      (child) => (child as { props?: { href?: string } })?.props?.href
    );
    expect(hrefs).toContain('/user/account/usage');
  });
});
