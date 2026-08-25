import { createKyselyClients, type Generated } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import { env } from '$env/dynamic/private';

// The XGuard label lab's tables, in the MODERATOR database — no foreign keys into Civitai's Postgres.
// Schema is applied by hand from apps/moderator/xguard-lab/schema.sql; nothing generates this interface.

export interface LabDB {
  sample: {
    id: Generated<string>;
    prompt_hash: string | null;
    source: string;
    batch: string;
    user_id: number | null;
    positive_prompt: string;
    negative_prompt: string | null;
    live_scores: Record<string, number> | null;
    prompt_created_at: Date | null;
    created_at: Generated<Date>;
  };
  machine_judgement: {
    id: Generated<string>;
    sample_id: string;
    label: string;
    source: 'xguard' | 'ai';
    model: string | null;
    score: number | null;
    verdict: boolean;
    reason: string | null;
    highlights: { positive?: Span[]; negative?: Span[] } | null;
    policy_id: string | null;
    created_at: Generated<Date>;
  };
  human_judgement: {
    id: Generated<string>;
    sample_id: string;
    label: string;
    reviewed_judgement_id: string | null;
    agreed: boolean | null;
    verdict: boolean;
    note: string | null;
    reviewer_id: number;
    duration_ms: number | null;
    // Null means the judgement counts. Non-null retires it without deleting the evidence.
    excluded_reason: string | null;
    created_at: Generated<Date>;
  };
  eval_run: {
    id: Generated<string>;
    label: string;
    policy_id: string | null;
    policy_label: string;
    threshold: number;
    batch: string | null;
    status: Generated<string>;
    total: Generated<number>;
    scored: Generated<number>;
    errors: Generated<number>;
    tp: Generated<number>;
    fp: Generated<number>;
    tn: Generated<number>;
    fn: Generated<number>;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    note: string | null;
    started_at: Generated<Date>;
    finished_at: Date | null;
  };
  eval_result: {
    id: Generated<string>;
    run_id: string;
    sample_id: string;
    score: number | null;
    predicted: boolean | null;
    expected: boolean;
    bucket: string | null;
    reason: string | null;
    error: string | null;
  };
  label_def: {
    name: string;
    description: string;
    status: Generated<string>;
    created_at: Generated<Date>;
  };
  label_term: {
    id: Generated<string>;
    label: string;
    term: string;
    kind: 'trigger' | 'counter' | 'soft';
    note: string | null;
    created_at: Generated<Date>;
  };
  label_policy: {
    id: Generated<string>;
    label: string;
    version: number;
    policy: string;
    threshold: number;
    action: Generated<string>;
    note: string | null;
    created_at: Generated<Date>;
  };
}

export type Span = { start: number; end: number; text: string };

function labUrl(): string {
  const url = env.MODERATOR_DATABASE_URL;
  if (!url) throw new Error('MODERATOR_DATABASE_URL is not configured');
  return url;
}

// `sslNoVerify` turns SSL ON while skipping cert verification, which is what the cnpg cluster
// needs and what a plain local docker Postgres rejects outright ("The server does not support SSL
// connections").
//
// An explicit `sslmode` in the URL decides it; the hostname is only consulted when the URL says
// nothing. Reading the hostname first is wrong because the cluster is reached in dev through a
// local port-forward, so a cnpg tunnel and the docker-compose Postgres are both `localhost` and
// the two need opposite answers.
function wantsSsl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const sslmode = parsed.searchParams.get('sslmode');
    if (sslmode) return sslmode !== 'disable';
    const { hostname } = parsed;
    return !(hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1');
  } catch {
    return false;
  }
}

// Lazy: /xguard/docs imports every /api/xguard endpoint module to build its catalog, so constructing
// this at module scope takes that page down too whenever MODERATOR_DATABASE_URL is unset.
let client: Kysely<LabDB> | undefined;

// No replica; reads and writes both go to the single instance.
function createLabDb(): Kysely<LabDB> {
  const url = labUrl();
  const { dbWrite } = createKyselyClients<LabDB>({
    connectionString: url,
    replicaConnectionString: url,
    sslNoVerify: wantsSsl(url),
  });
  return dbWrite;
}

export function getLabDb(): Kysely<LabDB> {
  if (!client) client = createLabDb();
  return client;
}
