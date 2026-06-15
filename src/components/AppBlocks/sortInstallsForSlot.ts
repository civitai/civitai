/**
 * W8: ordering rule for multi-block tabs.
 *
 * When more than one block is installed on the same (modelId, slotId), the
 * UI renders them as Mantine Tabs. Tab order is:
 *   1. by manifest.targets[].priority DESC (where targets[].slotId === slotId)
 *   2. by manifest.name ASC as a stable tiebreaker
 *
 * Priority defaults to 0 when the manifest doesn't declare a `targets` entry
 * for the slot (or declares one without a priority field). Name defaults to
 * the blockInstanceId when missing — keeps the sort stable for malformed
 * manifests rather than producing undefined-vs-undefined NaN.
 *
 * Kept as a pure function so the ordering logic is exhaustively unit-tested
 * without dragging the React component into a DOM-renderer test.
 */
import type { BlockInstall } from './types';

export function priorityForSlot(install: BlockInstall, slotId: string): number {
  const manifest = install.manifest as { targets?: unknown };
  if (!Array.isArray(manifest.targets)) return 0;
  for (const target of manifest.targets) {
    if (!target || typeof target !== 'object') continue;
    const t = target as { slotId?: unknown; priority?: unknown };
    if (typeof t.slotId === 'string' && t.slotId === slotId) {
      return typeof t.priority === 'number' && Number.isFinite(t.priority) ? t.priority : 0;
    }
  }
  return 0;
}

export function tabLabelFor(install: BlockInstall): string {
  const name = install.manifest.name;
  return typeof name === 'string' && name.length > 0 ? name : install.blockInstanceId;
}

export function sortInstallsForSlot(installs: BlockInstall[], slotId: string): BlockInstall[] {
  // Array.prototype.sort isn't required to be stable in older runtimes; Node
  // 20 + V8 are stable, but be explicit in the comparator so the tiebreaker
  // is independent of the engine.
  const ranked = installs.map((install, index) => ({
    install,
    index,
    priority: priorityForSlot(install, slotId),
    name: tabLabelFor(install),
  }));
  ranked.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority; // priority desc
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp; // name asc
    return a.index - b.index; // stable fallback on the original order
  });
  return ranked.map((r) => r.install);
}
