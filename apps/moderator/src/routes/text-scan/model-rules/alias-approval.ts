import { appendAliases } from '$lib/model-rules';

type ApprovalRule = {
  id: number;
  subject: string;
  description: string;
  note: string;
  aliases: readonly string[];
  updatedAt: Date | string;
};

/** The `saveAll` entries for the ticked aliases: the saved rule plus its additions, written against the version the moderator saw. */
export function buildApprovalPayload(
  rules: readonly ApprovalRule[],
  picks: Record<number, readonly string[]>
) {
  return rules.flatMap((rule) => {
    const added = picks[rule.id] ?? [];
    if (!added.length) return [];
    return [
      {
        draftId: rule.id,
        id: rule.id,
        subject: rule.subject,
        description: rule.description,
        aliases: appendAliases(rule.aliases.join('\n'), added),
        note: rule.note,
        baseUpdatedAt: new Date(rule.updatedAt).toISOString(),
      },
    ];
  });
}

/** What `saveAll` answered, by rule: ids that saved, and the refusal for each that did not. */
export function readApprovalResult(data: Record<string, unknown> | undefined) {
  const saved: number[] = [];
  const failed: Record<number, string> = {};
  if (Array.isArray(data?.saved))
    for (const s of data.saved as { draftId?: unknown }[])
      if (typeof s?.draftId === 'number') saved.push(s.draftId);
  if (Array.isArray(data?.failed))
    for (const f of data.failed as { draftId?: unknown; error?: unknown }[])
      if (typeof f?.draftId === 'number')
        failed[f.draftId] = typeof f.error === 'string' ? f.error : 'Not saved.';
  return { saved, failed };
}
