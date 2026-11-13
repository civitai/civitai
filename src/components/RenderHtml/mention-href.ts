const STORED_ID = /^mention:(\d{1,10})$/;

export function mentionUserId(dataId: string | null | undefined) {
  const id = STORED_ID.exec(dataId ?? '')?.[1];
  return id ? Number(id) : null;
}

/** Stored ids survive a rename; the label is only a snapshot of the name at write time. */
export function mentionHref({ id, label }: { id?: string | null; label?: string | null }) {
  const userId = mentionUserId(id);
  if (userId) return `/user-link/${userId}`;
  return `/user/${encodeURIComponent(label ?? id ?? '')}`;
}
