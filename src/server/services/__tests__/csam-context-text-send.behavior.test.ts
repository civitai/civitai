import { PGlite } from '@electric-sql/pglite';
import { Parser } from 'xml2js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as NcmecXml from '~/server/services/ncmec-xml';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Text attached to an image report reaches NCMEC as page incidents that survive XML, whatever the
 * text holds. Ids and text are invented; nothing leaves the process.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

await vi.hoisted(async () => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://example.invalid/civitai-link';
});

const {
  submitReport,
  uploadFile,
  submitFileDetails,
  finishReport,
  cancelReport,
  getObject,
  escape,
} = vi.hoisted(() => ({
  submitReport: vi.fn(),
  uploadFile: vi.fn(),
  submitFileDetails: vi.fn(),
  finishReport: vi.fn(),
  cancelReport: vi.fn(),
  getObject: vi.fn(),
  escape: { off: false },
}));

vi.mock('@civitai/cybertipline-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof CybertiplineTools>()),
  Client: class {
    getStatus = async () => ({ data: { responseCode: 0 } });
    submitReport = submitReport;
    uploadFile = uploadFile;
    submitFileDetails = submitFileDetails;
    finishReport = finishReport;
    cancelReport = cancelReport;
  },
}));

// The positive control: with escaping off (illegal characters still scrubbed), the send must stop.
vi.mock('~/server/services/ncmec-xml', async (importOriginal) => {
  const original = await importOriginal<typeof NcmecXml>();
  return {
    ...original,
    xmlText: (text: string) => (escape.off ? original.xmlSafe(text) : original.xmlText(text)),
  };
});

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: undefined,
}));

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isProd: true,
}));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImageUploadBackend: async () => ({
    bucket: 'test-images',
    backend: 'backblaze',
    s3: {
      send: (command: { constructor: { name: string }; input: { Key: string } }) =>
        command.constructor.name === 'HeadObjectCommand'
          ? getObject(command.input.Key).then((object: { ContentLength: number }) => ({
              ContentLength: object.ContentLength,
              ContentType: 'image/png',
            }))
          : getObject(command.input.Key),
    },
  }),
}));

import { buildReport } from '@civitai/cybertipline-tools';
import type { CsamReportProps } from '~/server/services/csam.service-new';
import { processCsamReport } from '~/server/services/csam.service-new';
import type { CsamContextText } from '~/server/services/csam-context-text';
import {
  contextTextOmittedLine,
  contextWebPageIncidents,
  foldContextText,
} from '~/server/services/csam-context-text';

const webPages = contextWebPageIncidents;
import { logToAxiom } from '~/server/logging/client';

const stored = Buffer.from('the bytes the user uploaded');
const db = { pg: null as unknown as PGlite };
const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) =>
  (await db.pg.query(strings.map((part, i) => (i ? `$${i}` : '') + part).join(''), values)).rows;

const HOSTILE = [
  'R&D <b>bold</b> > less',
  ']]> <![CDATA[ x ]]>',
  '<script>alert(1)</script> &amp; &lt;',
  'nul\u0000 bell\u0007 lone\uD800 surrogate',
  'emoji 😀 and "quotes" \'single\'',
].join('\n');

const contextText: CsamContextText[] = [
  {
    source: 'postDescription',
    id: 100,
    postId: 100,
    authorId: 20,
    authorIsReportedUser: true,
    postedAt: '2026-10-02T08:30:00.000Z',
    text: HOSTILE,
    capturedAt: '2026-10-08T14:05:00.000Z',
    capturedById: 10,
  },
  {
    source: 'comment',
    id: 11,
    imageId: 501,
    authorId: 30,
    authorIsReportedUser: false,
    postedAt: '2026-10-03T14:05:00.000Z',
    text: 'a & b',
    capturedAt: '2026-10-08T14:05:00.000Z',
    capturedById: 10,
  },
  {
    source: 'postText',
    id: 7,
    postId: 100,
    index: 1,
    authorId: 20,
    authorIsReportedUser: true,
    postedAt: '2026-10-02T08:31:00.000Z',
    text: 'held <i>words</i> & more',
    capturedAt: '2026-10-08T14:05:00.000Z',
    capturedById: 10,
  },
];

