import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { CIVITAI_BLOCKS_REACT_FLOOR, CIVITAI_SDK_FLOOR } from '@civitai/app-assistant/sdk-floor';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
import type * as ReviewAutodeployService from '~/server/services/blocks/review-autodeploy.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import type * as FliptClient from '~/server/flipt/client';

/**
 * `submitVersion`, through the real pipeline and the REAL BlockManifestValidator:
 *   - the deep manifest validation approve runs now refuses at submit, with every error, before
 *     anything is stored, against the same OAuth context approve uses;
 *   - a successful submit hands the new pending request to the follow-ups (moderator alert +
 *     automatic review preview) exactly once, and a throw there cannot fail the submit.
 */

vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

// The canonical db mock (src/__tests__/mocks/db.mock.ts): unset reads answer null / [].
const db = {
  createPublishRequest: dbMock.dbWrite.appBlockPublishRequest.create,
  pubReqFindFirst: dbMock.dbRead.appBlockPublishRequest.findFirst,
  appBlockFindFirst: dbMock.dbRead.appBlock.findFirst,
  appListingFindFirst: dbMock.dbRead.appListing.findFirst,
  appListingCreate: dbMock.dbWrite.appListing.create,
};

const storage = vi.hoisted(() => ({ commitFiles: vi.fn(async () => undefined) }));
vi.mock('~/utils/bundle-s3', () => ({
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  getBundleBucket: () => 'test-bucket',
  getBundleS3Client: () => ({ send: vi.fn().mockResolvedValue({}) }),
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  ensureReviewRepo: vi.fn().mockResolvedValue(undefined),
  commitFiles: storage.commitFiles,
}));

const followUps = vi.hoisted(() => ({
  onNewPendingSubmission: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
}));
vi.mock('~/server/services/blocks/review-autodeploy.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewAutodeployService>()),
  onNewPendingSubmission: (...a: unknown[]) => followUps.onNewPendingSubmission(...a),
}));

// Flipt is a process boundary: only App Assistant session tracing is answered here (off unless a
// case turns it on); every other flag evaluates as it does with no Flipt.
const tracing = vi.hoisted(() => ({ on: false }));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFlipt: (flag: string, ...rest: unknown[]) =>
      flag === 'app-assistant-tracing'
        ? Promise.resolve(tracing.on)
        : (actual.isFlipt as (...a: unknown[]) => Promise<boolean>)(flag, ...rest),
  };
});

const { submitVersion } = await import('~/server/services/blocks/publish-request.service');
const terms = await import('~/server/services/blocks/app-developer-terms.service');
const { ManifestValidationRefusal } = await import(
  '~/server/services/blocks/manifest-submit-validation'
);

const VALID = {
  blockId: 'my-app',
  version: '0.1.0',
  name: 'My App',
  contentRating: 'g',
  scopes: [],
  iframe: { minHeight: 300, maxHeight: 800, resizable: true, sandbox: 'allow-scripts' },
  page: { path: '/', title: 'My App' },
};

/** The submit refusal for a manifest with no surface, spelled as a literal. */
const NO_SURFACE =
  'manifest must declare at least one surface: add a "page" object for a full-page app ' +
  '(e.g. "page": { "path": "/", "title": "My App" }), or a non-empty "targets" array for a ' +
  'model-page slot app (e.g. "targets": [{ "slotId": "model.sidebar_top" }])';

async function bundle(
  manifest: Record<string, unknown>,
  extra: Record<string, string> = {}
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify(manifest));
  zip.file('index.html', '<!doctype html><html><body>hi</body></html>');
  for (const [path, text] of Object.entries(extra)) zip.file(path, text);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** A resolved submit's follow-up lands later, behind a dynamic import: let it land inside the
 *  test that caused it, so it cannot be counted by the next one. */
const settleFollowUps = () =>
  vi.waitFor(() => expect(followUps.onNewPendingSubmission).toHaveBeenCalled(), {
    timeout: 15_000,
  });

