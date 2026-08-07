/**
 * Import a policy-set JSON into `label_policy` as the next version of each label it defines.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/xguard-lab/import-policy.ts \
 *     --file _local/docs/plans/xguard-age-labels/policies/age-split-v6-block.json
 *
 * Same shape the tuning harness uses:
 *   { name, note?, combine?, labels: [{ label, policy, threshold, action? }] }
 *
 * Versions are per-label and only ever go up, so importing the same file twice gives you two
 * versions with identical text rather than overwriting history an evaluation already points at.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import pg from 'pg';

type PolicySet = {
  name: string;
  note?: string;
  labels: Array<{ label: string; policy: string; threshold: number; action?: string }>;
};

const argv = process.argv.slice(2);
const get = (f: string) => {
  const i = argv.indexOf(f);
  return i === -1 ? undefined : argv[i + 1];
};

const file = get('--file');
if (!file) throw new Error('--file is required');

const set = JSON.parse(readFileSync(resolve(file), 'utf8')) as PolicySet;
if (!set.labels?.length) throw new Error('policy set defines no labels');

const client = new pg.Client({
  connectionString:
    get('--lab-db') ??
    process.env.MODERATOR_DATABASE_URL ??
    'postgres://xguard:xguard@localhost:5433/xguard_lab',
});
await client.connect();

try {
  for (const def of set.labels) {
    await client.query(
      `INSERT INTO label_def (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [def.label, `Imported from ${set.name}`]
    );

    const { rows } = await client.query<{ next: number }>(
      `SELECT COALESCE(max(version), 0) + 1 AS next FROM label_policy WHERE label = $1`,
      [def.label]
    );
    const version = rows[0].next;

    await client.query(
      `INSERT INTO label_policy (label, version, policy, threshold, action, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [def.label, version, def.policy, def.threshold, def.action ?? 'Scan', set.note ?? set.name]
    );

    console.log(`${def.label}  ->  v${version}  (threshold ${def.threshold}, ${def.action ?? 'Scan'})`);
  }
} finally {
  await client.end();
}