const omittedAlerts = () =>
  vi
    .mocked(logToAxiom)
    .mock.calls.map(([line]) => line as Record<string, unknown>)
    .filter((line) => line.subType === 'send-omitted');

let filed: CsamReportProps | undefined;
const send = (details: object) => {
  filed = {
    id: 1,
    userId: 20,
    reportedById: 10,
    type: 'Image',
    createdAt: new Date(Date.now() - 3_600_000),
    reportSentAt: null,
    images: [{ id: 501 }],
    details,
  } as unknown as CsamReportProps;
  return processCsamReport(filed);
};

async function parsed(xml: string) {
  return new Parser({ strict: true, explicitArray: true }).parseStringPromise(xml);
}

beforeAll(async () => {
  db.pg = new PGlite({
    parsers: { 1114: (value: string) => new Date(`${value.replace(' ', 'T')}Z`) },
  });
  await db.pg.exec(`
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
      "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "host" TEXT
    );
  `);
});

beforeEach(() => {
  escape.off = false;
  vi.mocked(logToAxiom).mockClear();
  submitReport.mockReset().mockResolvedValue({ data: { reportId: 99 } });
  uploadFile.mockReset().mockResolvedValue({ data: { fileId: 'file-1', hash: 'ncmec-md5' } });
  submitFileDetails.mockReset().mockResolvedValue({});
  finishReport.mockReset();
  cancelReport.mockReset().mockResolvedValue({ data: { responseCode: 0 } });
  getObject.mockReset().mockImplementation(async () => ({
    Body: { transformToByteArray: async () => new Uint8Array(stored) },
    ContentType: 'image/png',
    ContentLength: stored.length,
  }));
  dbMock.dbRead.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === 10
      ? { id: 10, email: 'mod@example.invalid', name: 'Mod', isModerator: true }
      : { id: 20, email: 'user@example.invalid', name: 'User', username: 'user' }
  );
  dbMock.dbRead.image.findMany.mockResolvedValue([
    {
      id: 501,
      url: 'stored-key-501',
      name: 'upload-501.png',
      type: 'image',
      mimeType: 'image/png',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      meta: {},
      post: null,
      tags: [],
    },
  ]);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
  dbMock.dbWrite.csamReport.updateMany.mockReset().mockResolvedValue({ count: 1 });
  dbMock.dbWrite.csamReport.findFirst.mockReset().mockImplementation(async () => filed);
  dbMock.dbWrite.$executeRaw.mockReset().mockResolvedValue(1);
  dbMock.dbWrite.$queryRaw.mockReset().mockImplementation(queryRaw as never);
});