beforeEach(() => {
  vi.clearAllMocks();
  envMock.set({ APPS_DOMAIN: 'civit.ai' });
  db.pubReqFindFirst.mockResolvedValue(null);
  db.appBlockFindFirst.mockResolvedValue(null);
  db.appListingFindFirst.mockResolvedValue(null);
  db.createPublishRequest.mockResolvedValue({});
  db.appListingCreate.mockResolvedValue({ id: 'apl_draft' });
  followUps.onNewPendingSubmission.mockReset();
  followUps.onNewPendingSubmission.mockResolvedValue(undefined);
  tracing.on = false;
});

describe('submitVersion — deep manifest validation at submit', () => {
  it('CONTROL: a manifest approve would accept is queued', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });
    expect(result.slug).toBe('my-app');
    expect(db.createPublishRequest).toHaveBeenCalledTimes(1);
    await settleFollowUps();
  });

  it('refuses a manifest approve would refuse, with EVERY validator error, before anything is stored', async () => {
    const { iframe: _drop, contentRating: _rating, ...noIframe } = VALID;
    const run = submitVersion({
      bundleBuffer: await bundle(noIframe),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });

    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestValidationRefusal);
    const errors = (err as InstanceType<typeof ManifestValidationRefusal>).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^contentRating must be one of /),
        'iframe.minHeight must be a number in [40, 4000]',
        'iframe.resizable must be a boolean',
        'iframe.sandbox must be a non-empty string',
      ])
    );
    // Refused before the review-repo push and the row insert.
    expect(storage.commitFiles).not.toHaveBeenCalled();
    expect(db.createPublishRequest).not.toHaveBeenCalled();
    expect(followUps.onNewPendingSubmission).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['neither key', {}],
    ['an empty targets array', { targets: [] }],
    ['a null page', { page: null }],
    ['an empty targets array and an array page', { targets: [], page: [] }],
  ])('refuses a manifest with no surface (%s), naming the keys to add', async (_case, extra) => {
    const { page: _page, ...noSurface } = VALID;
    const err = await submitVersion({
      bundleBuffer: await bundle({ ...noSurface, ...extra }),
      submittedByUserId: 1,
      submitterIsModerator: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestValidationRefusal);
    expect((err as InstanceType<typeof ManifestValidationRefusal>).errors).toContain(NO_SURFACE);
    expect(storage.commitFiles).not.toHaveBeenCalled();
    expect(db.createPublishRequest).not.toHaveBeenCalled();
  });

  it('CONTROL: a slot-only manifest (non-empty targets, no page) is queued', async () => {
    const { page: _page, ...noPage } = VALID;
    await expect(
      submitVersion({
        bundleBuffer: await bundle({ ...noPage, targets: [{ slotId: 'model.sidebar_top' }] }),
        submittedByUserId: 1,
        submitterIsModerator: false,
      })
    ).resolves.toMatchObject({ slug: 'my-app' });
    await settleFollowUps();
  });

  it('a subsequent version is validated against the LIVE client’s origins, as at approve', async () => {
    // The app's client only registers some other origin, so the canonical iframe.src (stamped
    // onto every submit) is not bound to it: approve would refuse this, so submit does too.
    db.appBlockFindFirst.mockResolvedValue({
      id: 'apb_1',
      appId: 'app_1',
      trustTier: 'unverified',
      app: { userId: 1, allowedOrigins: ['https://elsewhere.civit.ai'] },
    });
    const err = await submitVersion({
      bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
      submittedByUserId: 1,
      submitterIsModerator: true,
    }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ManifestValidationRefusal>).errors).toContain(
      'iframe.src rejected: origin https://my-app.civit.ai not in OauthClient.allowedOrigins'
    );
    expect(db.createPublishRequest).not.toHaveBeenCalled();
  });

  it('CONTROL: the same subsequent version passes when the live client registers its origin', async () => {
    db.appBlockFindFirst.mockResolvedValue({
      id: 'apb_1',
      appId: 'app_1',
      trustTier: 'unverified',
      app: { userId: 1, allowedOrigins: ['https://MY-APP.civit.ai'] },
    });
    await expect(
      submitVersion({
        bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
        submittedByUserId: 1,
        submitterIsModerator: true,
      })
    ).resolves.toMatchObject({ slug: 'my-app' });
    await settleFollowUps();
  });

  it('validates against the SERVER-owned trust tier, not one the manifest declares', async () => {
    // allow-popups is refused for an unverified app and allowed for an internal one: declaring
    // `internal` in the manifest must not lift it for a new (unverified) app.
    const err = await submitVersion({
      bundleBuffer: await bundle({
        ...VALID,
        trustTier: 'internal',
        iframe: { ...VALID.iframe, sandbox: 'allow-scripts allow-popups' },
      }),
      submittedByUserId: 1,
      submitterIsModerator: false,
    }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ManifestValidationRefusal>).errors).toContain(
      'sandbox token "allow-popups" is not allowed for trustTier=unverified'
    );
    expect(db.createPublishRequest).not.toHaveBeenCalled();
  });
});

