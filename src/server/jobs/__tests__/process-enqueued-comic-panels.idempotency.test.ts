import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A queued panel the job submitted but could not mark Generating stays Enqueued, and the next run
 * picks it up again. Its second submit must be answered with the first workflow, not a second,
 * charged one. The fake orchestrator below does what the orchestrator's client documents: a submit
 * whose (user, externalId) already exists returns the existing workflow; a submit without one gets
 * a fresh random key (as `generateFromGraph` mints it), so it is always a new workflow.
 */

type Submit = { user: { id: number }; externalId?: string };

const h = vi.hoisted(() => ({
  workflows: new Map<string, { id: string }>(),
  created: 0,
  submitPresetImageGen: vi.fn(),
}));

vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async () => ({ tier: undefined })) },
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
  auditPromptServer: vi.fn(async () => undefined),
}));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn(async () => undefined) },
}));

import {
  comicPanelExternalId,
  processEnqueuedComicPanelsJob,
} from '~/server/jobs/process-enqueued-comic-panels';
import { ComicPanelStatus } from '~/shared/utils/prisma/enums';

const OWNER = 5;
// Pairwise distinct, and distinct from anything the key's literal part could produce.
const PANEL_IDS = [41, 907];

type Panel = { id: number; status: ComicPanelStatus; workflowId?: string };
let panels: Panel[];

function givenPanels(ids: number[]) {
  panels = ids.map((id) => ({ id, status: ComicPanelStatus.Enqueued }));
  dbMock.dbRead.comicPanel.findMany.mockImplementation((async () =>
    panels
      .filter((p) => p.status === ComicPanelStatus.Enqueued)
      .map((p) => ({
        ...p,
        projectId: 1,
        metadata: { generationParams: { prompt: 'a cat', checkpointVersionId: 1 } },
        chapter: {
          project: {
            userId: OWNER,
            user: { id: OWNER, deletedAt: null, bannedAt: null, muted: false, isModerator: false },
          },
        },
      }))) as never);
}

/** Every panel write succeeds, except that the first `failures` writes reject (a DB blip). */
function givenWrites({ failures = 0 } = {}) {
  let remaining = failures;
  dbMock.dbWrite.comicPanel.update.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: number };
    data: Partial<Panel>;
  }) => {
    if (remaining > 0) {
      remaining--;
      throw new Error('db blip');
    }
    const panel = panels.find((p) => p.id === where.id)!;
    Object.assign(panel, data);
    return panel;
  }) as never);
}

const run = () => processEnqueuedComicPanelsJob.run({}).result;
const submittedKeys = () =>
  (h.submitPresetImageGen.mock.calls as [Submit][]).map(([args]) => args.externalId);

beforeEach(() => {
  vi.clearAllMocks();
  h.workflows.clear();
  h.created = 0;
  h.submitPresetImageGen.mockImplementation(async ({ user, externalId }: Submit) => {
    const key = `${user.id}:${externalId || randomUUID()}`;
    const existing = h.workflows.get(key);
    if (existing) return existing;
    h.created++;
    const workflow = { id: `wf-${h.created}` };
    h.workflows.set(key, workflow);
    return workflow;
  });
});

describe('process-enqueued-comic-panels: a resubmitted panel is not charged twice', () => {
  it('submit succeeds, both panel writes fail: the next run gets the same workflow back', async () => {
    givenPanels([PANEL_IDS[0]]);
    // The Generating write fails, then the Failed write in the catch fails too.
    givenWrites({ failures: 2 });
    await run();
    expect(h.created).toBe(1);
    expect(panels[0].status).toBe(ComicPanelStatus.Enqueued);

    givenWrites();
    await run();
    expect(h.submitPresetImageGen).toHaveBeenCalledTimes(2);
    expect(h.created).toBe(1);
    expect(panels[0]).toMatchObject({ status: ComicPanelStatus.Generating, workflowId: 'wf-1' });
  });

  it('sends a key the orchestrator accepts, derived from the panel id', async () => {
    givenPanels(PANEL_IDS);
    givenWrites();
    await run();
    expect(submittedKeys()).toEqual(['comic-panel-41', 'comic-panel-907']);
    for (const key of submittedKeys()) expect(key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(h.created).toBe(2);
  });

  it('CONTROL: two different panels are two workflows', async () => {
    givenPanels(PANEL_IDS);
    givenWrites();
    await run();
    expect(panels.map((p) => p.workflowId)).toEqual(['wf-1', 'wf-2']);
  });

  it('the key moves with the panel id', () => {
    expect(comicPanelExternalId(3)).not.toBe(comicPanelExternalId(4));
    expect(comicPanelExternalId(12)).toBe('comic-panel-12');
  });
});
