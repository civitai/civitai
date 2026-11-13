export type QueueImageCounts = Record<string, { total: number; remaining: number }>;

export async function fetchQueueImageCounts(userIds: number[]): Promise<QueueImageCounts> {
  const r = await fetch(`/api/report-queue-image-counts?userIds=${userIds.join(',')}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