describe('submitVersion — follow-ups of a new pending request', () => {
  it('hands the new request to the follow-ups exactly once', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });
    // Fire-and-forget behind a dynamic import: wait for it rather than for one tick.
    await vi.waitFor(() => expect(followUps.onNewPendingSubmission).toHaveBeenCalled(), {
      timeout: 15_000,
    });
    await flush();
    expect(followUps.onNewPendingSubmission).toHaveBeenCalledTimes(1);
    expect(followUps.onNewPendingSubmission).toHaveBeenCalledWith({
      publishRequestId: result.publishRequestId,
      slug: 'my-app',
      version: '0.1.0',
      appName: 'My App',
      submittedByUserId: 1,
      origin: 'upload',
    });
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('trigger exploded');
      },
    ],
    [
      'rejects',
      async () => {
        throw new Error('trigger exploded');
      },
    ],
  ])('a follow-up that %s cannot fail the submit', async (_how, impl) => {
    followUps.onNewPendingSubmission.mockImplementation(impl as () => Promise<void>);
    await expect(
      submitVersion({
        bundleBuffer: await bundle(VALID),
        submittedByUserId: 1,
        submitterIsModerator: false,
      })
    ).resolves.toMatchObject({ slug: 'my-app' });
    // Fire-and-forget behind a dynamic import: wait for it rather than for one tick.
    await vi.waitFor(() => expect(followUps.onNewPendingSubmission).toHaveBeenCalled(), {
      timeout: 15_000,
    });
    await flush();
    expect(followUps.onNewPendingSubmission).toHaveBeenCalledTimes(1);
  });
});

/**
 * App Assistant session tracing at submit: `submitVersion` fires the REAL `recordSubmissionTrace`
 * once the request exists (its reads and writes land on the canonical db mock), and NOTHING the trace
 * does can fail or hold up the submit.
 */
describe('submitVersion — App Assistant session trace', () => {
  const links = dbMock.dbRead.appAssistantSessionLink.findMany;
  const writeTrace = dbMock.dbWrite.appPublishRequestTrace.create;

  it('with tracing on, records the new request’s trace: its id, slug, submitter and bundle signals', async () => {
    tracing.on = true;
    links.mockResolvedValueOnce([]);
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID),
      submittedByUserId: 7713,
      submitterIsModerator: false,
    });
    await vi.waitFor(() => expect(writeTrace).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    expect(links).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appSlug: 'my-app', userId: 7713 } })
    );
    const data = writeTrace.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      publishRequestId: result.publishRequestId,
      slug: 'my-app',
      userId: 7713,
      conversationIds: [],
      snapshots: [],
      signalsVersion: 2,
      snapshotError: null,
    });
    // The bundle's own index.html was read for the theme signal.
    expect(data.signals).toMatchObject({
      themeCustomized: false,
      accentCustomized: false,
      theme: { filesScanned: 1 },
    });
    await settleFollowUps();
  });

  it('with tracing off, writes no trace and reads no link', async () => {
    await submitVersion({
      bundleBuffer: await bundle(VALID),
      submittedByUserId: 7713,
      submitterIsModerator: false,
    });
    await settleFollowUps();
    await flush();
    expect(links).not.toHaveBeenCalled();
    expect(writeTrace).not.toHaveBeenCalled();
  });

  it('a trace whose every read and write fails never fails the submit', async () => {
    tracing.on = true;
    links.mockRejectedValueOnce(new Error('db down'));
    writeTrace.mockRejectedValueOnce(
      new Error('relation "app_publish_request_traces" does not exist')
    );
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID),
      submittedByUserId: 7713,
      submitterIsModerator: false,
    });
    expect(result.slug).toBe('my-app');
    await vi.waitFor(() => expect(writeTrace).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    await settleFollowUps();
  });

  it('a trace that never settles never holds the submit up', async () => {
    tracing.on = true;
    links.mockImplementationOnce(() => new Promise(() => undefined));
    const outcome = await Promise.race([
      submitVersion({
        bundleBuffer: await bundle(VALID),
        submittedByUserId: 7713,
        submitterIsModerator: false,
      }).then(() => 'submitted'),
      new Promise((resolve) => setTimeout(() => resolve('held up'), 5_000)),
    ]);
    expect(outcome).toBe('submitted');
    await settleFollowUps();
  });
});

