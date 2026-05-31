import { describe, expect, it } from 'vitest';
import { groupSubscriptionsByApp, type SubscriptionRecord } from '../groupSubscriptionsByApp';

/**
 * Pure unit tests for the /apps/installed one-row-per-app grouping. Node-env
 * vitest (no jsdom / RTL) — the consuming card UI in installed.tsx reduces to
 * "render whatever groupSubscriptionsByApp returns".
 */

function sub(
  partial: Partial<SubscriptionRecord> & {
    id: string;
    appBlockId: string;
    scope: SubscriptionRecord['scope'];
  }
): SubscriptionRecord {
  return {
    id: partial.id,
    scope: partial.scope,
    appBlockId: partial.appBlockId,
    blockId: partial.blockId ?? 'block',
    appId: partial.appId ?? 'app',
    targetModelTypes: partial.targetModelTypes ?? null,
    targetBaseModels: partial.targetBaseModels ?? null,
    targetModelIds: partial.targetModelIds ?? null,
    pinnedModelNames: partial.pinnedModelNames ?? null,
    slotId: partial.slotId ?? null,
    pinnedVersion: partial.pinnedVersion ?? null,
    blockInstanceId: partial.blockInstanceId ?? null,
    currentVersion: partial.currentVersion ?? null,
    availableVersions: partial.availableVersions ?? [],
    settings: partial.settings ?? {},
    enabled: partial.enabled ?? true,
    createdAt: partial.createdAt ?? (new Date() as never),
    updatedAt: partial.updatedAt ?? (new Date() as never),
    manifest: partial.manifest ?? { name: 'App' },
  } as SubscriptionRecord;
}

describe('groupSubscriptionsByApp', () => {
  it('returns empty array for empty input', () => {
    expect(groupSubscriptionsByApp([])).toEqual([]);
  });

  it('collapses both blanket surfaces of one app into ONE entry', () => {
    const result = groupSubscriptionsByApp([
      sub({
        id: 's_pub',
        appBlockId: 'apb_1',
        scope: 'publisher_all_my_models',
        manifest: { name: 'Solo' },
      }),
      sub({
        id: 's_view',
        appBlockId: 'apb_1',
        scope: 'viewer_personal',
        manifest: { name: 'Solo' },
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].appBlockId).toBe('apb_1');
    expect(result[0].blanketPublisher?.id).toBe('s_pub');
    expect(result[0].blanketViewer?.id).toBe('s_view');
    expect(result[0].pinned).toEqual([]);
  });

  it('routes pinned subs into pinned[] not the blanket slots', () => {
    const result = groupSubscriptionsByApp([
      sub({
        id: 's_pin',
        appBlockId: 'apb_1',
        scope: 'publisher_all_my_models',
        slotId: 'model.sidebar_top',
        targetModelIds: [42],
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].blanketPublisher).toBeUndefined();
    expect(result[0].blanketViewer).toBeUndefined();
    expect(result[0].pinned.map((p) => p.id)).toEqual(['s_pin']);
  });

  it('an app with ONLY pinned subs still produces an entry with empty blanket fields', () => {
    const result = groupSubscriptionsByApp([
      sub({
        id: 's_pin_b',
        appBlockId: 'apb_2',
        scope: 'viewer_personal',
        slotId: 'model.below_images',
        targetModelIds: [7],
      }),
      sub({
        id: 's_pin_a',
        appBlockId: 'apb_2',
        scope: 'publisher_all_my_models',
        slotId: 'model.sidebar_top',
        targetModelIds: [9],
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].blanketPublisher).toBeUndefined();
    expect(result[0].blanketViewer).toBeUndefined();
    // pinned[] sorted stable by id.
    expect(result[0].pinned.map((p) => p.id)).toEqual(['s_pin_a', 's_pin_b']);
  });

  it('sorts multiple apps by manifest.name case-insensitively', () => {
    const result = groupSubscriptionsByApp([
      sub({ id: 's1', appBlockId: 'apb_z', scope: 'viewer_personal', manifest: { name: 'zebra' } }),
      sub({ id: 's2', appBlockId: 'apb_a', scope: 'viewer_personal', manifest: { name: 'Apple' } }),
      sub({ id: 's3', appBlockId: 'apb_m', scope: 'viewer_personal', manifest: { name: 'mango' } }),
    ]);
    expect(result.map((g) => g.appBlockId)).toEqual(['apb_a', 'apb_m', 'apb_z']);
  });

  it('falls back to blockId for the sort key when manifest.name is absent', () => {
    const result = groupSubscriptionsByApp([
      sub({
        id: 's1',
        appBlockId: 'apb_1',
        blockId: 'zzz-block',
        scope: 'viewer_personal',
        manifest: {},
      }),
      sub({
        id: 's2',
        appBlockId: 'apb_2',
        blockId: 'aaa-block',
        scope: 'viewer_personal',
        manifest: {},
      }),
    ]);
    expect(result.map((g) => g.blockId)).toEqual(['aaa-block', 'zzz-block']);
  });
});
