import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { mockApplyScanOutcome, mockExaminePickleImports, mockLogToAxiom } = vi.hoisted(() => ({
  mockApplyScanOutcome: vi.fn().mockResolvedValue(undefined),
  mockExaminePickleImports: vi.fn(),
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
}));

// WebhookEndpoint normally wraps with token-auth. For unit tests we want the raw
// handler so we can drive it with synthetic req/res.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

vi.mock('~/server/services/model-file-scan.service', () => ({
  applyScanOutcome: mockApplyScanOutcome,
  examinePickleImports: mockExaminePickleImports,
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
}));

vi.mock('~/server/jobs/scan-files', () => ({
  ScannerTasks: ['Import', 'Hash', 'Scan', 'Convert', 'ParseMetadata'],
}));

import handler from '~/pages/api/webhooks/scan-result';
import { ModelHashType, ScanResultCode } from '~/shared/utils/prisma/enums';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const scanResultHandler = handler as unknown as Handler;

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

function makeReq({
  method = 'POST',
  query,
  body,
}: {
  method?: string;
  query: Record<string, unknown>;
  body: unknown;
}) {
  return { method, query, body } as unknown as NextApiRequest;
}

const baseScanResult = {
  url: 's3://bucket/key',
  fileExists: 1,
  picklescanExitCode: 0,
  picklescanOutput: '',
  picklescanGlobalImports: [],
  picklescanDangerousImports: [],
  clamscanExitCode: 0,
  clamscanOutput: '',
  hashes: {} as Record<string, string>,
  metadata: {},
  conversions: { safetensors: null, ckpt: null },
};