/**
 * WARN, NEVER BLOCK: the submit answers `advisories`, whatever the tracing flag says. A bundle with
 * Civitai's stock look is queued all the same, with the `default-theme` note.
 */
describe('submitVersion — advisories', () => {
  const DEFAULT_THEME = {
    code: 'default-theme',
    message:
      "This app uses Civitai's default theme. A distinct accent helps it stand out in the store: https://developer.civitai.com/apps/guide/theming#give-your-app-its-own-look",
    docsUrl: 'https://developer.civitai.com/apps/guide/theming#give-your-app-its-own-look',
  };

  it('a bundle with the stock look is queued, with the default-theme advisory (tracing off)', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID, {
        // A colour literal of its own (v1 reads "customised") but no colour token: still stock.
        'src/index.css': '.card { border-color: #333333; --civitai-radius: 4px; }',
      }),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });
    expect(db.createPublishRequest).toHaveBeenCalledTimes(1);
    expect(result.advisories).toEqual([DEFAULT_THEME]);
    await settleFollowUps();
  });

  it('a bundle with its own accent is queued with no advisory', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID, {
        'src/index.css': '.app { --civitai-color-primary: #7c3aed; }',
      }),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });
    expect(db.createPublishRequest).toHaveBeenCalledTimes(1);
    expect(result.advisories).toEqual([]);
    await settleFollowUps();
  });

  /** An own accent, so the only advisory a case can get is the SDK one. */
  const OWN_ACCENT = { 'src/index.css': '.app { --civitai-color-primary: #7c3aed; }' };
  const lock = (sdk: string, react: string) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/@civitai/sdk': { version: sdk },
        'node_modules/@civitai/blocks-react': { version: react },
      },
    });
  const storedFileSummary = () =>
    (
      db.createPublishRequest.mock.calls[0]![0] as unknown as {
        data: { fileSummary: Record<string, unknown> };
      }
    ).data.fileSummary;

  it('a below-floor lockfile is queued with an sdk-below-floor advisory per package, and the override is recorded', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID, {
        ...OWN_ACCENT,
        'package.json': JSON.stringify({ dependencies: { '@civitai/sdk': '^0.33.0' } }),
        'package-lock.json': lock('0.31.4', '0.80.2'),
      }),
      submittedByUserId: 1,
      submitterIsModerator: false,
      sdkFloorOverride: [
        { package: '@civitai/sdk', installed: '0.31.4', minimum: CIVITAI_SDK_FLOOR },
      ],
    });
    expect(db.createPublishRequest).toHaveBeenCalledTimes(1);
    expect(result.advisories.map((a) => [a.code, a.message])).toEqual([
      [
        'sdk-below-floor',
        `This app's package-lock.json installs @civitai/sdk 0.31.4, below the platform minimum ${CIVITAI_SDK_FLOOR}. Upgrade with \`npm install @civitai/sdk@latest\` and resubmit. The submit was not refused; a moderator sees the version.`,
      ],
      [
        'sdk-below-floor',
        `This app's package-lock.json installs @civitai/blocks-react 0.80.2, below the platform minimum ${CIVITAI_BLOCKS_REACT_FLOOR}. Upgrade with \`npm install @civitai/blocks-react@latest\` and resubmit. The submit was not refused; a moderator sees the version.`,
      ],
    ]);
    expect(storedFileSummary().sdkFloor).toEqual({
      lockfile: 'package-lock.json',
      lockfileStatus: 'read',
      below: [
        { package: '@civitai/sdk', installed: '0.31.4', minimum: CIVITAI_SDK_FLOOR },
        {
          package: '@civitai/blocks-react',
          installed: '0.80.2',
          minimum: CIVITAI_BLOCKS_REACT_FLOOR,
        },
      ],
      override: [{ package: '@civitai/sdk', installed: '0.31.4', minimum: CIVITAI_SDK_FLOOR }],
    });
    // The file diff the review reads is still there beside it.
    expect(Array.isArray(storedFileSummary().files)).toBe(true);
    await settleFollowUps();
  });

  it('CONTROL: an at-floor lockfile answers no SDK advisory and records nothing', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID, {
        ...OWN_ACCENT,
        'package-lock.json': lock(CIVITAI_SDK_FLOOR, CIVITAI_BLOCKS_REACT_FLOOR),
      }),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });
    expect(result.advisories).toEqual([]);
    expect(storedFileSummary()).not.toHaveProperty('sdkFloor');
    await settleFollowUps();
  });

  it('pnpm run build: the at-floor pnpm-lock.yaml is read, never the stale package-lock.json beside it', async () => {
    const pnpmLock = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      "      '@civitai/blocks-react':",
      `        specifier: ^${CIVITAI_BLOCKS_REACT_FLOOR}`,
      `        version: ${CIVITAI_BLOCKS_REACT_FLOOR}(react@19.0.0)`,
      "      '@civitai/sdk':",
      `        specifier: ^${CIVITAI_SDK_FLOOR}`,
      `        version: ${CIVITAI_SDK_FLOOR}`,
      '',
    ].join('\n');
    // The override makes the reading recorded, so the lockfile it names is observable.
    const override = [{ package: '@civitai/sdk', installed: '0.29.1', minimum: CIVITAI_SDK_FLOOR }];
    const result = await submitVersion({
      bundleBuffer: await bundle(
        { ...VALID, buildCommand: 'pnpm run build', outputDir: 'dist' },
        {
          ...OWN_ACCENT,
          'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
          'package-lock.json': lock('0.30.0', '0.79.0'),
          'pnpm-lock.yaml': pnpmLock,
        }
      ),
      submittedByUserId: 1,
      submitterIsModerator: false,
      sdkFloorOverride: override,
    });
    expect(db.createPublishRequest).toHaveBeenCalledTimes(1);
    expect(result.advisories).toEqual([]);
    expect(storedFileSummary().sdkFloor).toEqual({
      lockfile: 'pnpm-lock.yaml',
      lockfileStatus: 'read',
      below: [],
      override,
    });
    await settleFollowUps();
  });

  it('a malformed lockfile: the submit still succeeds, with no SDK advisory and nothing recorded', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID, {
        ...OWN_ACCENT,
        'package-lock.json': '{"lockfileVersion": 3, "packages": {"node_modules/@civitai/sdk": ',
      }),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });
    expect(db.createPublishRequest).toHaveBeenCalledTimes(1);
    expect(result.advisories).toEqual([]);
    expect(storedFileSummary()).not.toHaveProperty('sdkFloor');
    await settleFollowUps();
  });

  it('a malformed lockfile with an override: the reading is recorded as unreadable, not absent', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID, {
        ...OWN_ACCENT,
        'package-lock.json': 'not json at all',
      }),
      submittedByUserId: 1,
      submitterIsModerator: false,
      sdkFloorOverride: [
        { package: '@civitai/sdk', installed: '0.29.1', minimum: CIVITAI_SDK_FLOOR },
      ],
    });
    expect(result.advisories).toEqual([]);
    expect(storedFileSummary().sdkFloor).toEqual({
      lockfile: 'package-lock.json',
      lockfileStatus: 'unreadable',
      below: [],
      override: [{ package: '@civitai/sdk', installed: '0.29.1', minimum: CIVITAI_SDK_FLOOR }],
    });
    await settleFollowUps();
  });

  it('with tracing on, the advisory is the same', async () => {
    tracing.on = true;
    dbMock.dbRead.appAssistantSessionLink.findMany.mockResolvedValueOnce([]);
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });
    expect(result.advisories).toEqual([DEFAULT_THEME]);
    await vi.waitFor(
      () => expect(dbMock.dbWrite.appPublishRequestTrace.create).toHaveBeenCalledTimes(1),
      { timeout: 15_000 }
    );
    await settleFollowUps();
  });
});

