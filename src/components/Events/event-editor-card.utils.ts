type EditorCardHat = { placedOn: { entityType: string; entityId: number } | null };

export type EditorHatState<T extends EditorCardHat> =
  | { kind: 'join' }
  | { kind: 'add' }
  | { kind: 'worn'; hat: T };

/**
 * What an editor's event card offers for this content, from the viewer's own hats. With none yet
 * it is `join`: the picker's join flow gets them one.
 */
export function editorHatState<T extends EditorCardHat>(
  hats: T[],
  entity: { entityType: string; entityId: number }
): EditorHatState<T> {
  const worn = hats.find(
    (h) => h.placedOn?.entityType === entity.entityType && h.placedOn.entityId === entity.entityId
  );
  if (worn) return { kind: 'worn', hat: worn };
  return hats.length ? { kind: 'add' } : { kind: 'join' };
}
