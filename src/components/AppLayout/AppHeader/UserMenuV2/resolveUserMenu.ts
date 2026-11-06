import type { UserMenuItem } from '~/components/AppLayout/AppHeader/hooks';
import type { UserMenuGroupNode, UserMenuNode } from './user-menu.layout';
import type { UserMenuItemId } from '~/shared/constants/user-menu.constants';

export type UserMenuRegistry = Partial<Record<UserMenuItemId, UserMenuItem>>;
/** `badgeMuted`: the viewer muted this row's count, so it still shows but no longer adds up. */
export type ResolvedMenuItem = UserMenuItem & { id: UserMenuItemId; badgeMuted?: boolean };
export type ResolvedMenuNode =
  | { kind: 'item'; item: ResolvedMenuItem }
  | (Omit<UserMenuGroupNode, 'children'> & { children: ResolvedMenuNode[]; badge: number });

const UNPINNABLE: ReadonlySet<UserMenuItemId> = new Set(['sign-in']);
export const isPinnable = (id: UserMenuItemId) => !UNPINNABLE.has(id);

const isVisible = (item: UserMenuItem) => !('visible' in item) || !!item.visible;

const NONE_MUTED: ReadonlySet<UserMenuItemId> = new Set();

function lookup(
  registry: UserMenuRegistry,
  id: UserMenuItemId,
  muted: ReadonlySet<UserMenuItemId>
): ResolvedMenuItem | undefined {
  const entry = registry[id];
  if (!entry || !isVisible(entry)) return undefined;
  return muted.has(id) ? { ...entry, id, badgeMuted: true } : { ...entry, id };
}

function resolveNodes(
  nodes: UserMenuNode[],
  registry: UserMenuRegistry,
  muted: ReadonlySet<UserMenuItemId>
): ResolvedMenuNode[] {
  const resolved: ResolvedMenuNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'item') {
      const entry = lookup(registry, node.id, muted);
      if (entry) resolved.push({ kind: 'item', item: entry });
      continue;
    }
    const children = resolveNodes(node.children, registry, muted);
    if (!children.length) continue;
    resolved.push({ ...node, children, badge: sumBadges(children) });
  }
  return resolved;
}

function sumBadges(nodes: ResolvedMenuNode[]): number {
  return nodes.reduce(
    (total, node) =>
      total +
      (node.kind === 'group' ? node.badge : node.item.badgeMuted ? 0 : node.item.badge ?? 0),
    0
  );
}

/** A pin whose item is hidden or gone is skipped, not dropped: it stays in the saved list. */
export function resolveUserMenu(
  layout: UserMenuNode[],
  registry: UserMenuRegistry,
  pins: readonly UserMenuItemId[],
  muted: ReadonlySet<UserMenuItemId> = NONE_MUTED
) {
  const seen = new Set<UserMenuItemId>();
  const pinned: ResolvedMenuItem[] = [];
  for (const id of pins) {
    if (seen.has(id) || !isPinnable(id)) continue;
    seen.add(id);
    const entry = lookup(registry, id, muted);
    if (entry) pinned.push(entry);
  }
  return { pinned, nodes: resolveNodes(layout, registry, muted) };
}

export function countAttention(nodes: ResolvedMenuNode[]) {
  return sumBadges(nodes);
}

export function togglePin(pins: readonly UserMenuItemId[], id: UserMenuItemId): UserMenuItemId[] {
  if (pins.includes(id)) return pins.filter((x) => x !== id);
  return isPinnable(id) ? [...pins, id] : [...pins];
}

/** Operates on the saved list, so pins hidden from this viewer keep their relative order. */
export function movePin(
  pins: readonly UserMenuItemId[],
  id: UserMenuItemId,
  overId: UserMenuItemId
): UserMenuItemId[] {
  const from = pins.indexOf(id);
  const to = pins.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...pins];
  const next = [...pins];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
