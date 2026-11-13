import client from 'prom-client';
import { describe, expect, it } from 'vitest';

import {
  blockRequestResult,
  ensureRegisterAppBlockRuntimeMetrics,
  markBlockRequestReadMiss,
  recordAppBlockSubmitFailure,
  statusToRequestResult,
  submitFailureAppBlockLabel,
} from '../app-block-runtime.metrics';

type Sample = { value: number; labels: Record<string, string> };

async function samples(name: string): Promise<Sample[]> {
  ensureRegisterAppBlockRuntimeMetrics();
  const metric = client.register.getSingleMetric(name) as unknown as {
    get: () => Promise<{ values: Sample[] }>;
  };
  return (await metric.get()).values;
}

describe('blockRequestResult — a document read miss is not a client error', () => {
  it('a marked 404 is not_found; an unmarked 404 is still client_error', () => {
    const miss = { statusCode: 404 };
    markBlockRequestReadMiss(miss);
    expect(blockRequestResult(miss)).toBe('not_found');
    // Red on origin/main: the only mapping was the bare status, which says client_error.
    expect(statusToRequestResult(404)).toBe('client_error');
    expect(blockRequestResult({ statusCode: 404 })).toBe('client_error');
  });

  it('the mark only reclassifies a 404: a marked response that ended otherwise keeps its status label', () => {
    const later500 = { statusCode: 500 };
    markBlockRequestReadMiss(later500);
    expect(blockRequestResult(later500)).toBe('server_error');
    const ok = { statusCode: 200 };
    markBlockRequestReadMiss(ok);
    expect(blockRequestResult(ok)).toBe('success');
  });

  it('every other status maps exactly as before', () => {
    expect(blockRequestResult({ statusCode: 200 })).toBe('success');
    expect(blockRequestResult({ statusCode: 401 })).toBe('forbidden');
    expect(blockRequestResult({ statusCode: 403 })).toBe('forbidden');
    expect(blockRequestResult({ statusCode: 429 })).toBe('client_error');
    expect(blockRequestResult({ statusCode: 503 })).toBe('server_error');
  });

  it('not_found lands on civitai_app_block_requests_total as its own result series', async () => {
    const { requestsTotal } = ensureRegisterAppBlockRuntimeMetrics();
    const labels = { app_block_id: 'apb_readmiss', endpoint: 'storage_read' };
    const miss = { statusCode: 404 };
    markBlockRequestReadMiss(miss);
    requestsTotal.inc({ ...labels, result: blockRequestResult(miss) });
    const rows = (await samples('civitai_app_block_requests_total')).filter(
      (s) => s.labels.app_block_id === 'apb_readmiss'
    );
    expect(rows).toEqual([{ value: 1, labels: { ...labels, result: 'not_found' } }]);
  });
});

describe('civitai_app_block_submit_failures_total', () => {
  it('increments by (app_block_id, reason)', async () => {
    const before = await samples('civitai_app_block_submit_failures_total');
    const read = (rows: Sample[], app: string, reason: string) =>
      rows.find((s) => s.labels.app_block_id === app && s.labels.reason === reason)?.value ?? 0;
    const base = read(before, 'apb_sf', 'ecosystem_unavailable');

    recordAppBlockSubmitFailure('apb_sf', 'ecosystem_unavailable');
    recordAppBlockSubmitFailure('apb_sf', 'ecosystem_unavailable');
    recordAppBlockSubmitFailure('apb_sf', 'rate_limited');

    const after = await samples('civitai_app_block_submit_failures_total');
    expect(read(after, 'apb_sf', 'ecosystem_unavailable')).toBe(base + 2);
    expect(read(after, 'apb_sf', 'rate_limited')).toBeGreaterThanOrEqual(1);
  });

  it('labels a dev token dev, a verified token by its app, and a missing id unknown', () => {
    expect(submitFailureAppBlockLabel({ dev: true, appBlockId: 'apb_synthetic_xyz' })).toBe('dev');
    expect(submitFailureAppBlockLabel({ appBlockId: 'apb_real' })).toBe('apb_real');
    expect(submitFailureAppBlockLabel({ dev: 'true', appBlockId: 'apb_real' })).toBe('apb_real');
    expect(submitFailureAppBlockLabel({})).toBe('unknown');
    expect(submitFailureAppBlockLabel({ appBlockId: '' })).toBe('unknown');
  });

  it('get-or-create: a second registration reuses the counter instead of throwing', () => {
    const first = ensureRegisterAppBlockRuntimeMetrics().submitFailuresTotal;
    expect(ensureRegisterAppBlockRuntimeMetrics().submitFailuresTotal).toBe(first);
  });
});
