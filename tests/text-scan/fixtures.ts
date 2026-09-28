import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const FILE = path.resolve('tests/text-scan/local/fixtures.json');

const schema = z.object({
  sfw: z.string().min(40),
  explicit: z.string().min(40),
  poi: z.string().min(40),
  minor: z.string().min(40),
  scam: z.string().min(40),
  scamUsername: z.string().min(3).max(20),
});

export type FixtureKey = keyof z.infer<typeof schema>;
let cached: z.infer<typeof schema> | undefined;

export function fixture(key: FixtureKey): string {
  if (!cached) {
    if (!fs.existsSync(FILE))
      throw new Error(`missing ${FILE}; see plan 07 Task 6 Step 9 for the categories`);
    const parsed = schema.safeParse(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    if (!parsed.success) throw new Error(`${FILE}: ${z.prettifyError(parsed.error)}`);
    cached = parsed.data;
  }
  return cached[key];
}

export function nonce() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Unique text per submission, so neither the orchestrator cache nor contentHash dedup answers. */
export function withNonce(text: string, n = nonce()) {
  return `${text}\n\nref ${n}`;
}
