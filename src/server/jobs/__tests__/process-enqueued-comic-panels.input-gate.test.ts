import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** The queued comic panel job re-checks its stored reference images before it submits. */

const h = vi.hoisted(() => ({
  submitPresetImageGen: vi.fn(async () => ({ id: 'wf-1' })),
  auditPromptServer: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
}));

vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn(async () => null),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));
vi.mock('~/server/services/orchestrator/queue-limits', () => ({
  getUserQueueStatus: vi.fn(async () => ({ canGenerate: true, available: 5, used: 0, limit: 5 })),
}));
vi.mock('~/server/services/orchestrator/preset-image-gen.service', () => ({
  findPresetModelConfigByVersionId: vi.fn(() => ({ key: 'model' })),
  submitPresetImageGen: h.submitPresetImageGen,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: h.auditPromptServer,
}));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn(async () => undefined) },
}));

import { processEnqueuedComicPanelsJob } from '~/server/jobs/process-enqueued-comic-panels';
import { GENERATION_IMAGE_UNAVAILABLE_MESSAGE } from '~/server/services/generation-input-urls';
import { ComicPanelStatus } from '~/shared/utils/prisma/enums';
import { TRPCError } from '@trpc/server';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

const OWNER = 5;
const OTHER_USER = 7;
const KEY = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const CDN = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${KEY}/original=true`;

type Panel = { id: number; status: ComicPanelStatus; errorMessage?: string };
let panels: Panel[];

function givenPanel(url: string, owner: Record<string, unknown> = {}, count = 1) {
  panels = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    status: ComicPanelStatus.Enqueued,
  }));
  dbMock.dbRead.comicPanel.findMany.mockImplementation((async () =>
    panels
      .filter((p) => p.status === ComicPanelStatus.Enqueued)
      .map((p) => ({
        ...p,
        projectId: 1,
        metadata: {
          generationParams: { prompt: 'a cat', checkpointVersionId: 1 },
          referenceImages: [{ url, width: 512, height: 512 }],
        },
        chapter: {
          project: {
            userId: OWNER,
            user: {
              id: OWNER,
              deletedAt: null,
              bannedAt: null,
              muted: false,
              isModerator: false,
              ...owner,
            },
          },
        },
      }))) as never);
  dbMock.dbWrite.comicPanel.update.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: number };
    data: Partial<Panel>;
  }) => {
    const panel = panels.find((p) => p.id === where.id)!;
    Object.assign(panel, data);
    return panel;
  }) as never);
}

/** The image row the gate reads for KEY, owned as given and not publicly visible. */
function givenPrivateImageOf(owner: number) {
  dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
    strings.join('').includes('FROM "Image" i')
      ? [{ url: KEY, userId: owner, visible: false, blocked: false }]
      : []) as never);
}

const run = () => processEnqueuedComicPanelsJob.run({}).result;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockReset();
});

describe('process-enqueued-comic-panels: reference image re-check', () => {
  it("fails the panel with the generic message when a reference is another user's private image", async () => {
    givenPanel(CDN);
    givenPrivateImageOf(OTHER_USER);
    await run();
    expect(panels[0]).toMatchObject({
      status: ComicPanelStatus.Failed,
      errorMessage: GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
    });
    expect(h.submitPresetImageGen).not.toHaveBeenCalled();
    expect(h.auditPromptServer).not.toHaveBeenCalled();
  });

  it('leaves a refused panel in a status the job never selects again', async () => {
    givenPanel(CDN);
    givenPrivateImageOf(OTHER_USER);
    await run();
    const [{ where }] = dbMock.dbRead.comicPanel.findMany.mock.calls[0] as [
      { where: { status: ComicPanelStatus } }
    ];
    expect(where).toEqual({ status: ComicPanelStatus.Enqueued });
    expect(panels[0].status).not.toBe(where.status);
    expect(dbMock.dbWrite.comicPanel.update).toHaveBeenCalledTimes(1);
  });

  it('submits nothing when the image check itself fails', async () => {
    givenPanel(CDN);
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('db down'));
    await run();
    expect(h.submitPresetImageGen).not.toHaveBeenCalled();
    expect(panels[0].status).toBe(ComicPanelStatus.Failed);
  });

  it("POSITIVE CONTROL: the owner's own image is submitted", async () => {
    givenPanel(CDN);
    givenPrivateImageOf(OWNER);
    await run();
    expect(h.submitPresetImageGen).toHaveBeenCalledTimes(1);
    expect(panels[0].status).toBe(ComicPanelStatus.Generating);
  });
});

describe('process-enqueued-comic-panels: account restriction', () => {
  it("fails a muted owner's queued panel without submitting it", async () => {
    givenPanel(CDN, { muted: true });
    givenPrivateImageOf(OWNER);
    await run();
    expect(panels[0]).toMatchObject({
      status: ComicPanelStatus.Failed,
      errorMessage: 'User account is restricted',
    });
    expect(h.submitPresetImageGen).not.toHaveBeenCalled();
  });
});

/**
 * The pre-submit prompt audit's retry-able 503 (the external classifier unavailable, or the audit's
 * own reads failing) means nothing judged the prompt. The panel stays Enqueued so the next run
 * retries it, rather than being Failed with the outage's message; the rest of the run stops.
 */
describe('process-enqueued-comic-panels: prompt check unavailable', () => {
  const unavailable = () =>
    new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'The prompt check is temporarily unavailable. Please try again in a moment.',
    });

  beforeEach(() => resetEnv());

  it('leaves the panel Enqueued, submits nothing, and stops the run', async () => {
    givenPanel(CDN, {}, 3);
    // Panel 3 belongs to another user, so stopping "the run" is pinned past this user's loop.
    const ownPanels = dbMock.dbRead.comicPanel.findMany.getMockImplementation()!;
    dbMock.dbRead.comicPanel.findMany.mockImplementation((async (...a: unknown[]) =>
      (
        (await (ownPanels as (...x: unknown[]) => Promise<unknown[]>)(...a)) as Array<{
          id: number;
          chapter: { project: { userId: number; user: { id: number } } };
        }>
      ).map((p) =>
        p.id === 3
          ? {
              ...p,
              chapter: {
                project: {
                  ...p.chapter.project,
                  userId: OTHER_USER,
                  user: { ...p.chapter.project.user, id: OTHER_USER },
                },
              },
            }
          : p
      )) as never);
    dbMock.dbWrite.$queryRaw.mockImplementation((async () => []) as never);
    h.auditPromptServer.mockRejectedValueOnce(unavailable());
    await run();
    expect(panels.map((p) => p.status)).toEqual([
      ComicPanelStatus.Enqueued,
      ComicPanelStatus.Enqueued,
      ComicPanelStatus.Enqueued,
    ]);
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
    expect(h.submitPresetImageGen).not.toHaveBeenCalled();
    expect(h.auditPromptServer).toHaveBeenCalledTimes(1);
  });

  it('PROMPT_CHECK_FAIL_CLOSED off: the panel is Failed, as before', async () => {
    setEnv({ PROMPT_CHECK_FAIL_CLOSED: false });
    givenPanel(CDN);
    givenPrivateImageOf(OWNER);
    h.auditPromptServer.mockRejectedValueOnce(unavailable());
    await run();
    expect(panels[0].status).toBe(ComicPanelStatus.Failed);
    expect(h.submitPresetImageGen).not.toHaveBeenCalled();
  });

  it('CONTROL: a content refusal still fails the panel', async () => {
    givenPanel(CDN);
    givenPrivateImageOf(OWNER);
    h.auditPromptServer.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Your prompt was flagged' })
    );
    await run();
    expect(panels[0]).toMatchObject({
      status: ComicPanelStatus.Failed,
      errorMessage: 'Job processing failed: Your prompt was flagged',
    });
  });
});
