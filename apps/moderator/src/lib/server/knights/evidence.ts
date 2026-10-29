import { z } from 'zod';

export const linkEvidenceSchema = z.object({
  sinks: z
    .array(
      z.object({
        sinkId: z.number(),
        feederIds: z.array(z.number()),
        tipCount: z.number(),
        amount: z.number(),
        burst: z.boolean(),
      })
    )
    .catch([]),
  ipLinks: z.array(z.object({ userIds: z.array(z.number()), sharedIps: z.number() })).catch([]),
  createdTogether: z.array(z.array(z.number())).catch([]),
});

export type LinkEvidence = z.infer<typeof linkEvidenceSchema>;

export const parseLinkEvidence = (value: unknown): LinkEvidence =>
  linkEvidenceSchema.catch({ sinks: [], ipLinks: [], createdTogether: [] }).parse(value);

const list = (names: string[]) =>
  names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

const plural = (n: number, word: string, many = `${word}s`) =>
  `${n.toLocaleString()} ${n === 1 ? word : many}`;

export function describeEvidence(evidence: LinkEvidence, name: (id: number) => string): string[] {
  const lines: string[] = [];
  for (const sink of evidence.sinks) {
    lines.push(
      `${list(sink.feederIds.map(name))} tipped ${name(sink.sinkId)} ${plural(
        sink.tipCount,
        'time'
      )}, ` +
        `${sink.amount.toLocaleString()} Buzz in total, ` +
        `and most of what those accounts tip goes to that account.` +
        (sink.burst ? ' The tips arrived in quick bursts.' : '')
    );
  }
  for (const link of evidence.ipLinks) {
    lines.push(
      `${list(link.userIds.map(name))} used ${plural(
        link.sharedIps,
        'address',
        'addresses'
      )} that few other accounts use.`
    );
  }
  for (const ids of evidence.createdTogether) {
    lines.push(`${list(ids.map(name))} were created within moments of each other.`);
  }
  return [...new Set(lines)];
}
