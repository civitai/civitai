import { describe, expect, it, vi } from 'vitest';

/**
 * The SEAM between the text scan and the content-level rater: the `AppDoc` entity type is
 * registered (mode list, profile, live and shadow adapters), a live verdict reaches
 * `applyAppDocTextScan` with what the callback hands it, and the profile loads documents through
 * `loadAppDocSubjects`. The rater's own suite calls `applyAppDocTextScan` directly, so without this
 * a dropped registration would leave every verdict unapplied while every rater test stayed green.
 */

const h = vi.hoisted(() => ({
  applied: [] as unknown[],
  loaded: [] as number[][],
}));

vi.mock('~/server/services/apps/doc-rater.service', () => ({
  applyAppDocTextScan: async (args: unknown) => {
    h.applied.push(args);
    return { status: 'rated', level: 2 };
  },
}));
vi.mock('~/server/services/apps/doc-rater-subject', () => ({
  loadAppDocSubjects: async (ids: number[]) => {
    h.loaded.push(ids);
    return new Map([[ids[0], { fields: [{ heading: 'h', text: 't' }], declared: {} }]]);
  },
}));

const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { getTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { TEXT_SCAN_ENTITY_TYPES } = await import('~/server/services/text-scan/mode');

describe('AppDoc is wired into the text scan', () => {
  it('is a text-scan entity type with a live and a shadow adapter', () => {
    expect(TEXT_SCAN_ENTITY_TYPES).toContain('AppDoc');
    expect(getModerationAdapter('AppDoc')?.applyTextScan).toEqual(expect.any(Function));
    expect(getModerationAdapter('AppDoc:shadow')).toBeDefined();
  });

  it('🔴 a live verdict reaches the rater with the outcome, the loaded subject and the scanned hash', async () => {
    const outcome = { nsfwLevel: 4, triggeredLabels: [] };
    const subject = { fields: [{ heading: 'h', text: 'x' }], declared: {} };
    await getModerationAdapter('AppDoc')!.applyTextScan!({
      entityId: 41,
      workflowId: 'wf',
      outcome: outcome as never,
      subject: subject as never,
      textHash: 'hash-of-scanned-text',
    });
    expect(h.applied).toEqual([{ outcome, subject, textHash: 'hash-of-scanned-text' }]);
  });

  it('the profile scans nsfw only and loads documents by rating id', async () => {
    const profile = getTextScanProfile('AppDoc')!;
    expect(profile.labels).toEqual(['nsfw']);
    const subjects = await profile.load([77]);
    expect(h.loaded).toEqual([[77]]);
    expect(subjects.get(77)).toBeDefined();
  });
});
