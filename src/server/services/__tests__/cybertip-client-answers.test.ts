import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, Environment, ResponseCode } from '@civitai/cybertipline-tools';

/**
 * The send reads NCMEC's "already finished" and "already retracted" answers from the error the
 * client throws on a non-2xx response. This pins that error's wording against the real client, so a
 * client upgrade that changes it fails here. The responses below are invented.
 */

const answer = (status: number, responseCode: number) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><reportResponse><responseCode>${responseCode}</responseCode><responseDescription>synthetic</responseDescription></reportResponse>`,
    { status, headers: { 'Request-ID': 'test' } }
  );

const client = new Client({
  environment: Environment.Testing,
  credentials: { username: 'test', password: 'test' },
});

afterEach(() => vi.restoreAllMocks());

describe('a cancel NCMEC refuses', () => {
  it.each([
    [ResponseCode.ReportAlreadyFinished, ' - ReportAlreadyFinished '],
    [ResponseCode.ReportAlreadyRetracted, ' - ReportAlreadyRetracted '],
  ])('names answer %s in the error the client throws', async (code, named) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(409, code));

    const refused = await client.cancelReport({ id: 1 }).catch((e: Error) => e);

    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain(named);
  });
});
