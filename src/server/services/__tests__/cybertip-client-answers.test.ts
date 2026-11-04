import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildReport,
  Client,
  Environment,
  IncidentType,
  ResponseCode,
} from '@civitai/cybertipline-tools';

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

// Patched in patches/@civitai__cybertipline-tools@0.1.0.patch: the client read these as numbers.
describe('text that reads as a number', () => {
  const numberLike = ['007', '1e5', '0x1F', '12.50'];

  it.each(numberLike)('keeps an upload answer whose fileId is %s as text', async (fileId) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?><reportResponse><responseCode>0</responseCode><responseDescription>synthetic</responseDescription><reportId>900</reportId><fileId>${fileId}</fileId><hash>${fileId}</hash></reportResponse>`,
        { status: 200, headers: { 'Request-ID': 'test' } }
      )
    );

    const { data } = await client.uploadFile({ id: 900, file: new File(['x'], 'x.png') });

    expect(data).toMatchObject({ responseCode: 0, reportId: 900, fileId, hash: fileId });
  });

  it.each(numberLike)('sends a name, email and screen name of %s as written', (text) => {
    const xml = buildReport({
      incidentSummary: {
        incidentType: IncidentType.ChildPornography,
        incidentDateTime: new Date('2026-11-01T00:00:00Z'),
      },
      reporter: {
        reportingPerson: { firstName: text, email: [{ email: text }] },
        contactPerson: { email: [{ email: 'contact@example.invalid' }] },
      },
      personOrUserReported: {
        espIdentifier: '1',
        screenName: text,
        personOrUserReportedPerson: { firstName: text, email: [{ email: text }] },
      },
    });

    for (const tag of ['firstName', 'screenName'])
      for (const [, value] of xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g')))
        expect(value).toBe(text);
    // Both names, both emails and the screen name.
    expect(xml.split(`>${text}<`)).toHaveLength(6);
  });
});
