import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The Studio's auto-label is free to the user: it must be submitted with the system client, and
 *  a poll must never hand one user another user's workflow. */

const orch = vi.hoisted(() => ({ submitWorkflow: vi.fn(), getWorkflow: vi.fn() }));
vi.mock('@civitai/orchestration-client', () => ({
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
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import {
  pollStudioAutoLabel,
  STUDIO_AUTO_LABEL_DAILY_ITEMS,
  submitStudioAutoLabel,
} from '~/server/services/training-studio-auto-label.service';

const counters = new Map<string, number>();
const quotaKey = () =>
  `${REDIS_SYS_KEYS.TRAINING.STUDIO_AUTO_LABEL_DAILY}:7:${new Date().toISOString().slice(0, 10)}`;

const items = [
  { mediaUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/a.png', key: 'a.png' },
];

describe('Training Studio auto-label', () => {
  beforeEach(() => {
    orch.submitWorkflow.mockReset().mockResolvedValue({ data: { id: 'wf-1' } });
    orch.getWorkflow.mockReset();
    counters.clear();
    redisMock.sysRedis.incrBy.mockImplementation(async (k: string, n: number) => {
      counters.set(k, (counters.get(k) ?? 0) + n);
      return counters.get(k)!;
    });
    redisMock.sysRedis.decrBy.mockImplementation(async (k: string, n: number) => {
      counters.set(k, (counters.get(k) ?? 0) - n);
      return counters.get(k)!;
    });
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

  it('gives the items back when the submit fails', async () => {
    orch.submitWorkflow.mockResolvedValue({ data: undefined, error: { status: 500 } });
    await expect(
      submitStudioAutoLabel({ userId: 7, mode: 'tag', media: 'image', items })
    ).rejects.toBeDefined();
    expect(counters.get(quotaKey())).toBe(0);
  });
});
