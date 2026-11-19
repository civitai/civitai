/** An orchestrator workflow id is `<submitter user id>-<UTC yyyyMMddHHmmss><fraction>[-<suffix>]`. The owner
 *  is read from the id, never from `metadata` or `tags`, which the submitter writes. */
const WORKFLOW_ID_PATTERN = /^(\d{1,10})-(\d{14})\d{0,6}(?:-[a-z0-9]{1,32})?$/;
export const MAX_INT4 = 2_147_483_647;

export type ParsedWorkflowId = { ownerId: number; submittedAt: Date };

/** The submitter and submit instant carried by an orchestrator workflow id, or null when the id is not
 *  one. Doubles as the input guard: nothing that fails this reaches a URL or a query. */
export function parseWorkflowId(raw: string | null | undefined): ParsedWorkflowId | null {
  if (typeof raw !== 'string') return null;
  const match = WORKFLOW_ID_PATTERN.exec(raw);
  if (!match) return null;
  const ownerId = Number(match[1]);
  if (!Number.isInteger(ownerId) || ownerId <= 0 || ownerId > MAX_INT4) return null;
  const s = match[2];
  const submittedAt = new Date(
    Date.UTC(
      +s.slice(0, 4),
      +s.slice(4, 6) - 1,
      +s.slice(6, 8),
      +s.slice(8, 10),
      +s.slice(10, 12),
      +s.slice(12, 14)
    )
  );
  if (Number.isNaN(submittedAt.getTime())) return null;
  return { ownerId, submittedAt };
}