describe('webhooks/scan-result legacy adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExaminePickleImports.mockReturnValue({ pickleScanMessage: null, hasDanger: false });
  });

  it('returns 405 on non-POST methods', async () => {
    const req = makeReq({ method: 'GET', query: { fileId: '1' }, body: {} });
    const res = makeRes();

    await scanResultHandler(req, res);

    expect(res.statusCode).toBe(405);
    expect(mockApplyScanOutcome).not.toHaveBeenCalled();
  });

  it('passes the raw scan payload to applyScanOutcome under a legacy envelope', async () => {
    const req = makeReq({
      query: { fileId: '42' },
      body: baseScanResult,
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    expect(mockApplyScanOutcome).toHaveBeenCalledTimes(1);
    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.fileId).toBe(42);
    expect(outcome.rawScanResult).toEqual({ source: 'legacy', ...baseScanResult });
  });

  it('defaults tasks to [Scan, Hash, ParseMetadata] when no tasks query supplied', async () => {
    const req = makeReq({
      query: { fileId: '1' },
      body: {
        ...baseScanResult,
        clamscanExitCode: 0,
        clamscanOutput: 'clean',
        hashes: { SHA256: 'abc' },
        metadata: { __metadata__: { foo: 'bar' } },
      },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    // Scan branch ran
    expect(outcome.virusScan).toBeDefined();
    // Hash branch ran
    expect(outcome.hashes).toEqual({ [ModelHashType.SHA256]: 'abc' });
    // ParseMetadata branch ran
    expect(outcome.headerData).toEqual({ foo: 'bar' });
  });

  it('skips Scan branch entirely when only Hash task requested', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'Hash' },
      body: { ...baseScanResult, hashes: { SHA256: 'abc' } },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.virusScan).toBeUndefined();
    expect(outcome.pickleScan).toBeUndefined();
    expect(outcome.hashes).toEqual({ [ModelHashType.SHA256]: 'abc' });
  });

  it('clamscan exitCode 0 (Success) → null message, regardless of output content', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'Scan' },
      body: { ...baseScanResult, clamscanExitCode: 0, clamscanOutput: 'clean as a whistle' },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.virusScan.result).toBe(ScanResultCode.Success);
    expect(outcome.virusScan.message).toBeNull();
  });

  it('clamscan exitCode 1 (Danger) → preserves output as message', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'Scan' },
      body: { ...baseScanResult, clamscanExitCode: 1, clamscanOutput: 'EICAR-TEST-FILE' },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.virusScan.result).toBe(ScanResultCode.Danger);
    expect(outcome.virusScan.message).toBe('EICAR-TEST-FILE');
  });

  it('clamscan exitCode 2 (Error) → preserves output as message', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'Scan' },
      body: { ...baseScanResult, clamscanExitCode: 2, clamscanOutput: 'scanner crashed' },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.virusScan.result).toBe(ScanResultCode.Error);
    expect(outcome.virusScan.message).toBe('scanner crashed');
  });

  it('clamscan exitCode -1 (Pending) → null message (matches orchestrator parity)', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'Scan' },
      body: { ...baseScanResult, clamscanExitCode: -1, clamscanOutput: 'still running' },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.virusScan.result).toBe(ScanResultCode.Pending);
    expect(outcome.virusScan.message).toBeNull();
  });

  it('forces pickleScan to Danger when examinePickleImports reports hasDanger', async () => {
    mockExaminePickleImports.mockReturnValue({
      pickleScanMessage: 'Dangerous import detected',
      hasDanger: true,
    });

    const req = makeReq({
      query: { fileId: '1', tasks: 'Scan' },
      body: {
        ...baseScanResult,
        picklescanExitCode: 0, // even Success exit code is overridden
        picklescanDangerousImports: ['os,system'],
      },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.pickleScan.result).toBe(ScanResultCode.Danger);
    expect(outcome.pickleScan.message).toBe('Dangerous import detected');
    expect(outcome.pickleScan.dangerousImports).toEqual(['os,system']);
  });

  it('case-insensitive hash key mapping: SHA256/sha256/Sha256 all map correctly', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'Hash' },
      body: {
        ...baseScanResult,
        hashes: { sha256: 'lower', AutoV2: 'mixed', BLAKE3: 'upper' },
      },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.hashes).toEqual({
      [ModelHashType.SHA256]: 'lower',
      [ModelHashType.AutoV2]: 'mixed',
      [ModelHashType.BLAKE3]: 'upper',
    });
  });

  it('skips unknown hash keys and empty values', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'Hash' },
      body: {
        ...baseScanResult,
        hashes: { SHA256: 'good', UNKNOWN: 'whatever', AutoV2: '' },
      },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.hashes).toEqual({ [ModelHashType.SHA256]: 'good' });
  });

  it('omits outcome.hashes when no valid hash entries result', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'Hash' },
      body: { ...baseScanResult, hashes: { UNKNOWN: 'x' } },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.hashes).toBeUndefined();
  });

  it('extracts headerData from metadata.__metadata__ envelope', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'ParseMetadata' },
      body: { ...baseScanResult, metadata: { __metadata__: { author: 'me', step: 100 } } },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.headerData).toEqual({ author: 'me', step: 100 });
  });

  it('parses ss_tag_frequency string-of-JSON when valid', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'ParseMetadata' },
      body: {
        ...baseScanResult,
        metadata: { __metadata__: { ss_tag_frequency: JSON.stringify({ a: 1 }) } },
      },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.headerData.ss_tag_frequency).toEqual({ a: 1 });
  });

  it('leaves ss_tag_frequency as a string when its inner JSON parse fails', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'ParseMetadata' },
      body: {
        ...baseScanResult,
        metadata: { __metadata__: { ss_tag_frequency: 'not-json' } },
      },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.headerData.ss_tag_frequency).toBe('not-json');
  });

  it('skips ParseMetadata branch when metadata.__metadata__ is missing', async () => {
    const req = makeReq({
      query: { fileId: '1', tasks: 'ParseMetadata' },
      body: { ...baseScanResult, metadata: {} },
    });
    const res = makeRes();

    await scanResultHandler(req, res);

    const outcome = mockApplyScanOutcome.mock.calls[0][0];
    expect(outcome.headerData).toBeUndefined();
  });

  it('returns 200 ok on the success path', async () => {
    const req = makeReq({ query: { fileId: '1' }, body: baseScanResult });
    const res = makeRes();

    await scanResultHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 500 and logs to Axiom when applyScanOutcome throws', async () => {
    mockApplyScanOutcome.mockRejectedValueOnce(new Error('db down'));

    const req = makeReq({ query: { fileId: '1' }, body: baseScanResult });
    const res = makeRes();

    await scanResultHandler(req, res);

    expect(res.statusCode).toBe(500);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'scan-result', message: 'db down' }),
      'webhooks'
    );
  });
});
