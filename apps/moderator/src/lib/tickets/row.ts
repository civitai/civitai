type Requester = { requesterName: string | null; civitaiUserId: number | null };

/** Who wrote in: the requester's name, else the linked account, else a plain "none". */
export function requesterLabel({ requesterName, civitaiUserId }: Requester): string {
  const name = requesterName?.trim();
  if (name) return name;
  return civitaiUserId ? `User #${civitaiUserId}` : 'No requester';
}

/** The label a list row shows: the ticket's feature, else the router's topic (`inferred`). */
export function rowChip(t: {
  cfFeature: string | null;
  routerTopic: string | null;
}): { label: string; inferred: boolean } | null {
  if (t.cfFeature) return { label: t.cfFeature, inferred: false };
  if (t.routerTopic) return { label: t.routerTopic, inferred: true };
  return null;
}

/** "Sent by alice", or just "Sent to support" when no moderator was recorded; null for any other ticket. */
export function sentByText(t: {
  sentToSupport: boolean;
  sentBy: { moderatorId: number | null; username: string | null } | null;
}): string | null {
  if (!t.sentToSupport) return null;
  const who = t.sentBy?.username ?? (t.sentBy?.moderatorId ? `user ${t.sentBy.moderatorId}` : null);
  return who ? `Sent by ${who}` : 'Sent to support';
}