describe('submitVersion — a staff submit on the owner’s behalf (platform update)', () => {
  const ON_BEHALF = {
    platformUpdateId: 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0',
    staffUsername: 'mod-ana',
    ownerUserId: 7101,
    ownerUsername: 'owner-olga',
  };
  const existingApp = () =>
    db.appBlockFindFirst.mockResolvedValue({
      id: 'apb_1',
      appId: 'app_1',
      trustTier: 'unverified',
      app: { userId: 7101, allowedOrigins: ['https://my-app.civit.ai'] },
    });

  it('files the request with the MODERATOR as its submitter, and records who it was for', async () => {
    existingApp();
    await submitVersion({
      bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
      submittedByUserId: 8001,
      submitterIsModerator: true,
      onBehalf: ON_BEHALF,
    });
    expect(db.createPublishRequest).toHaveBeenCalledTimes(1);
    const data = (
      db.createPublishRequest.mock.calls[0]![0] as unknown as {
        data: {
          submittedByUserId: number;
          appBlockId: string;
          fileSummary: Record<string, unknown>;
        };
      }
    ).data;
    expect(data.submittedByUserId).toBe(8001);
    expect(data.appBlockId).toBe('apb_1');
    expect(data.fileSummary.onBehalf).toEqual({ ...ON_BEHALF, staffUserId: 8001 });
    expect(Array.isArray(data.fileSummary.files)).toBe(true);
    await settleFollowUps();
  });

  it('refuses an on-behalf submit from a non-moderator, before anything is stored', async () => {
    existingApp();
    await expect(
      submitVersion({
        bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
        submittedByUserId: 8002,
        submitterIsModerator: false,
        onBehalf: ON_BEHALF,
      })
    ).rejects.toThrow('only a moderator can submit on behalf of an app owner');
    expect(db.createPublishRequest).not.toHaveBeenCalled();
  });

  describe('the App Developer Terms: the OWNER’s acceptance, never the moderator’s', () => {
    const MODERATOR = 8001;
    const OWNER_REFUSAL = "The app's owner has not accepted the current App Developer Terms yet.";
    const SUBMITTER_REFUSAL = 'Accept the App Developer Terms';
    const accepted = (ids: number[]) => {
      vi.mocked(terms.hasAcceptedAppDeveloperTerms).mockImplementation(async (id) =>
        ids.includes(id)
      );
      vi.mocked(terms.assertAcceptedAppDeveloperTerms).mockImplementation(async (id) => {
        if (!ids.includes(id)) throw new Error(`${SUBMITTER_REFUSAL} (user ${id})`);
      });
    };
    afterEach(() => {
      vi.mocked(terms.hasAcceptedAppDeveloperTerms).mockImplementation(async () => true);
      vi.mocked(terms.assertAcceptedAppDeveloperTerms).mockImplementation(async () => undefined);
    });

    it('files when the owner accepted and the moderator never did', async () => {
      existingApp();
      accepted([ON_BEHALF.ownerUserId]);
      await submitVersion({
        bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
        submittedByUserId: MODERATOR,
        submitterIsModerator: true,
        onBehalf: ON_BEHALF,
      });
      expect(db.createPublishRequest).toHaveBeenCalledTimes(1);
      expect(terms.assertAcceptedAppDeveloperTerms).not.toHaveBeenCalled();
      expect(terms.hasAcceptedAppDeveloperTerms).toHaveBeenCalledWith(ON_BEHALF.ownerUserId);
      expect(terms.hasAcceptedAppDeveloperTerms).not.toHaveBeenCalledWith(MODERATOR);
      await settleFollowUps();
    });

    it('refuses, naming the owner, when the owner has not accepted (even though the moderator has)', async () => {
      existingApp();
      accepted([MODERATOR]);
      const err = await submitVersion({
        bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
        submittedByUserId: MODERATOR,
        submitterIsModerator: true,
        onBehalf: ON_BEHALF,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(terms.AppDeveloperTermsNotAcceptedError);
      expect((err as Error).message.startsWith(OWNER_REFUSAL)).toBe(true);
      expect(db.createPublishRequest).not.toHaveBeenCalled();
    });

    it('a moderator who OWNS the app still needs their acceptance as owner on an on-behalf submit', async () => {
      existingApp();
      accepted([]);
      const err = await submitVersion({
        bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
        submittedByUserId: ON_BEHALF.ownerUserId,
        submitterIsModerator: true,
        onBehalf: ON_BEHALF,
      }).catch((e: unknown) => e);
      expect((err as Error).message.startsWith(OWNER_REFUSAL)).toBe(true);
      expect(db.createPublishRequest).not.toHaveBeenCalled();
    });

    it('refuses an on-behalf submit whose recorded owner is not the app’s owner', async () => {
      db.appBlockFindFirst.mockResolvedValue({
        id: 'apb_1',
        appId: 'app_1',
        trustTier: 'unverified',
        app: { userId: 7202, allowedOrigins: ['https://my-app.civit.ai'] },
      });
      await expect(
        submitVersion({
          bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
          submittedByUserId: MODERATOR,
          submitterIsModerator: true,
          onBehalf: ON_BEHALF,
        })
      ).rejects.toThrow(
        "the app's owner is not the owner this update was submitted for; reload and retry"
      );
      expect(db.createPublishRequest).not.toHaveBeenCalled();
    });

    it('CONTROL: an ordinary moderator submit still needs the moderator’s own acceptance', async () => {
      existingApp();
      accepted([ON_BEHALF.ownerUserId]);
      await expect(
        submitVersion({
          bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
          submittedByUserId: MODERATOR,
          submitterIsModerator: true,
        })
      ).rejects.toThrow(`${SUBMITTER_REFUSAL} (user ${MODERATOR})`);
      expect(terms.assertAcceptedAppDeveloperTerms).toHaveBeenCalledWith(MODERATOR);
      expect(db.createPublishRequest).not.toHaveBeenCalled();
    });
  });

  describe('the owner submits while a staff submission is pending', () => {
    // The owner may ship the app (the access read the submit gates on).
    beforeEach(() => {
      dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
        id: 'apb_1',
        app: { userId: ON_BEHALF.ownerUserId },
        appListing: null,
      });
    });
    afterEach(() => {
      dbMock.dbRead.appBlock.findUnique.mockResolvedValue(null);
      db.pubReqFindFirst.mockReset();
    });
    it('is refused with a message naming the staff submission and the staff member', async () => {
      existingApp();
      db.pubReqFindFirst.mockImplementation(async (a: { where: { status?: string } }) =>
        a.where.status === 'pending'
          ? {
              id: 'pubreq_staff',
              submittedByUserId: 8001,
              fileSummary: { files: [], onBehalf: { ...ON_BEHALF, staffUserId: 8001 } },
            }
          : null
      );
      await expect(
        submitVersion({
          bundleBuffer: await bundle({ ...VALID, version: '0.3.0' }),
          submittedByUserId: ON_BEHALF.ownerUserId,
          submitterIsModerator: false,
        })
      ).rejects.toThrow(
        'slug my-app has a pending Civitai staff submission of a platform update by mod-ana, ' +
          'under review; your submit can go through once it is reviewed'
      );
      expect(db.createPublishRequest).not.toHaveBeenCalled();
    });

    it('CONTROL: another user’s ordinary pending request keeps the generic refusal', async () => {
      existingApp();
      db.pubReqFindFirst.mockImplementation(async (a: { where: { status?: string } }) =>
        a.where.status === 'pending'
          ? { id: 'pubreq_other', submittedByUserId: 7202, fileSummary: { files: [] } }
          : null
      );
      await expect(
        submitVersion({
          bundleBuffer: await bundle({ ...VALID, version: '0.3.0' }),
          submittedByUserId: ON_BEHALF.ownerUserId,
          submitterIsModerator: false,
        })
      ).rejects.toThrow(
        'slug my-app already has a pending submission from another user; wait for it to be ' +
          'reviewed before submitting a different bundle'
      );
    });
  });

  it('CONTROL: an ordinary submit records no on-behalf line', async () => {
    existingApp();
    await submitVersion({
      bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
      submittedByUserId: 8001,
      submitterIsModerator: true,
    });
    const data = (
      db.createPublishRequest.mock.calls[0]![0] as unknown as {
        data: { fileSummary: Record<string, unknown> };
      }
    ).data;
    expect(data.fileSummary).not.toHaveProperty('onBehalf');
    await settleFollowUps();
  });
});
