/**
 * redrive-outbox.ts
 *
 * Reset the `attempts` counter on PARKED Outbox rows so the poller retries them.
 *
 * A row is "parked" once attempts >= OUTBOX_MAX_ATTEMPTS (default 5): the poller
 * stops selecting it (see src/services/outbox-poller.ts) and it shows up in the
 * `mew_outbox_parked` gauge. Parked rows are side effects that exhausted their
 * retry budget — run this AFTER fixing whatever made them fail (e.g. the
 * side-effects endpoint was down / an S3 outage) to re-drive them.
 *
 * Setting attempts back to NULL makes the poller's WHERE
 * (`attempts IS NULL OR attempts < max`) pick the row up on its next sweep.
 *
 * Usage:
 *   DATABASE_URL=... tsx scripts/redrive-outbox.ts               # re-drive ALL parked rows
 *   DATABASE_URL=... tsx scripts/redrive-outbox.ts 123 456       # re-drive specific Outbox ids
 *   DATABASE_URL=... tsx scripts/redrive-outbox.ts --dry-run     # count what WOULD be re-driven
 */
import * as dotenv from 'dotenv'
import { Pool } from 'pg'

dotenv.config()

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const ids = args.filter((a) => /^\d+$/.test(a))
  const maxAttempts = parseInt(process.env.OUTBOX_MAX_ATTEMPTS ?? '5', 10)

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')

  // Target either explicit ids, or all parked rows (attempts >= max).
  const where = ids.length > 0 ? 'id = ANY($1::bigint[])' : 'attempts >= $1'
  const params: any[] = ids.length > 0 ? [ids] : [maxAttempts]
  const scope = ids.length > 0 ? `ids [${ids.join(', ')}]` : `all parked rows (attempts >= ${maxAttempts})`

  const pool = new Pool({ connectionString })
  try {
    if (dryRun) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "Outbox" WHERE ${where}`, params)
      console.log(`[dry-run] ${rows[0].n} row(s) would be re-driven — ${scope}`)
      return
    }

    const { rowCount } = await pool.query(`UPDATE "Outbox" SET attempts = NULL WHERE ${where}`, params)
    console.log(`Re-drove ${rowCount} Outbox row(s) — ${scope}. The poller will retry them on its next sweep.`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