describe('attached text on an image report', () => {
  it('reaches NCMEC as well-formed page incidents that read back as the text sent', async () => {
    await send({ contextText });

    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(finishReport).toHaveBeenCalledTimes(1);
    const xml = buildReport(submitReport.mock.calls[0][0]);
    const doc = await parsed(xml);
    // CyberTip takes one incident per <internetDetails>.
    const incidents = doc.report.internetDetails.flatMap(
      (d: { webPageIncident: unknown[] }) => d.webPageIncident
    ) as {
      url: string[];
      additionalInfo: string[];
      $: { thirdPartyHostedContent: string };
    }[];

    const received = incidents.map((i) => ({ url: i.url[0], additionalInfo: i.additionalInfo[0] }));
    expect(received).toEqual(contextWebPageIncidents(contextText));
    expect(received[0].additionalInfo).toContain('R&D <b>bold</b> > less');
    expect(received[0].additionalInfo).toContain(
      'Text item 7 of this post, posted 10/02/2026 08:31 UTC by the reported account. Not reviewed by Civitai:\n"held <i>words</i> & more"'
    );
    // XML cannot carry the NUL, bell or lone surrogate: they arrive as U+FFFD.
    expect(received[0].additionalInfo).toContain('nul\uFFFD bell\uFFFD lone\uFFFD surrogate');
    expect(incidents.every((i) => i.$.thirdPartyHostedContent === 'false')).toBe(true);
  });

  it('is not sent with escaping off: the XML check stops the CyberTip before it opens', async () => {
    escape.off = true;
    const escapeOnly = contextText.map((c) => ({ ...c, text: 'R&D <b>bold</b> > less' }));

    await send({ contextText: escapeOnly });

    expect(submitReport).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(logToAxiom)
        .mock.calls.some(([line]) => (line as { subType?: string }).subType === 'send-xml')
    ).toBe(true);
  });

  it('sends both captures of an item edited between two filings that folded together', async () => {
    const held = contextText.find((c) => c.source === 'postText')!;
    const edited = { ...held, text: 'the edited words', capturedAt: '2026-10-12T09:00:00.000Z' };
    await send({ contextText: foldContextText([held], [edited]) });

    expect(submitReport).toHaveBeenCalledTimes(1);
    const doc = await parsed(buildReport(submitReport.mock.calls[0][0]));
    const infos = (
      doc.report.internetDetails.flatMap(
        (d: { webPageIncident: unknown[] }) => d.webPageIncident
      ) as {
        additionalInfo: string[];
      }[]
    ).map((i) => i.additionalInfo[0]);
    expect(infos).toHaveLength(2);
    expect(infos.filter((info) => info.includes('held <i>words</i> & more'))).toHaveLength(1);
    expect(infos.filter((info) => info.includes('the edited words'))).toHaveLength(1);
  });

  it('never sends the internal record of identical re-files', async () => {
    const marker = 'refile-marker-item:99';
    await send({
      contextText,
      identicalRefiles: [{ filedById: 10, at: '2026-10-12T09:00:00.000Z', item: marker }],
    });

    expect(submitReport).toHaveBeenCalledTimes(1);
    const sent = submitReport.mock.calls[0][0];
    const xml = buildReport(sent);
    expect(JSON.stringify(sent)).not.toContain(marker);
    expect(JSON.stringify(sent)).not.toContain('identicalRefiles');
    expect(xml).not.toContain(marker);
    expect(xml).toContain('held &lt;i&gt;words');
  });

  // A capture of a source this build can't send: what a newer build writes, read during a rolling
  // deploy or after a rollback.
  it('sends a report holding text it cannot send, without it, saying so and recording it with the send', async () => {
    const newer = {
      ...contextText[1],
      source: 'fromANewerBuild',
      id: 5,
    } as unknown as CsamContextText;
    await send({ contextText: [...contextText, newer, newer] });

    expect(submitReport).toHaveBeenCalledTimes(1);
    const sent = submitReport.mock.calls[0][0];
    expect(sent.incidentDetails.webPageIncidents.map((i: { url: string[] }) => i.url)).toEqual(
      webPages(contextText).map((i) => [i.url])
    );
    expect(sent.additionalInfo).toBe(
      '2 captured text items are not included in this submission. Civitai has preserved them with this report.'
    );
    const stamp = dbMock.dbWrite.csamReport.updateMany.mock.calls
      .map(([args]) => args as { data: { reportSentAt?: Date; details?: Record<string, unknown> } })
      .find(({ data }) => data.reportSentAt);
    expect(stamp?.data.details?.omittedContext).toEqual({ count: 2, onlyText: false });
    expect(stamp?.data.details?.contextText).toHaveLength(contextText.length + 2);
    expect(omittedAlerts()).toEqual([
      {
        name: 'csam-report',
        type: 'error',
        subType: 'send-omitted',
        reportId: 1,
        ncmecReportId: 99,
        message: 'report 1 sent without 2 captured text item(s)',
        payload: { count: 2, onlyText: false },
      },
    ]);
  });

  it('pages for text left out once NCMEC has the report, even when the stamp fails or loses its claim', async () => {
    const newer = { ...contextText[1], source: 'fromANewerBuild' } as unknown as CsamContextText;
    dbMock.dbWrite.csamReport.updateMany.mockImplementation((async (args: {
      data: { reportSentAt?: Date };
    }) => {
      if (args.data.reportSentAt) throw new Error('stamp response lost');
      return { count: 1 };
    }) as never);
    await expect(send({ contextText: [...contextText, newer] })).rejects.toThrow(
      'stamp response lost'
    );
    expect(omittedAlerts()).toHaveLength(1);

    vi.mocked(logToAxiom).mockClear();
    dbMock.dbWrite.csamReport.updateMany.mockImplementation((async (args: {
      data: { reportSentAt?: Date };
    }) => ({ count: args.data.reportSentAt ? 0 : 1 })) as never);
    await send({ contextText: [...contextText, newer] });
    expect(omittedAlerts()).toHaveLength(1);
  });

  it('does not page when the send fails before NCMEC has the report', async () => {
    const newer = { ...contextText[1], source: 'fromANewerBuild' } as unknown as CsamContextText;
    finishReport.mockRejectedValueOnce(new Error('finish failed'));
    await send({ contextText: [...contextText, newer] });

    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(omittedAlerts()).toEqual([]);
  });

  it.each([
    ['a made-up type', 'fromANewerBuild'],
    ['a chat message', 'chatMessage'],
    ['an article', 'article'],
  ])(
    'sends past 30 captures of %s taken at one time, counting each once',
    async (_label, source) => {
      const newer = Array.from(
        { length: 30 },
        (_, i) =>
          ({
            source,
            id: 700 + i,
            authorId: 20,
            authorIsReportedUser: true,
            text: `item ${i}`,
            capturedAt: '2026-10-08T14:05:00.000Z',
            capturedById: 10,
          } as unknown as CsamContextText)
      );
      await send({ contextText: [contextText[0], ...newer] });

      expect(submitReport).toHaveBeenCalledTimes(1);
      const sent = submitReport.mock.calls[0][0];
      expect(sent.incidentDetails.webPageIncidents).toHaveLength(1);
      expect(sent.additionalInfo).toBe(contextTextOmittedLine(30));
      const stamp = dbMock.dbWrite.csamReport.updateMany.mock.calls
        .map(
          ([args]) => args as { data: { reportSentAt?: Date; details?: Record<string, unknown> } }
        )
        .find(({ data }) => data.reportSentAt);
      expect(stamp?.data.details?.omittedContext).toEqual({ count: 30, onlyText: false });
      expect(JSON.stringify(sent)).not.toContain('item 0');
    }
  );

  it('says when every captured text was left out', async () => {
    const newer = { ...contextText[1], source: 'fromANewerBuild' } as unknown as CsamContextText;
    await send({ contextText: [newer] });

    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(submitReport.mock.calls[0][0]).not.toHaveProperty('incidentDetails');
    expect(submitReport.mock.calls[0][0].additionalInfo).toBe(
      'One captured text item is not included in this submission. Civitai has preserved it with this report.'
    );
    const stamp = dbMock.dbWrite.csamReport.updateMany.mock.calls
      .map(([args]) => args as { data: { reportSentAt?: Date; details?: Record<string, unknown> } })
      .find(({ data }) => data.reportSentAt);
    expect(stamp?.data.details?.omittedContext).toEqual({ count: 1, onlyText: true });
  });

  it('adds no page incident to a report with no attached text', async () => {
    await send({});

    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(submitReport.mock.calls[0][0]).not.toHaveProperty('incidentDetails');
  });
});
