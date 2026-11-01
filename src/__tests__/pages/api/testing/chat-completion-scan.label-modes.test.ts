import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';

vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  setTextScanLabelMode: vi.fn(),
}));

const { default: handler } = await import('~/pages/api/testing/chat-completion-scan');
const { setTextScanLabelMode } = await import('~/server/services/text-scan/prompt');

function call(body: unknown) {
  let status = 0;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    send: (data: unknown) => ((payload = data), res),
    setHeader: () => res,
    end: () => res,
  };
  const req = { method: 'POST', query: { token: 'test-webhook-token' }, headers: {}, body };
  return handler(req as never, res as never).then(() => ({ status, payload }));
}

describe('putLabelModes on the unattributed testing route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is refused and points at the attributed endpoint, whatever moderator id the body names', async () => {
    const res = await call({
      action: 'putLabelModes',
      label: 'minor',
      mode: 'review',
      moderatorId: 5,
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.payload)).toContain('/api/mod/text-scan');
    expect(setTextScanLabelMode).not.toHaveBeenCalled();
  });
});
