import type { UserMenuItem } from '~/components/AppLayout/AppHeader/hooks';
import type { UserMenuGroupNode, UserMenuNode } from './user-menu.layout';
import type { UserMenuItemId } from '~/shared/constants/user-menu.constants';

export type UserMenuRegistry = Partial<Record<UserMenuItemId, UserMenuItem>>;
export type ResolvedMenuItem = UserMenuItem & { id: UserMenuItemId };
export type ResolvedMenuNode =
  | { kind: 'item'; item: ResolvedMenuItem }
  | (Omit<UserMenuGroupNode, 'children'> & { children: ResolvedMenuNode[]; badge: number });

const UNPINNABLE: ReadonlySet<UserMenuItemId> = new Set(['sign-in']);
export const isPinnable = (id: UserMenuItemId) => !UNPINNABLE.has(id);

const isVisible = (item: UserMenuItem) => !('visible' in item) || !!item.visible;

function lookup(registry: UserMenuRegistry, id: UserMenuItemId): ResolvedMenuItem | undefined {
  const entry = registry[id];
  return entry && isVisible(entry) ? { ...entry, id } : undefined;
}

function resolveNodes(nodes: UserMenuNode[], registry: UserMenuRegistry): ResolvedMenuNode[] {
  const resolved: ResolvedMenuNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'item') {
      const entry = lookup(registry, node.id);
      if (entry) resolved.push({ kind: 'item', item: entry });
      continue;
    }
    const children = resolveNodes(node.children, registry);
    if (!children.length) continue;
    resolved.push({ ...node, children, badge: sumBadges(children) });
  }
  return resolved;
}

function sumBadges(nodes: ResolvedMenuNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.kind === 'item' ? node.item.badge ?? 0 : node.badge),
    0
  );
}

/** A pin whose item is hidden or gone is skipped, not dropped: it stays in the saved list. */
export function resolveUserMenu(
  layout: UserMenuNode[],
  registry: UserMenuRegistry,
  pins: readonly UserMenuItemId[]
) {
  const seen = new Set<UserMenuItemId>();
  const pinned: ResolvedMenuItem[] = [];
  for (const id of pins) {
    if (seen.has(id) || !isPinnable(id)) continue;
    seen.add(id);
    const entry = lookup(registry, id);
    if (entry) pinned.push(entry);
  }
  return { pinned, nodes: resolveNodes(layout, registry) };
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
