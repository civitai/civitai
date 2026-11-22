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
import type { CsamContextText, CsamItemContextText } from '~/server/services/csam-context-text';
import { contextIncidents, foldContextText } from '~/server/services/csam-context-text';

const webPages = (c: CsamContextText[] | undefined) => contextIncidents(c).webPageIncidents;
import { logToAxiom } from '~/server/logging/client';
import { xmlProblem } from '~/server/services/ncmec-xml';

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
    expect(received).toEqual(webPages(contextText));
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

  it('sends a chat message as a chat incident and the other item types and post text as page incidents, one per internetDetails', async () => {
    const item = (over: Partial<CsamItemContextText>): CsamItemContextText => ({
      source: 'model',
      id: 1,
      authorId: 20,
      authorIsReportedUser: true,
      fields: [{ label: 'Name', text: HOSTILE }],
      text: `Name:\n${HOSTILE}`,
      capturedAt: '2026-10-08T14:05:00.000Z',
      capturedById: 10,
      ...over,
    });
    const items = [
      item({ source: 'chatMessage', id: 901, fields: [{ label: 'Message', text: HOSTILE }] }),
      item({ source: 'model', id: 701, status: 'Draft' }),
      item({ source: 'article', id: 801, status: 'Published' }),
      item({ source: 'serviceOffering', id: 1001, status: 'Paused' }),
      item({
        source: 'profile',
        id: 20,
        username: 'user',
        fields: [{ label: 'Bio', text: HOSTILE }],
      }),
    ];
    const post = contextText[0];
    await send({ contextText: [post, ...items] });

    expect(submitReport).toHaveBeenCalledTimes(1);
    const xml = buildReport(submitReport.mock.calls[0][0]);
    expect(xmlProblem(xml)).toBeNull();
    const doc = await parsed(xml);
    const details = doc.report.internetDetails as {
      webPageIncident?: { url: string[]; additionalInfo: string[] }[];
      chatImIncident?: { chatClient: string[]; content: string[]; additionalInfo: string[] }[];
    }[];
    const pages = details.flatMap((d) => d.webPageIncident ?? []);
    const chats = details.flatMap((d) => d.chatImIncident ?? []);
    const expected = contextIncidents([post, ...items]);
    expect(
      details.map((d) => (d.webPageIncident?.length ?? 0) + (d.chatImIncident?.length ?? 0))
    ).toEqual([1, 1, 1, 1, 1, 1]);

    expect(pages.map((p) => ({ url: p.url[0], additionalInfo: p.additionalInfo[0] }))).toEqual(
      expected.webPageIncidents
    );
    expect(
      chats.map((c) => ({
        chatClient: c.chatClient[0],
        content: c.content[0],
        additionalInfo: c.additionalInfo[0],
      }))
    ).toEqual(expected.chatImIncidents);
    expect(pages.map((p) => new URL(p.url[0]).pathname)).toEqual([
      '/posts/100',
      '/models/701',
      '/articles/801',
      '/services/1001',
      '/user/user',
    ]);
    expect(chats).toHaveLength(1);
    expect(chats[0].content[0]).toContain('R&D <b>bold</b> > less');
    expect(chats[0].content[0]).toContain('nul\uFFFD bell\uFFFD lone\uFFFD surrogate');
    expect(
      vi
        .mocked(logToAxiom)
        .mock.calls.find(
          ([line]) => (line as { subType?: string }).subType === 'send-incidents'
        )?.[0]
    ).toEqual({
      name: 'csam-report',
      type: 'info',
      subType: 'send-incidents',
      payload: { webPageIncidents: 5, chatImIncidents: 1 },
    });
  });

  it('sends a profile with no username as a page incident with no url', async () => {
    const profile: CsamItemContextText = {
      source: 'profile',
      id: 20,
      authorId: 20,
      authorIsReportedUser: true,
      fields: [{ label: 'Bio (civitai.red and civitai.com)', text: 'bio words' }],
      text: 'Bio (civitai.red and civitai.com):\nbio words',
      capturedAt: '2026-10-08T14:05:00.000Z',
      capturedById: 10,
    };
    await send({ contextText: [profile] });

    expect(submitReport).toHaveBeenCalledTimes(1);
    const xml = buildReport(submitReport.mock.calls[0][0]);
    expect(xmlProblem(xml)).toBeNull();
    const doc = await parsed(xml);
    const [page] = doc.report.internetDetails[0].webPageIncident;
    expect(page.url).toBeUndefined();
    expect(page.additionalInfo[0]).toContain('"bio words"');
    // The profile line names the same account as the reported-person block.
    const espIdentifier =
      doc.report.reportedPerson?.[0]?.espIdentifier?.[0] ??
      doc.report.personOrUserReported[0].espIdentifier[0];
    expect(page.additionalInfo[0]).toContain(
      `Profile of the account reported in this CyberTip (user id ${espIdentifier}; username at capture none).`
    );
    expect(espIdentifier).toBe('20');
  });

  it('adds no page incident to a report with no attached text', async () => {
    await send({});

    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(submitReport.mock.calls[0][0]).not.toHaveProperty('incidentDetails');
  });
});
