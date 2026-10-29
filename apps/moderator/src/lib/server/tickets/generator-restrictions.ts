import type { getBlockedPrompts } from '../user-signals.service';
import type { getGenerationRestrictions } from '../user-restriction.service';
import {
  GENERATOR_RESTRICTIONS_PATH,
  GENERATOR_RESTRICTION_TYPES,
  unwiredRulingReason,
} from '$lib/restriction-types';
import { BLOCKED_PROMPTS_PATH, GENERATOR_ROWS } from '$lib/tickets/generator-panel';
import type { HistorySection } from './history';

/** A prompt is shown whole up to this, so one pasted essay cannot fill the card. */
const PROMPT_CHARS = 300;

/**
 * One restriction. Triggers are counted, not listed: they carry the generated images and the prompts, and
 * the card shows neither (media is read under `user.generations.view`, which this card does not hold).
 */
export type GeneratorRestriction = {
  id: number;
  type: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedReason: string | null;
  triggerCount: number;
  /** Open and of a type the main app can rule on: the only rows the card offers a ruling for. */
  rulable: boolean;
};

export type GeneratorBlockedPrompt = {
  key: string;
  time: string;
  prompt: string;
  negativePrompt: string | null;
  source: string;
};

export type TicketGenerator =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | {
      status: 'ok';
      userId: number;
      /** Left out when the viewer does not hold the generator restrictions page grant. */
      restrictions?: HistorySection<GeneratorRestriction>;
      /** Left out when the viewer does not hold User Lookup's page grant. */
      blockedPrompts?: HistorySection<GeneratorBlockedPrompt>;
    };

export type GeneratorReads = {
  restrictions: (userId: number, limit: number) => ReturnType<typeof getGenerationRestrictions>;
  blockedPrompts: (userId: number, limit: number) => ReturnType<typeof getBlockedPrompts>;
};

// Imported when read, so loading the ticket detail module opens no database or ClickHouse connection.
const liveReads: GeneratorReads = {
  // `any` type, like the queue's by-id reads: the generator page's own types are applied afterwards.
  restrictions: async (userId, limit) =>
    (await import('../user-restriction.service')).getGenerationRestrictions({
      page: 1,
      limit,
      type: 'any',
      userId,
    }),
  blockedPrompts: async (userId, limit) =>
    (await import('../user-signals.service')).getBlockedPrompts(userId, limit),
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** One section: a failing read is that section's `unavailable`, never the card's. */
async function section<T>(
  label: string,
  read: () => Promise<{ rows: T[]; truncated: boolean }>
): Promise<HistorySection<T>> {
  try {
    return { status: 'ok', ...(await read()) };
  } catch (e) {
    console.error(`[tickets] generator ${label} failed`, e);
    return { status: 'unavailable' };
  }
}

/**
 * The linked user's generator restrictions and blocked prompts, each bounded and read only under its own
 * source page's grant. Rulings are a separate write (`generatorResolveRestriction`).
 */
export async function generatorSectionFor(
  ticket: { userId: number; canRead: (path: string) => boolean },
  reads: GeneratorReads = liveReads
): Promise<Extract<TicketGenerator, { status: 'ok' }>> {
  const { userId, canRead } = ticket;
  const [restrictions, blockedPrompts] = await Promise.all([
    canRead(GENERATOR_RESTRICTIONS_PATH)
      ? section('restrictions', async () => {
          const { items } = await reads.restrictions(userId, GENERATOR_ROWS + 1);
          const rows = items.filter((r) =>
            (GENERATOR_RESTRICTION_TYPES as readonly string[]).includes(r.type)
          );
          return {
            truncated: items.length > GENERATOR_ROWS,
            rows: rows.slice(0, GENERATOR_ROWS).map(
              (r): GeneratorRestriction => ({
                id: r.id,
                type: r.type,
                status: r.status,
                createdAt: r.createdAt.toISOString(),
                resolvedAt: iso(r.resolvedAt),
                resolvedReason: r.resolvedReason,
                triggerCount: r.triggers.length,
                rulable: r.status === 'Pending' && unwiredRulingReason(r.type) === null,
              })
            ),
          };
        })
      : undefined,
    canRead(BLOCKED_PROMPTS_PATH)
      ? section('blocked prompts', async () => {
          const { prompts, total } = await reads.blockedPrompts(userId, GENERATOR_ROWS + 1);
          return {
            truncated: total > GENERATOR_ROWS || prompts.length > GENERATOR_ROWS,
            rows: prompts.slice(0, GENERATOR_ROWS).map(
              (p): GeneratorBlockedPrompt => ({
                key: p.key,
                time: p.time,
                prompt: p.prompt.slice(0, PROMPT_CHARS),
                negativePrompt: p.negativePrompt?.slice(0, PROMPT_CHARS) ?? null,
                source: p.source,
              })
            ),
          };
        })
      : undefined,
  ]);
  return {
    status: 'ok',
    userId,
    ...(restrictions && { restrictions }),
    ...(blockedPrompts && { blockedPrompts }),
  };
}
