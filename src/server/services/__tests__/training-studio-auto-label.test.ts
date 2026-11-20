import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The Studio's auto-label is free to the user: it must be submitted with the system client, and
 *  a poll must never hand one user another user's workflow. */

const orch = vi.hoisted(() => ({ submitWorkflow: vi.fn(), getWorkflow: vi.fn() }));
vi.mock('@civitai/orchestration-client', async () => ({
  ...(
    await import('~/server/services/orchestrator/__tests__/civitai-client.stub')
  ).civitaiClientStub(),
  submitWorkflow: orch.submitWorkflow,
  getWorkflow: orch.getWorkflow,
}));
vi.mock('~/server/services/orchestrator/client', () => ({
  internalOrchestratorClient: { system: true },
}));
const clientEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT: 'https://orchestration.civitai.com',
}));
vi.mock('~/env/client', () => ({ env: clientEnv }));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import {
  AUTO_LABEL_UNFINISHED,
  pollStudioAutoLabel,
  SENDS_PER_FAILED_ITEM,
  STUDIO_AUTO_LABEL_DAILY_ITEMS,
  submitStudioAutoLabel,
} from '~/server/services/training-studio-auto-label.service';

const counters = new Map<string, number>();
const quotaKey = () =>
  `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_DAILY}:7:${new Date().toISOString().slice(0, 10)}`;

