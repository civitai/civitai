import { createHash, createHmac } from 'node:crypto';
import type { HookInput } from '../contract.ts';

export const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

export function sha256(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

export function hmac(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** A complete, valid hook input. Field values are pairwise distinct so a test can tell which one
 *  a hook read. */
export function hookInput(over: Partial<HookInput> = {}): HookInput {
  return {
    op: 'put',
    collection: 'cards',
    key: 'key-7f3a',
    before: { title: 'old title', locked: false },
    after: { title: 'new title', locked: false },
    doc: {
      version: 4,
      author: { kind: 'user', isViewer: true },
      counters: { likes: 3 },
      marks: {},
    },
    tally: null,
    viewer: { userId: 4242 },
    app: { blockId: 'app-storage-demo' },
    from: null,
    ...over,
  };
}

export function hookInputJson(over: Partial<HookInput> = {}): string {
  return JSON.stringify(hookInput(over));
}

/** A signed `POST /v1/check` body for `source`, with every top-level field consistent. */
export function checkBody(
  source: string,
  opts: { input?: Partial<HookInput>; ts?: number; timeoutMs?: number; sha256?: string } = {}
) {
  const input = hookInput(opts.input);
  return {
    ts: opts.ts ?? Math.floor(Date.now() / 1000),
    appId: input.app.blockId,
    collection: input.collection,
    op: input.op,
    sha256: opts.sha256 ?? sha256(source),
    source,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    input,
  };
}
