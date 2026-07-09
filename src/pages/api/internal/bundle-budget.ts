import type { NextApiRequest, NextApiResponse } from 'next';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

// Serves this build's per-route First Load JS (brotli, bytes), written by
// `scripts/bundle-budget.mjs --json` during the Docker build and shipped to
// /app/bundle-budget.json. Consumers:
//   - the perf-trend baseline job — records main's numbers over time (Grafana),
//   - the future PR bundle-regression gate — diffs a PR build vs main.
// On main this is reachable at https://next.civitai.com/api/internal/bundle-budget?token=<WEBHOOK_TOKEN>.
// Token-gated via WebhookEndpoint (the same WEBHOOK_TOKEN as the other internal endpoints).
const BUNDLE_BUDGET_PATH = join(process.cwd(), 'bundle-budget.json');

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!existsSync(BUNDLE_BUDGET_PATH)) {
    // Older images (built before the --json change) won't have the file.
    return res.status(404).json({ error: 'bundle-budget.json not present in this build' });
  }
  try {
    const snapshot = JSON.parse(readFileSync(BUNDLE_BUDGET_PATH, 'utf8'));
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(snapshot);
  } catch {
    return res.status(500).json({ error: 'failed to read bundle-budget.json' });
  }
});