const items = [
  { mediaUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/a.png', key: 'a.png' },
];

describe('Training Studio auto-label', () => {
  beforeEach(() => {
    orch.submitWorkflow.mockReset().mockResolvedValue({ data: { id: 'wf-1' } });
    orch.getWorkflow.mockReset();
    counters.clear();
    // The daily quota is on the cache cluster: SET NX EX + INCRBY in one single-key MULTI.
    redisMock.redis.multi.mockImplementation(() => {
      const queued: (() => unknown)[] = [];
      const chain = {
        set: (k: string, _v: string, opts?: { NX?: boolean }) => {
          queued.push(() => {
            if (opts?.NX && counters.has(k)) return null;
            counters.set(k, 0);
            return 'OK';
          });
          return chain;
        },
        incrBy: (k: string, n: number) => {
          queued.push(() => {
            counters.set(k, (counters.get(k) ?? 0) + n);
            return counters.get(k)!;
          });
          return chain;
        },
        exec: async () => queued.map((run) => run()),
      };
      return chain;
    });
    redisMock.redis.incrBy.mockImplementation((async (k: string, n: number) => {
      counters.set(k, (counters.get(k) ?? 0) + n);
      return counters.get(k)!;
    }) as never);
  });

  it('accepts the media URL a Studio upload returns (both surfaces share $lib/upload)', async () => {
    // The orchestrator answers the upload POST with a signed consumer-blob URL on its public host.
    const uploaded =
      'https://orchestration.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5-0.jpeg?sig=a1b2c3&exp=2026-11-08T19:00:00.0000000Z';
    await expect(
      submitStudioAutoLabel({
        userId: 7,
        mode: 'caption',
        media: 'image',
        items: [{ mediaUrl: uploaded, key: 'k' }],
      })
    ).resolves.toEqual({ workflowId: 'wf-1' });
    expect(orch.submitWorkflow.mock.calls[0][0].body.steps[0].input.mediaUrl).toBe(uploaded);
  });

  it('submits with the system client and stamps the submitting user', async () => {
    await expect(
      submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items })
    ).resolves.toEqual({ workflowId: 'wf-1' });
    const call = orch.submitWorkflow.mock.calls[0][0];
    expect(call.client).toEqual({ system: true });
    expect(call.body.metadata).toEqual({ kind: 'studio-auto-label', userId: 7 });
    expect(call.body.steps).toHaveLength(1);
    expect(call.body.steps[0]).toMatchObject({ $type: 'wdTagging', metadata: { key: 'a.png' } });
  });

  it('refuses a media URL that is not public HTTPS before submitting', async () => {
    await expect(
      submitStudioAutoLabel({
        userId: 7,
        mode: 'tag',
        media: 'image',
        items: [{ mediaUrl: 'https://127.0.0.1/a.png', key: 'a' }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(orch.submitWorkflow).not.toHaveBeenCalled();
  });

  describe('only accepts media on Civitai media hosts', () => {
    const submitOne = (mediaUrl: string, media: 'image' | 'video' | 'audio' = 'image') =>
      submitStudioAutoLabel({
        userId: 7,
        mode: media === 'audio' ? 'caption' : 'tag',
        media,
        items: [{ mediaUrl, key: 'k' }],
      });

    it.each([
      ['a third-party host', 'https://example.com/a.png'],
      ['a lookalike suffix', 'https://orchestration.civitai.com.evil.net/v2/consumer/blobs/a.png'],
      ['civitai.com as a subdomain', 'https://civitai.com.evil.net/v2/consumer/blobs/a.png'],
      ['a prefixed lookalike', 'https://evil-orchestration.civitai.com/v2/consumer/blobs/a.png'],
      ['a hyphen lookalike', 'https://orchestration-civitai.com/v2/consumer/blobs/a.png'],
      ['an unlisted orchestration* host', 'https://orchestration-dashboard-new.civitai.com/a.png'],
      ['the region proxy host', 'https://orchestration-proxy.civitai.com/v2/consumer/blobs/a.png'],
      ['a non-media Civitai host', 'https://image.civitai.com/v2/consumer/blobs/a.png'],
      ['the main site', 'https://civitai.com/v2/consumer/blobs/a.png'],
      ['a port', 'https://orchestration.civitai.com:8443/v2/consumer/blobs/a.png'],
      [
        'the default port spelled out',
        'https://orchestration.civitai.com:443/v2/consumer/blobs/a.png',
      ],
      ['a backslash', 'https://orchestration.civitai.com\\v2/consumer/blobs/a.png'],
      ['a CRLF', 'https://orchestration\r\n.civitai.com/v2/consumer/blobs/a.png'],
      [
        'a percent-encoded dot in the host',
        'https://orchestration%2Ecivitai.com/v2/consumer/blobs/a.png',
      ],
      ['an ideographic full stop', 'https://orchestration。civitai.com/v2/consumer/blobs/a.png'],
      ['fullwidth letters', 'https://ｏrchestration.civitai.com/v2/consumer/blobs/a.png'],
      ['an uppercase host', 'https://ORCHESTRATION.civitai.com/v2/consumer/blobs/a.png'],
      ['@ in the query', 'https://orchestration.civitai.com/v2/consumer/blobs/a.png?@evil.com'],
      ['@ in the fragment', 'https://orchestration.civitai.com/v2/consumer/blobs/a.png#@evil.com'],
      ['a fragment', 'https://orchestration.civitai.com/v2/consumer/blobs/a.png#x'],
      ['a trailing space', 'https://orchestration.civitai.com/v2/consumer/blobs/a.png '],
      ['no path', 'https://orchestration.civitai.com'],
    ])('refuses %s before submitting', async (_label, mediaUrl) => {
      await expect(submitOne(mediaUrl)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(orch.submitWorkflow).not.toHaveBeenCalled();
    });

    // Already refused before the host check existed (HTTPS refine / assertSafeMediaUrls); kept so a
    // change to either doesn't quietly reopen them.
    it.each([
      ['userinfo', 'https://x@orchestration.civitai.com/v2/consumer/blobs/a.png'],
      ['http', 'http://orchestration.civitai.com/v2/consumer/blobs/a.png'],
      ['a blob: URL', 'blob:https://civitai.com/0b5f-4c1e'],
    ])('regression guard: refuses %s', async (_label, mediaUrl) => {
      await expect(submitOne(mediaUrl)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(orch.submitWorkflow).not.toHaveBeenCalled();
    });

    it('rejects with a message telling the user to upload the file', async () => {
      await expect(submitOne('https://example.com/a.png')).rejects.toThrow(
        /only accepts media uploaded to Civitai/
      );
    });

    it('refuses the whole batch when one item is off-host', async () => {
      await expect(
        submitStudioAutoLabel({
          userId: 7,
          mode: 'tag',
          media: 'image',
          items: [
            { mediaUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/a.png', key: 'a' },
            { mediaUrl: 'https://example.com/b.png', key: 'b' },
          ],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(orch.submitWorkflow).not.toHaveBeenCalled();
    });

    it.each([
      ['image', 'https://orchestration.civitai.com/v2/consumer/blobs/a.png?sig=s&exp=e'],
      ['image', 'https://orchestration-new.civitai.com/v2/consumer/blobs/a.jpeg'],
      ['image', 'https://orchestration-next.civitai.com/v1/consumer/blobs/a.webp?sig=s'],
      [
        'image',
        'https://orchestration.civitai.com/v2/consumer/blobs/a.jpeg?sig=x&exp=2030-01-01T00:00:00Z',
      ],
      ['video', 'https://orchestration.civitai.com/v2/consumer/blobs/a.mp4?sig=s&exp=e'],
      ['audio', 'https://orchestration.civitai.com/v2/consumer/blobs/a.mp3?sig=s&exp=e'],
    ] as const)('accepts %s at %s', async (media, mediaUrl) => {
      await expect(submitOne(mediaUrl, media)).resolves.toEqual({ workflowId: 'wf-1' });
      expect(orch.submitWorkflow.mock.calls[0][0].body.steps[0].input.mediaUrl).toBe(mediaUrl);
    });

    // The orchestrator's presigned blob URL: sig is Uri.EscapeDataString'd, exp is ISO 8601 "O".
    it('accepts a presigned upload URL exactly as the orchestrator builds it', async () => {
      const mediaUrl =
        'https://orchestration.civitai.com/v2/consumer/blobs/K7Q2M9X4ZP8B?sig=aB3%2Bx9%2FQz7%3D%3D&exp=2026-10-27T23:40:00.1234567Z';
      await expect(submitOne(mediaUrl)).resolves.toEqual({ workflowId: 'wf-1' });
      expect(orch.submitWorkflow.mock.calls[0][0].body.steps[0].input.mediaUrl).toBe(mediaUrl);
    });

    it("accepts the env's public orchestrator host when it is not orchestration*.civitai.com", async () => {
      clientEnv.NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT = 'https://orch.dev.example.net/';
      try {
        await expect(
          submitOne('https://orch.dev.example.net/v2/consumer/blobs/a.png')
        ).resolves.toEqual({ workflowId: 'wf-1' });
        await expect(
          submitOne('https://orch.dev.example.net:8443/v2/consumer/blobs/a.png')
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      } finally {
        clientEnv.NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT = 'https://orchestration.civitai.com';
      }
    });
  });

  it("reads another user's workflow as missing", async () => {
    orch.getWorkflow.mockResolvedValue({
      data: { id: 'wf-1', status: 'succeeded', metadata: { kind: 'studio-auto-label', userId: 8 } },
    });
    await expect(pollStudioAutoLabel({ userId: 7, workflowId: 'wf-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('maps an owned workflow to per-key results', async () => {
    orch.getWorkflow.mockResolvedValue({
      data: {
        id: 'wf-1',
        status: 'succeeded',
        metadata: { kind: 'studio-auto-label', userId: 7 },
        steps: [
          {
            status: 'succeeded',
            metadata: { key: 'a.png' },
            output: { tags: { cat: 0.4, dog: 0.9 } },
          },
        ],
      },
    });
    await expect(pollStudioAutoLabel({ userId: 7, workflowId: 'wf-1' })).resolves.toEqual({
      done: true,
      results: [{ key: 'a.png', status: 'succeeded', tags: ['dog', 'cat'] }],
    });
  });

  it('marks every failed or expired step retryable, with a reason, but not a canceled one', async () => {
    // The real shape of a step turned away at scheduling: startedAt set, no error on the step.
    const startedAt = '2026-11-20T14:00:27Z';
    orch.getWorkflow.mockResolvedValue({
      data: {
        id: 'wf-1',
        status: 'failed',
        metadata: { kind: 'studio-auto-label', userId: 7 },
        steps: [
          { name: '0', status: 'failed', startedAt, metadata: { key: 'refused' } },
          { name: '1', status: 'expired', startedAt, metadata: { key: 'expired' } },
          { name: '2', status: 'canceled', startedAt, metadata: { key: 'canceled' } },
        ],
      },
    });
    const { results } = await pollStudioAutoLabel({ userId: 7, workflowId: 'wf-1' });
    expect(results).toEqual([
      { key: 'refused', status: 'failed', error: AUTO_LABEL_UNFINISHED, retryable: true },
      { key: 'expired', status: 'failed', error: AUTO_LABEL_UNFINISHED, retryable: true },
      { key: 'canceled', status: 'failed', error: AUTO_LABEL_UNFINISHED },
    ]);
  });

  it("refuses a batch past the user's daily item quota, and doesn't count it", async () => {
    counters.set(quotaKey(), STUDIO_AUTO_LABEL_DAILY_ITEMS - 1);
    const two = [
      { mediaUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/a.png', key: 'a' },
      { mediaUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/b.png', key: 'b' },
    ];
    await expect(
      submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items: two })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(orch.submitWorkflow).not.toHaveBeenCalled();
    expect(counters.get(quotaKey())).toBe(STUDIO_AUTO_LABEL_DAILY_ITEMS - 1);
    // One more item still fits.
    await submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items });
    expect(orch.submitWorkflow).toHaveBeenCalledTimes(1);
  });

  describe('failed items give their daily quota back', () => {
    const today = () => new Date().toISOString().slice(0, 10);
    const sets = new Map<string, Set<string>>();
    const strings = new Map<string, string>();
    const record = (wf: string, r: { userId: number; day: string; count: number }) =>
      strings.set(`${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_SUBMITTED}:${wf}`, JSON.stringify(r));
    beforeEach(() => {
      sets.clear();
      strings.clear();
      redisMock.redis.sAdd.mockImplementation((async (k: string, m: string | string[]) => {
        const set = sets.get(k) ?? new Set<string>();
        sets.set(k, set);
        let added = 0;
        for (const v of Array.isArray(m) ? m : [m]) if (!set.has(v) && set.add(v)) added++;
        return added;
      }) as never);
      redisMock.redis.set.mockImplementation((async (k: string, v: string) => {
        strings.set(k, v);
        return 'OK';
      }) as never);
      redisMock.redis.get.mockImplementation(
        (async (k: string) => strings.get(k) ?? null) as never
      );
      redisMock.redis.incrBy.mockImplementation((async (k: string, n: number) => {
        counters.set(k, (counters.get(k) ?? 0) + n);
        return counters.get(k)!;
      }) as never);
    });
    // Every failed step carries startedAt, refused at scheduling or not.
    const workflow = (steps: { name: string; status: string }[]) => ({
      data: {
        id: 'wf-q',
        status: 'failed',
        metadata: { kind: 'studio-auto-label', userId: 7 },
        steps: steps.map((s) => ({
          startedAt: '2026-11-20T00:00:00Z',
          ...s,
          metadata: { key: `k${s.name}` },
        })),
      },
    });
    const failed = (n: number) =>
      workflow(Array.from({ length: n }, (_, i) => ({ name: String(i), status: 'failed' })));

    it('releases one item per failed step, once, however often it is polled', async () => {
      counters.set(quotaKey(), 3);
      record('wf-q', { userId: 7, day: today(), count: 3 });
      orch.getWorkflow.mockResolvedValue(
        workflow([
          { name: '0', status: 'succeeded' },
          { name: '1', status: 'failed' },
          { name: '2', status: 'expired' },
        ])
      );
      await pollStudioAutoLabel({ userId: 7, workflowId: 'wf-q' });
      await pollStudioAutoLabel({ userId: 7, workflowId: 'wf-q' });
      expect(counters.get(quotaKey())).toBe(1);
    });

    it('records what the submit counted, so its poll can give failed items back', async () => {
      orch.submitWorkflow.mockResolvedValue({ data: { id: 'wf-q' } });
      await submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items });
      expect(counters.get(quotaKey())).toBe(1);
      orch.getWorkflow.mockResolvedValue(failed(1));
      await pollStudioAutoLabel({ userId: 7, workflowId: 'wf-q' });
      expect(counters.get(quotaKey())).toBe(0);
    });

    // A user can submit a workflow with this metadata on their own orchestrator token: only the
    // server's submit record may release quota, and never more than it counted.
    it('gives nothing back for a workflow this service did not submit, or beyond its count', async () => {
      counters.set(quotaKey(), 3);
      orch.getWorkflow.mockResolvedValue(failed(5));
      await pollStudioAutoLabel({ userId: 7, workflowId: 'wf-q' });
      expect(counters.get(quotaKey())).toBe(3);
      record('wf-q', { userId: 7, day: today(), count: 2 });
      await pollStudioAutoLabel({ userId: 7, workflowId: 'wf-q' });
      expect(counters.get(quotaKey())).toBe(1);
    });

    it('gives back at most four times the daily limit per day: past it, failed items stay counted', async () => {
      counters.set(quotaKey(), STUDIO_AUTO_LABEL_DAILY_ITEMS);
      counters.set(
        `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_RELEASED_DAILY}:7:${today()}`,
        STUDIO_AUTO_LABEL_DAILY_ITEMS * SENDS_PER_FAILED_ITEM - 1
      );
      record('wf-q', { userId: 7, day: today(), count: 2 });
      orch.getWorkflow.mockResolvedValue(failed(2));
      await pollStudioAutoLabel({ userId: 7, workflowId: 'wf-q' });
      expect(counters.get(quotaKey())).toBe(STUDIO_AUTO_LABEL_DAILY_ITEMS - 1);
    });

    it("allows as many give-backs per item as the Studio's sends of a failed item", () => {
      // Separate programs: read the Studio's resend delays from its source.
      const src = readFileSync('apps/training-studio/src/lib/autolabel.ts', 'utf8');
      const delays = /RESEND_DELAYS_MS = \[([^\]]*)\]/.exec(src)?.[1];
      expect(delays).toBeDefined();
      expect(delays!.split(',').filter((d) => d.trim()).length + 1).toBe(SENDS_PER_FAILED_ITEM);
    });

    it('an item that fails on every send leaves the quota where it started', async () => {
      counters.set(quotaKey(), 5);
      const one = [items[0]!];
      for (let send = 0; send < SENDS_PER_FAILED_ITEM; send++) {
        orch.submitWorkflow.mockResolvedValueOnce({ data: { id: `wf-s${send}` } });
        const { workflowId } = await submitStudioAutoLabel({
          userId: 7,
          mode: 'tag',
          media: 'image',
          items: one,
        });
        expect(counters.get(quotaKey())).toBe(6);
        orch.getWorkflow.mockResolvedValueOnce({
          data: {
            ...failed(1).data,
            id: workflowId,
          },
        });
        const { results } = await pollStudioAutoLabel({ userId: 7, workflowId });
        expect(results[0]).toMatchObject({ status: 'failed', retryable: true });
        expect(counters.get(quotaKey())).toBe(5);
      }
    });

    it("gives nothing back to today's quota for a workflow counted on another day or user", async () => {
      counters.set(quotaKey(), 3);
      orch.getWorkflow.mockResolvedValue(failed(1));
      record('wf-q', { userId: 7, day: '2026-01-01', count: 1 });
      await pollStudioAutoLabel({ userId: 7, workflowId: 'wf-q' });
      record('wf-q', { userId: 8, day: today(), count: 1 });
      await pollStudioAutoLabel({ userId: 7, workflowId: 'wf-q' });
      // A decrement on an expired day's key would leave a negative counter with no TTL.
      expect([...counters.entries()]).toEqual([[quotaKey(), 3]]);
    });

    it('still answers the poll when the release bookkeeping fails', async () => {
      record('wf-q', { userId: 7, day: today(), count: 1 });
      redisMock.redis.sAdd.mockRejectedValue(new Error('redis down'));
      orch.getWorkflow.mockResolvedValue(failed(1));
      counters.set(quotaKey(), 1);
      await expect(pollStudioAutoLabel({ userId: 7, workflowId: 'wf-q' })).resolves.toMatchObject({
        results: [{ key: 'k0', status: 'failed' }],
      });
      // Nothing is given back unless the step was marked first, so a retry can't give it twice.
      expect(counters.get(quotaKey())).toBe(1);
    });

    it('gives every key it writes an expiry, even when the give-back itself fails', async () => {
      // The shared mock keeps call history across tests: count only this poll's expiries.
      redisMock.redis.expire.mockClear();
      record('wf-q', { userId: 7, day: today(), count: 1 });
      redisMock.redis.multi.mockImplementationOnce(() => {
        const chain = {
          set: () => chain,
          incrBy: () => chain,
          exec: async () => {
            throw new Error('cluster down');
          },
        };
        return chain;
      });
      orch.getWorkflow.mockResolvedValue(failed(1));
      await pollStudioAutoLabel({ userId: 7, workflowId: 'wf-q' });
      const expired = redisMock.redis.expire.mock.calls.map((c) => c[0]);
      expect(expired).toContain(`${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_RELEASED}:wf-q`);
      expect(expired).toContain(
        `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_RELEASED_DAILY}:7:${today()}`
      );

      orch.submitWorkflow.mockResolvedValue({ data: { id: 'wf-r' } });
      await submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items });
      expect(redisMock.redis.set).toHaveBeenLastCalledWith(
        `${REDIS_KEYS.TRAINING.STUDIO_AUTO_LABEL_SUBMITTED}:wf-r`,
        expect.any(String),
        { EX: expect.any(Number) }
      );
    });

    it('still returns the workflow when the submit record cannot be written', async () => {
      redisMock.redis.set.mockRejectedValue(new Error('redis down'));
      await expect(
        submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items })
      ).resolves.toEqual({ workflowId: 'wf-1' });
    });
  });

  it('gives the items back when the submit fails', async () => {
    orch.submitWorkflow.mockResolvedValue({ data: undefined, error: { status: 500 } });
    await expect(
      submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items })
    ).rejects.toBeDefined();
    expect(counters.get(quotaKey())).toBe(0);
  });
});
