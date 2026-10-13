import { useState } from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  onTestFinished,
  test,
  vi,
} from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import {
  chooseFiles,
  makeFilesExpireAfterFirstRead,
  makeFullReadsFail,
  makeSlowFilesStall,
  makeUnreadableFilesFail,
} from '../../../../test/unreadable-files';
import type * as DialogStoreModule from '~/components/Dialog/dialogStore';
import type * as CanvasUtils from '~/shared/utils/canvas-utils';
import type * as ImageUtils from '~/utils/image-utils';
import type * as Constants from '~/server/common/constants';
import type * as ApplicationError from '~/utils/application-error';
import type * as AuthHelpers from '~/utils/auth-helpers';
import type * as ConsumerBlobUpload from '~/utils/consumer-blob-upload';
import type * as SessionProviderModule from '~/providers/SessionProvider';
import type * as ClientEnv from '~/env/client';
import type * as DeviceHelpers from '~/utils/device-helpers';

/**
 * A failed source-image upload must end on an error card with the spinner cleared, and must not
 * start the upload again. The upload pipeline below the component (dimensions, resize, re-encode,
 * consumer-blob upload) is mocked so each test controls when, and how, every upload settles.
 */

const mocks = vi.hoisted(() => ({
  uploadConsumerBlob: vi.fn(),
  getImageDimensions: vi.fn(),
  dialogTrigger: vi.fn(),
  reportApplicationError: vi.fn(),
  openLoginPopup: vi.fn(),
  /** Signed in unless a test signs out. */
  currentUser: { id: 1 } as { id: number } | null,
  sessionLoading: false,
  /** A loadable local url the uploader treats as already uploaded (no network request). */
  orchestratorUrl: '',
  /** Android unless a test says otherwise: the Files fallback is offered only there. */
  android: true,
}));

vi.mock('~/utils/device-helpers', async (orig) => ({
  ...(await orig<typeof DeviceHelpers>()),
  isAndroidDevice: () => mocks.android,
}));

vi.mock('~/utils/consumer-blob-upload', async (orig) => ({
  ...(await orig<typeof ConsumerBlobUpload>()),
  uploadConsumerBlob: mocks.uploadConsumerBlob,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));

// Outside a provider useSession reports 'loading'; resolved here from the mocked user unless a test
// holds the session in its loading state.
vi.mock('~/providers/SessionProvider', async (orig) => ({
  ...(await orig<typeof SessionProviderModule>()),
  useSession: () => ({
    data: undefined,
    status: mocks.sessionLoading
      ? 'loading'
      : mocks.currentUser
      ? 'authenticated'
      : 'unauthenticated',
    update: async () => null,
  }),
}));

vi.mock('~/utils/auth-helpers', async (orig) => ({
  ...(await orig<typeof AuthHelpers>()),
  openLoginPopup: mocks.openLoginPopup,
}));

vi.mock('~/utils/image-utils', async (orig) => ({
  ...(await orig<typeof ImageUtils>()),
  getImageDimensions: mocks.getImageDimensions,
}));

vi.mock('~/shared/utils/canvas-utils', async (orig) => ({
  ...(await orig<typeof CanvasUtils>()),
  resizeImage: vi.fn(async () => new Blob(['resized'], { type: 'image/png' })),
  imageToJpegBlob: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
}));

vi.mock('~/server/common/constants', async (orig) => {
  const actual = await orig<typeof Constants>();
  return {
    ...actual,
    isOrchestratorUrl: (url: string) =>
      (!!mocks.orchestratorUrl && url === mocks.orchestratorUrl) || actual.isOrchestratorUrl(url),
  };
});

vi.mock('~/utils/application-error', async (orig) => ({
  ...(await orig<typeof ApplicationError>()),
  reportApplicationError: mocks.reportApplicationError,
}));

// The image CDN's location, so a report can tell a CDN url from any other.
const { IMAGE_LOCATION } = vi.hoisted(() => ({ IMAGE_LOCATION: 'https://cdn.example.test/loc' }));
vi.mock('~/env/client', async (orig) => {
  const actual = await orig<typeof ClientEnv>();
  return { ...actual, env: { ...actual.env, NEXT_PUBLIC_IMAGE_LOCATION: IMAGE_LOCATION } };
});

vi.mock('~/utils/metadata/extract-source-metadata', () => ({
  extractSourceMetadata: vi.fn(async () => undefined),
  extractSourceMetadataFromUrl: vi.fn(async () => undefined),
}));

// Only `trigger` is replaced, so the crop modal's callbacks can be driven directly.
vi.mock('~/components/Dialog/dialogStore', async (orig) => {
  const actual = await orig<typeof DialogStoreModule>();
  return { ...actual, dialogStore: { ...actual.dialogStore, trigger: mocks.dialogTrigger } };
});

// eslint-disable-next-line import/first
import { sourceMetadataStore } from '~/store/source-metadata.store';
// eslint-disable-next-line import/first
import { ImagePrepError, imageToJpegBlob, resizeImage } from '~/shared/utils/canvas-utils';
// eslint-disable-next-line import/first
import {
  IMAGE_PREP_STAGE_TIMEOUT_MS,
  useImagesUploadingOrVerifying,
  useImagesUploadingStore,
} from '~/components/Generation/Input/SourceImageUploadMultiple';
// eslint-disable-next-line import/first
import { isPickSnapshot, UNREADABLE_PROBE_TIMEOUT_MS } from '~/utils/unreadable-pick';
// eslint-disable-next-line import/first
import { extractSourceMetadata } from '~/utils/metadata/extract-source-metadata';
// eslint-disable-next-line import/first
import { maxOrchestratorImageFileSize } from '~/server/common/constants';
// eslint-disable-next-line import/first
import {
  ImageUploadMultipleInput,
  type ImageValue,
} from '~/components/generation_v2/inputs/ImageUploadMultipleInput';

const PRESIGN_ERROR = 'Failed to get upload URL';

beforeEach(() => {
  mocks.currentUser = { id: 1 };
  mocks.sessionLoading = false;
  mocks.android = true;
  mocks.openLoginPopup.mockReset();
});

type Deferred = { resolve: (v: unknown) => void; reject: (e: Error) => void; settled: boolean };
let uploads: Deferred[] = [];

function Harness(props: {
  max?: number;
  aspectRatios?: `${number}:${number}`[];
  layout?: 'default' | 'url-input';
}) {
  const [value, setValue] = useState<ImageValue[]>([]);
  // Ignores a write equal to the current value, as the form store does (it diffs field values with
  // deepEqual). Without it the input's empty-value write (a new `[]` each time nothing has
  // completed) re-renders it forever.
  const onChange = (next: ImageValue[]) =>
    setValue((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  return (
    <div data-testid="source-images">
      <ImageUploadMultipleInput value={value} onChange={onChange} max={props.max ?? 3} {...props} />
    </div>
  );
}

const imageFile = (name: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });

async function pickFiles(count: number) {
  const input = await vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(
      '[data-testid="source-images"] input[type=file]'
    );
    if (!el) throw new Error('file input not found');
    return el;
  });
  await userEvent.upload(
    input,
    Array.from({ length: count }, (_, i) => imageFile(`photo-${i}.jpg`))
  );
}

const loaderCount = () =>
  document.querySelectorAll('[data-testid="source-images"] .mantine-Loader-root').length;
const pending = () => uploads.filter((u) => !u.settled);
/** A url the preview <img> can load; an unloadable one makes the card remove itself. */
async function loadableImageUrl() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
  return URL.createObjectURL(blob);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Settles uploads one at a time, oldest first, letting each outcome render before the next. Stops
 * only once no new upload has started for 500ms, so a late re-upload is settled and counted too,
 * or after MAX_SETTLES, so an upload loop ends the test instead of hanging it.
 */
const MAX_SETTLES = 20;
async function settleOneByOne(outcome: 'reject' | 'resolve') {
  for (let settled = 0; settled < MAX_SETTLES; settled++) {
    const upload = pending()[0];
    if (!upload) {
      await sleep(500);
      if (!pending().length) return;
      continue;
    }
    upload.settled = true;
    if (outcome === 'reject') upload.reject(new Error(PRESIGN_ERROR));
    else upload.resolve({ url: await loadableImageUrl(), available: true });
    await sleep(100);
  }
}

describe('SourceImageUploadMultiple — failed uploads', () => {
  beforeEach(() => {
    uploads = [];
    mocks.uploadConsumerBlob.mockReset().mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          uploads.push({ resolve, reject, settled: false });
        })
    );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.dialogTrigger.mockReset();
  });

  test('each picked image is uploaded once when the uploads fail', async () => {
    renderWithProviders(<Harness />);
    await pickFiles(3);
    await vi.waitFor(() => expect(uploads).toHaveLength(3));

    await settleOneByOne('reject');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(3);
    await expect.poll(() => page.getByText(PRESIGN_ERROR).elements().length).toBe(3);
    expect(loaderCount()).toBe(0);
  });

  test('each picked image is uploaded once when the uploads succeed', async () => {
    renderWithProviders(<Harness />);
    await pickFiles(3);
    await vi.waitFor(() => expect(uploads).toHaveLength(3));

    await settleOneByOne('resolve');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(3);
    await expect.poll(() => page.getByText('1024 x 1024').elements().length).toBe(3);
  });

  test('an upload that throws before reaching the server ends on an error card, not a spinner', async () => {
    // The upload's own read of the picked image fails; the earlier dimension check (which passes
    // options) succeeds.
    mocks.getImageDimensions.mockImplementation(async (src: unknown, options?: unknown) => {
      if (typeof src === 'string' && !options) throw new Error('Image failed to load');
      return { width: 1024, height: 1024 };
    });
    renderWithProviders(<Harness />);
    await pickFiles(1);

    await expect
      .element(
        page.getByText(
          "Couldn't read this image on your device. Try a different file or a screenshot.",
          {
            exact: true,
          }
        )
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain('Image failed to load');
    await expect.poll(loaderCount).toBe(0);
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
  });

  test('a failed upload after cropping shows the error', async () => {
    mocks.getImageDimensions.mockResolvedValue({ width: 600, height: 2000 });
    renderWithProviders(<Harness max={1} aspectRatios={['1:1']} />);
    await pickFiles(1);

    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));
    const { onConfirm, images } = mocks.dialogTrigger.mock.calls[0][0].props;
    onConfirm([{ src: images[0].url, cropped: new Blob(['cropped'], { type: 'image/jpeg' }) }]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await settleOneByOne('reject');

    await expect.element(page.getByText(PRESIGN_ERROR)).toBeVisible();
    expect(loaderCount()).toBe(0);
  });

  const submitUrl = async (url: string) => {
    await userEvent.fill(page.getByPlaceholder('Add a file or provide a URL'), url);
    await userEvent.keyboard('{Enter}');
  };

  test('the same URL added again after its upload failed is uploaded once more, not looped', async () => {
    renderWithProviders(<Harness layout="url-input" />);

    await submitUrl('https://example.com/a.jpg');
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await settleOneByOne('reject');
    await expect.element(page.getByText(PRESIGN_ERROR)).toBeVisible();

    await submitUrl('https://example.com/a.jpg');
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    await settleOneByOne('reject');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(2);
    await expect.poll(() => page.getByText(PRESIGN_ERROR).elements().length).toBe(2);
    expect(loaderCount()).toBe(0);
  });

  test('the same URL added twice at once, uploads fail: each card uploads once', async () => {
    renderWithProviders(<Harness layout="url-input" />);

    await submitUrl('https://example.com/a.jpg');
    await submitUrl('https://example.com/a.jpg');
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    await settleOneByOne('reject');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(2);
    await expect.poll(() => page.getByText(PRESIGN_ERROR).elements().length).toBe(2);
    expect(loaderCount()).toBe(0);
  });

  test('the same URL added twice at once, uploads succeed: each card uploads once', async () => {
    renderWithProviders(<Harness layout="url-input" />);

    await submitUrl('https://example.com/a.jpg');
    await submitUrl('https://example.com/a.jpg');
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    await settleOneByOne('resolve');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(2);
    await expect.poll(() => page.getByText('1024 x 1024').elements().length).toBe(2);
    expect(loaderCount()).toBe(0);
  });

  test('the same URL added twice at once: each card takes its own upload outcome', async () => {
    renderWithProviders(<Harness layout="url-input" />);

    await submitUrl('https://example.com/a.jpg');
    await submitUrl('https://example.com/a.jpg');
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    uploads[0].settled = true;
    uploads[0].reject(new Error(PRESIGN_ERROR));
    // Exactly one error: a by-url update would turn both cards into errors here.
    await expect.element(page.getByText(PRESIGN_ERROR)).toBeVisible();
    await settleOneByOne('resolve');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(2);
    await expect.poll(() => page.getByText('1024 x 1024').elements().length).toBe(1);
    expect(page.getByText(PRESIGN_ERROR).elements()).toHaveLength(1);
    expect(loaderCount()).toBe(0);
  });

  // Invariant guard: an image that has not started uploading already held the generator before
  // the queued state existed.
  test('a queued card shows the Loader and holds the generator until its upload starts', async () => {
    const pendingChecks: ((dims: { width: number; height: number }) => void)[] = [];
    const resolveDims = (dims: { width: number; height: number }) =>
      pendingChecks.splice(0).forEach((resolve) => resolve(dims));
    // The dimension check (the one that passes options) stays pending, so the card stays queued.
    mocks.getImageDimensions.mockImplementation((_src: unknown, options?: unknown) =>
      options
        ? new Promise((resolve) => pendingChecks.push(resolve))
        : Promise.resolve({ width: 1024, height: 1024 })
    );
    // Settled however the test ends: a check left pending outlives the test, and its 30s bound
    // then reports a timeout into whichever later test is running.
    onTestFinished(() => resolveDims({ width: 1024, height: 1024 }));
    renderWithProviders(<Harness />);
    await pickFiles(1);

    await expect.poll(loaderCount).toBe(1);
    // The render that first shows the Loader comes before the effect that marks the card's url as
    // verifying, so wait for the mark itself. Between the two, the pick's own hold covers it.
    expect(pendingNow()).toBe(true);
    // What `useImagesUploadingOrVerifying` reads to hold the cost estimate and submit.
    await vi.waitFor(() => expect(useImagesUploadingStore.getState().verifying).toHaveLength(1));
    expect(pendingNow()).toBe(true);
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();

    resolveDims({ width: 1024, height: 1024 });
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await settleOneByOne('reject');
    await expect.element(page.getByText(PRESIGN_ERROR)).toBeVisible();
    expect(loaderCount()).toBe(0);
  });
});

/**
 * The generator holds its cost estimate (spinner) and Generate on `useImagesUploadingOrVerifying`.
 * From the moment an image is picked until it is in the form value, that flag must stay true:
 * every false gap in between drops the cost box to its "nothing coming" dash and back, a visible
 * flicker. Once the upload settles (into the value, an error, or a removed card) it must go false
 * and stay false, or the cost box spins forever.
 */

/** Every observation of the pending flag and every value write, in order. */
type Event = { kind: 'pending'; on: boolean } | { kind: 'value'; count: number };
let events: Event[] = [];
let lastValue: ImageValue[] = [];
let valueWrites: ImageValue[][] = [];
/** Adds an image to the harness's value from outside, as another part of the form would. */
let pushValue: (image: ImageValue) => void = () => undefined;

/** Samples the flag on every render, the way WhatIfProvider reads it. */
function PendingProbe() {
  const on = useImagesUploadingOrVerifying();
  const last = [...events].reverse().find((e) => e.kind === 'pending');
  if (!last || last.on !== on) events.push({ kind: 'pending', on });
  return null;
}

function PendingHarness({
  aspectRatios,
  layout,
  initialValue = [],
  max = 1,
}: {
  aspectRatios?: `${number}:${number}`[];
  layout?: 'default' | 'url-input';
  initialValue?: ImageValue[];
  max?: number;
}) {
  const [value, setValue] = useState<ImageValue[]>(initialValue);
  pushValue = (image) => setValue((prev) => [...prev, image]);
  const onChange = (next: ImageValue[]) =>
    setValue((prev) => {
      if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
      events.push({ kind: 'value', count: next.length });
      lastValue = next;
      valueWrites.push(next);
      return next;
    });
  return (
    <div data-testid="source-images">
      <PendingProbe />
      <ImageUploadMultipleInput
        value={value}
        onChange={onChange}
        max={max}
        aspectRatios={aspectRatios}
        layout={layout}
      />
    </div>
  );
}

const pendingNow = () => {
  const { uploading, verifying } = useImagesUploadingStore.getState();
  return uploading.length > 0 || verifying.length > 0;
};

/** Pending observations from the first `true` up to (not including) the first value write. */
function pendingBeforeValue() {
  const firstOn = events.findIndex((e) => e.kind === 'pending' && e.on);
  const firstValue = events.findIndex((e) => e.kind === 'value' && e.count > 0);
  return {
    firstOn,
    firstValue,
    gaps: events.slice(firstOn, firstValue).filter((e) => e.kind === 'pending' && !e.on).length,
  };
}

describe('SourceImageUploadMultiple — the pending flag the generator waits on', () => {
  let unsubscribe = () => undefined as void;
  afterEach(() => unsubscribe());

  beforeEach(() => {
    events = [];
    lastValue = [];
    valueWrites = [];
    mocks.orchestratorUrl = '';
    uploads = [];
    useImagesUploadingStore.setState({ uploading: [], verifying: [] });
    // Record every store change too, so a gap no component re-rendered for is still seen.
    unsubscribe = useImagesUploadingStore.subscribe(() => {
      const on = pendingNow();
      const last = [...events].reverse().find((e) => e.kind === 'pending');
      if (!last || last.on !== on) events.push({ kind: 'pending', on });
    });
    mocks.uploadConsumerBlob
      .mockReset()
      .mockImplementation(
        () => new Promise((resolve, reject) => uploads.push({ resolve, reject, settled: false }))
      );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.dialogTrigger.mockReset();
  });

  test('stays on from the pick until the image is in the value, then goes off', async () => {
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].resolve({ url: await loadableImageUrl(), available: true });

    await vi.waitFor(() =>
      expect(events.some((e) => e.kind === 'value' && e.count === 1)).toBe(true)
    );
    const { firstOn, firstValue, gaps } = pendingBeforeValue();
    expect(firstOn).toBeGreaterThanOrEqual(0);
    expect(firstOn).toBeLessThan(firstValue);
    expect(gaps).toBe(0);

    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    await sleep(300);
    expect(pendingNow()).toBe(false);
  });

  test('a failed upload turns it off, and it stays off', async () => {
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].reject(new Error(PRESIGN_ERROR));

    await vi.waitFor(() => expect(document.body.textContent).toContain(PRESIGN_ERROR));
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    await sleep(500);
    expect(pendingNow()).toBe(false);
    expect(uploads).toHaveLength(1);
  });

  test('removing the card mid-upload turns it off', async () => {
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    expect(pendingNow()).toBe(true);

    const close = await vi.waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>(
        '[data-testid="source-images"] button.mantine-ActionIcon-root:has(.tabler-icon-x)'
      );
      if (!el) throw new Error('remove button not found');
      return el;
    });
    await userEvent.click(close);

    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    // The request it abandoned settles later; that must not turn it back on.
    uploads[0].reject(new Error(PRESIGN_ERROR));
    await sleep(300);
    expect(pendingNow()).toBe(false);
  });
  test('unmounting mid-upload turns it off', async () => {
    const view = await renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    expect(pendingNow()).toBe(true);

    await view.unmount();
    expect(pendingNow()).toBe(false);
  });

  test('through a crop: stays on from the pick until the cropped image is in the value', async () => {
    mocks.getImageDimensions.mockResolvedValue({ width: 600, height: 2000 });
    renderWithProviders(<PendingHarness aspectRatios={['1:1']} />);
    await pickFiles(1);
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));
    const { onConfirm, images } = mocks.dialogTrigger.mock.calls[0][0].props;

    onConfirm([{ src: images[0].url, cropped: new Blob(['cropped'], { type: 'image/jpeg' }) }]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].resolve({ url: await loadableImageUrl(), available: true });

    await vi.waitFor(() =>
      expect(events.some((e) => e.kind === 'value' && e.count === 1)).toBe(true)
    );
    const { firstOn, firstValue, gaps } = pendingBeforeValue();
    expect(firstOn).toBeGreaterThanOrEqual(0);
    expect(firstOn).toBeLessThan(firstValue);
    expect(gaps).toBe(0);
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
  });

  test('cancelling the crop turns it off', async () => {
    mocks.getImageDimensions.mockResolvedValue({ width: 600, height: 2000 });
    renderWithProviders(<PendingHarness aspectRatios={['1:1']} />);
    await pickFiles(1);
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));
    expect(pendingNow()).toBe(true);

    mocks.dialogTrigger.mock.calls[0][0].props.onCancel();
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
  });
  test('confirming a crop with nothing to upload keeps the image and turns it off', async () => {
    // An already-uploaded image confirmed uncropped needs no upload, so nothing starts its card.
    mocks.getImageDimensions.mockResolvedValue({ width: 600, height: 2000 });
    renderWithProviders(<PendingHarness aspectRatios={['1:1']} layout="url-input" />);
    mocks.orchestratorUrl = await loadableImageUrl();
    await userEvent.fill(
      page.getByPlaceholder('Add a file or provide a URL'),
      mocks.orchestratorUrl
    );
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));
    expect(pendingNow()).toBe(true);

    const { onConfirm, images } = mocks.dialogTrigger.mock.calls[0][0].props;
    await onConfirm([{ src: images[0].url }]);
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    // The already-uploaded image is kept as it is, not dropped with its card.
    const kept = [{ url: mocks.orchestratorUrl, width: 600, height: 2000 }];
    expect(valueWrites).toContainEqual(kept);
    await sleep(300);
    expect(lastValue).toEqual(kept);
  });
});

/**
 * A queued card starts only from the crop/upload effect. Any card that effect can never reach sits
 * on a spinner with no upload, and (through the pending flag) keeps Generate disabled.
 */
describe('SourceImageUploadMultiple — a card that cannot start', () => {
  let unsubscribe = () => undefined as void;
  const cachedUrls: string[] = [];
  afterEach(() => {
    unsubscribe();
    for (const url of cachedUrls.splice(0)) sourceMetadataStore.removeMetadata(url);
  });

  beforeEach(() => {
    events = [];
    lastValue = [];
    valueWrites = [];
    uploads = [];
    mocks.orchestratorUrl = '';
    useImagesUploadingStore.setState({ uploading: [], verifying: [] });
    unsubscribe = useImagesUploadingStore.subscribe(() => undefined);
    mocks.uploadConsumerBlob
      .mockReset()
      .mockImplementation(
        () => new Promise((resolve, reject) => uploads.push({ resolve, reject, settled: false }))
      );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
    mocks.dialogTrigger.mockReset();
    vi.mocked(resizeImage).mockClear();
  });

  const LOAD_ERROR = "Couldn't read this image. Try a different file or a screenshot.";
  /**
   * Every read fails, but only the first few settle: a regression that retried the read in a loop
   * would otherwise spin the page (and the run) instead of failing the read-count check below.
   */
  const CAPPED_FAILURES = 5;
  function failReadsCapped() {
    let calls = 0;
    mocks.getImageDimensions.mockImplementation(() =>
      ++calls <= CAPPED_FAILURES
        ? Promise.reject(new Error('Image failed to load'))
        : new Promise(() => undefined)
    );
    return () => calls;
  }
  const loadFailures = () =>
    mocks.reportApplicationError.mock.calls.map(([error, ctx]) => [
      (error as Error).message,
      (ctx as { message?: string } | undefined)?.message,
    ]);

  test('a picked file whose image cannot be read ends on an error card and frees the generator', async () => {
    const reads = failReadsCapped();
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);

    await expect.element(page.getByText(LOAD_ERROR)).toBeVisible();
    await expect.poll(loaderCount).toBe(0);
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(loadFailures()).toEqual([
      ['source image prep failed: dims', 'picked-file image/jpeg <5MB Error'],
    ]);
    expect(reads()).toBe(1);
  });

  async function pasteUrl(url: string) {
    await userEvent.fill(page.getByPlaceholder('Add a file or provide a URL'), url);
    await userEvent.keyboard('{Enter}');
  }

  test('a url pasted again after its read failed goes through the crop check before any upload', async () => {
    const url = 'https://example.com/retried.jpg';
    let reads = 0;
    mocks.getImageDimensions.mockImplementation(async (src: unknown) => {
      if (src === url && ++reads === 1) throw new Error('Image failed to load');
      return { width: 600, height: 2000 };
    });
    renderWithProviders(<PendingHarness layout="url-input" max={2} aspectRatios={['1:1']} />);
    await pasteUrl(url);
    await expect.element(page.getByText(LOAD_ERROR)).toBeVisible();

    await pasteUrl(url);
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));
    await sleep(300);
    expect(vi.mocked(resizeImage)).not.toHaveBeenCalled();
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(valueWrites.some((v) => v.some((img) => img.url === url))).toBe(false);
  });

  test('a url pasted again that still cannot be read ends on the same error, reported once per attempt', async () => {
    const reads = failReadsCapped();
    const url = 'https://example.com/still-broken.jpg';
    renderWithProviders(<PendingHarness layout="url-input" max={2} />);
    await pasteUrl(url);
    await expect.element(page.getByText(LOAD_ERROR)).toBeVisible();

    await pasteUrl(url);
    await expect.poll(() => page.getByText(LOAD_ERROR).elements().length).toBe(2);
    await expect.poll(loaderCount).toBe(0);
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    expect(document.body.textContent).not.toContain('Image failed to load');
    expect(vi.mocked(resizeImage)).not.toHaveBeenCalled();
    expect(loadFailures()).toEqual([
      ['source image prep failed: dims', 'url Error origin:card host:other'],
      ['source image prep failed: dims', 'url Error origin:card host:other'],
    ]);
    expect(reads()).toBe(2);
  });

  test('an abandoned upload settling after its card was removed does not re-run the dimension check', async () => {
    // An image already in the value that can't be read is re-read whenever the card list changes,
    // so its read count shows whether the settle produced a change.
    // Loadable, so its preview stays; only the (mocked) dimension read fails.
    const existing = await loadableImageUrl();
    mocks.getImageDimensions.mockImplementation(async (src: unknown) => {
      if (src === existing) throw new Error('Image failed to load');
      return { width: 1024, height: 1024 };
    });
    renderWithProviders(
      <PendingHarness max={2} initialValue={[{ url: existing, width: 1024, height: 1024 }]} />
    );
    const readsOfExisting = () =>
      mocks.getImageDimensions.mock.calls.filter(([src]) => src === existing).length;
    await vi.waitFor(() => expect(readsOfExisting()).toBeGreaterThan(0));
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const close = await vi.waitFor(() => {
      const els = document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="source-images"] button.mantine-ActionIcon-root:has(.tabler-icon-x)'
      );
      const last = els[els.length - 1];
      if (!last) throw new Error('remove button not found');
      return last;
    });
    await userEvent.click(close);
    // The click removed the uploading card, not the image already in the value.
    await expect.poll(loaderCount).toBe(0);
    expect(
      document.querySelector(`[data-testid="source-images"] img[src="${existing}"]`)
    ).not.toBeNull();
    await sleep(300);

    const before = readsOfExisting();
    uploads[0].reject(new Error(PRESIGN_ERROR));
    await sleep(300);
    expect(readsOfExisting()).toBe(before);
  });

  test('a parent that re-renders on every pending change with a fresh value does not loop the reads', async () => {
    function FreshValueParent() {
      useImagesUploadingOrVerifying();
      const [value, setValue] = useState<ImageValue[]>([]);
      // Ignores an equal write. The form-graph store does the same (its snapshot diff hands back the
      // previous value for a deep-equal write); a parent that doesn't makes the input loop, on main too.
      const onChange = (next: ImageValue[]) =>
        setValue((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      return (
        <div data-testid="source-images">
          <ImageUploadMultipleInput value={[...value]} onChange={onChange} max={1} />
        </div>
      );
    }
    // Reads succeed, but past a cap they never settle, so a loop fails the count below instead of
    // spinning the page.
    let reads = 0;
    mocks.getImageDimensions.mockImplementation(() =>
      ++reads <= 10 ? Promise.resolve({ width: 1024, height: 1024 }) : new Promise(() => undefined)
    );
    renderWithProviders(<FreshValueParent />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await sleep(2000);
    // The pre-check, the upload's own read, and the read after re-encoding.
    expect(reads).toBeLessThanOrEqual(3);
  });

  test('a pasted url whose image cannot be read ends on an error card and frees the generator', async () => {
    const reads = failReadsCapped();
    renderWithProviders(<PendingHarness layout="url-input" />);
    await userEvent.fill(
      page.getByPlaceholder('Add a file or provide a URL'),
      'https://example.com/hotlinked.jpg'
    );
    await userEvent.keyboard('{Enter}');

    await expect.element(page.getByText(LOAD_ERROR)).toBeVisible();
    await expect.poll(loaderCount).toBe(0);
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(loadFailures()).toEqual([
      ['source image prep failed: dims', 'url Error origin:card host:other'],
    ]);
    expect(reads()).toBe(1);
  });

  test('a data url whose dimensions are already cached is uploaded', async () => {
    const dataUrl = `data:image/png;base64,${btoa(String(Date.now()))}`;
    sourceMetadataStore.setMetadata(dataUrl, { width: 1024, height: 1024 });
    cachedUrls.push(dataUrl);
    renderWithProviders(
      <PendingHarness initialValue={[{ url: dataUrl, width: 1024, height: 1024 }]} />
    );

    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].resolve({ url: await loadableImageUrl(), available: true });
    await vi.waitFor(() => expect(lastValue).toHaveLength(1));
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
  });

  test('an image in the value whose cached dimensions were evicted does not stop a new pick', async () => {
    const existing = await loadableImageUrl();
    cachedUrls.push(existing);
    renderWithProviders(
      <PendingHarness max={2} initialValue={[{ url: existing, width: 1024, height: 1024 }]} />
    );
    await vi.waitFor(() => expect(sourceMetadataStore.getMetadata(existing)?.width).toBe(1024));
    // The store keeps a bounded number of entries and evicts the oldest.
    sourceMetadataStore.removeMetadata(existing);
    await pickFiles(1);

    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].resolve({ url: await loadableImageUrl(), available: true });
    await vi.waitFor(() => expect(lastValue).toHaveLength(2));
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
  });

  test('a card queued while the crop modal is open starts once the crop session ends', async () => {
    const dataUrl = `data:image/png;base64,${btoa(`crop-${Date.now()}`)}`;
    cachedUrls.push(dataUrl);
    mocks.getImageDimensions.mockImplementation(async (src: unknown) =>
      src === dataUrl ? { width: 1024, height: 1024 } : { width: 600, height: 2000 }
    );
    renderWithProviders(<PendingHarness max={2} aspectRatios={['1:1']} />);
    await pickFiles(1);
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));

    // Another part of the form writes an image while the modal is open.
    pushValue({ url: dataUrl, width: 1024, height: 1024 });
    await vi.waitFor(() => expect(sourceMetadataStore.getMetadata(dataUrl)?.width).toBe(1024));

    // The crop's own upload fails, so the session ends without changing the value.
    const { onConfirm, images } = mocks.dialogTrigger.mock.calls[0][0].props;
    void onConfirm([{ src: images[0].url, cropped: new Blob(['c'], { type: 'image/jpeg' }) }]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].reject(new Error(PRESIGN_ERROR));

    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    // The second upload is the queued data url, not another start of the crop.
    expect(vi.mocked(resizeImage)).toHaveBeenLastCalledWith(dataUrl, expect.anything());
  });

  test('cancelling a re-crop of an image already in the value does not reopen the modal', async () => {
    const existing = await loadableImageUrl();
    cachedUrls.push(existing);
    mocks.getImageDimensions.mockResolvedValue({ width: 600, height: 2000 });
    renderWithProviders(
      <PendingHarness
        aspectRatios={['1:1']}
        initialValue={[{ url: existing, width: 600, height: 2000 }]}
      />
    );
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));

    mocks.dialogTrigger.mock.calls[0][0].props.onCancel();
    await sleep(500);
    expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1);
  });

  test('an image already in the value whose dimensions cannot be read does not stop a new pick', async () => {
    const existing = await loadableImageUrl();
    mocks.getImageDimensions.mockImplementation(async (src: unknown) => {
      if (src === existing) throw new Error('Image failed to load');
      return { width: 1024, height: 1024 };
    });
    renderWithProviders(
      <PendingHarness max={2} initialValue={[{ url: existing, width: 1024, height: 1024 }]} />
    );
    await vi.waitFor(() => expect(mocks.getImageDimensions).toHaveBeenCalled());
    await pickFiles(1);

    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].resolve({ url: await loadableImageUrl(), available: true });
    await vi.waitFor(() => expect(lastValue).toHaveLength(2));
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    // Retried on a change, but not in a loop of its own: the count holds once nothing changes.
    const readsOfExisting = () =>
      mocks.getImageDimensions.mock.calls.filter(([src]) => src === existing).length;
    const settledReads = readsOfExisting();
    await sleep(500);
    expect(readsOfExisting()).toBe(settledReads);
    // The unreadable url is retried on every change; it is reported once.
    expect(
      mocks.getImageDimensions.mock.calls.filter(([src]) => src === existing).length
    ).toBeGreaterThan(1);
    expect(mocks.reportApplicationError).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every local step before the upload (dimension read, reading the picked file back, decode, encode,
 * metadata copy, the re-read after encoding) must end on an error card, release the generator, and
 * send exactly one bounded report naming the stage. A step that never settles is bounded.
 */
describe('SourceImageUploadMultiple — a source image that cannot be prepared', () => {
  beforeEach(() => {
    uploads = [];
    useImagesUploadingStore.setState({ uploading: [], verifying: [] });
    mocks.uploadConsumerBlob
      .mockReset()
      .mockImplementation(
        () => new Promise((resolve, reject) => uploads.push({ resolve, reject, settled: false }))
      );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
    mocks.dialogTrigger.mockReset();
    vi.mocked(resizeImage)
      .mockReset()
      .mockImplementation(async () => new Blob(['resized'], { type: 'image/png' }));
    vi.mocked(imageToJpegBlob)
      .mockReset()
      .mockImplementation(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const reports = () =>
    mocks.reportApplicationError.mock.calls.map(([error, ctx]) => [
      (error as Error).message,
      (ctx as { message?: string } | undefined)?.message,
    ]);
  const PROCESS_ERROR =
    "Couldn't process this image on your device. Try a smaller photo or a screenshot.";
  const PREP_ERROR =
    "Couldn't read this image on your device. Try a different file or a screenshot.";

  /** The card shows exactly `text`, and not the underlying error's own text. */
  async function expectFailedCard(text: string, raw = 'Image failed to load') {
    await expect.element(page.getByText(text, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain(raw);
    await expect.poll(loaderCount).toBe(0);
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
  }

  // The pre-check passes `options`; the upload's own dimension reads do not.
  const uploadReadsOnly = (impl: (call: number) => Promise<unknown>) => {
    let call = 0;
    mocks.getImageDimensions.mockImplementation((_src: unknown, options?: unknown) =>
      options ? Promise.resolve({ width: 1024, height: 1024 }) : impl(call++)
    );
  };

  // Failures that are not a read of the picked file; those offer the Files fallback (below).
  test('dims: the upload cannot decode the image', async () => {
    uploadReadsOnly(() =>
      Promise.reject(new DOMException('Image failed to load', 'EncodingError'))
    );
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await expectFailedCard(PREP_ERROR);
    expect(reports()).toEqual([
      ['source image prep failed: dims', 'picked-file image/jpeg <5MB EncodingError'],
    ]);
  });

  test.each(['read-blob', 'decode', 'encode', 'metadata'] as const)(
    '%s: the resize step fails',
    async (stage) => {
      vi.mocked(resizeImage).mockRejectedValueOnce(
        new ImagePrepError(stage, false, `${stage} broke`, {
          cause: new DOMException('x', 'EncodingError'),
        })
      );
      renderWithProviders(<PendingHarness />);
      await pickFiles(1);
      await expectFailedCard(PREP_ERROR, `${stage} broke`);
      expect(reports()).toEqual([
        [`source image prep failed: ${stage}`, 'picked-file image/jpeg <5MB EncodingError'],
      ]);
    }
  );

  test('encode: a NotReadableError there is not a read of the picked file', async () => {
    vi.mocked(resizeImage).mockRejectedValueOnce(
      new ImagePrepError('encode', false, 'encode broke', {
        cause: new DOMException('x', 'NotReadableError'),
      })
    );
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await expectFailedCard(PREP_ERROR, 'encode broke');
    expect(document.body.textContent).not.toContain('Choose it from Files instead.');
    expect(reports()).toEqual([
      ['source image prep failed: encode', 'picked-file image/jpeg <5MB NotReadableError'],
    ]);
  });

  test('dims-after-encode: the re-encoded image cannot be read', async () => {
    uploadReadsOnly((call) =>
      call === 0
        ? Promise.resolve({ width: 1024, height: 1024 })
        : Promise.reject(new Error('Image failed to load'))
    );
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await expectFailedCard(PREP_ERROR);
    expect(reports()).toEqual([
      ['source image prep failed: dims-after-encode', 'picked-file image/jpeg <5MB Error'],
    ]);
  });

  test('a step in the upload that never settles times out onto an error card', async () => {
    uploadReadsOnly(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await vi.waitFor(() => expect(mocks.getImageDimensions).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(31_000);
    await expectFailedCard(PROCESS_ERROR);
    expect(reports()).toEqual([
      ['source image prep failed: dims:timeout', 'picked-file image/jpeg <5MB'],
    ]);
  });

  test('a dimension pre-check that never settles times out onto an error card', async () => {
    mocks.getImageDimensions.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await vi.waitFor(() => expect(mocks.getImageDimensions).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(31_000);
    await expectFailedCard(PROCESS_ERROR);
    expect(reports()).toEqual([
      ['source image prep failed: dims:timeout', 'picked-file image/jpeg <5MB'],
    ]);
  });

  test('the upload bounds its resize and encode steps', async () => {
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    expect(vi.mocked(resizeImage)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stageTimeoutMs: 30_000 })
    );
    expect(vi.mocked(imageToJpegBlob)).toHaveBeenCalledWith(expect.anything(), {
      stageTimeoutMs: 30_000,
    });
  });

  test('a report names only listed types and error names', async () => {
    // The crop path uploads a Blob, so the source is `blob` and the type comes from the Blob.
    mocks.getImageDimensions.mockResolvedValue({ width: 600, height: 2000 });
    vi.mocked(resizeImage).mockRejectedValueOnce(
      new ImagePrepError('decode', false, 'decode broke', {
        cause: Object.assign(new Error('x'), { name: 'WeirdError' }),
      })
    );
    renderWithProviders(<PendingHarness aspectRatios={['1:1']} />);
    await pickFiles(1);
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));
    const { onConfirm, images } = mocks.dialogTrigger.mock.calls[0][0].props;
    void onConfirm([{ src: images[0].url, cropped: new Blob(['c'], { type: 'image/x-made-up' }) }]);

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(reports()).toEqual([['source image prep failed: decode', 'blob other <5MB other']]);
  });

  test("an upload failure keeps the upload's own message", async () => {
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].reject(new Error(PRESIGN_ERROR));
    await expect.element(page.getByText(PRESIGN_ERROR, { exact: true })).toBeVisible();
    await expect.poll(loaderCount).toBe(0);
    expect(document.body.textContent).not.toContain(PREP_ERROR);
    expect(reports()).toEqual([]);
  });

  test('a size requirement keeps its own message and is not reported', async () => {
    const tooSmall = 'Does not meet minimum width requirement: 512px';
    vi.mocked(resizeImage).mockRejectedValueOnce(new Error(tooSmall));
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await expectFailedCard(tooSmall, PREP_ERROR);
    expect(reports()).toEqual([]);
  });

  test('a slot whose image cannot be read shows the same text, not the browser error', async () => {
    mocks.getImageDimensions.mockRejectedValue(new Error('Image failed to load'));
    renderWithProviders(
      <div data-testid="source-images">
        <ImageUploadMultipleInput
          value={[]}
          onChange={() => undefined}
          slots={[{ label: 'First frame' }, { label: 'Last frame' }]}
        />
      </div>
    );
    await pickFiles(1);
    await expect.element(page.getByText(PREP_ERROR, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain('Image failed to load');
    // The slot releases the generator too, and (by decision) sends no report.
    await expect.poll(loaderCount).toBe(0);
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(reports()).toEqual([]);
  });
});

/**
 * A signed-out user cannot upload: the presign request every upload starts with is refused. An
 * image the user adds opens sign-in instead of starting an upload; one that arrives without a
 * gesture (a data: url in the value) shows a sign-in message rather than opening a window unasked.
 * Either way no upload is started and nothing is left holding the generator.
 */
describe('SourceImageUploadMultiple — signed out', () => {
  const SIGN_IN_MESSAGE = 'Sign in to upload images.';
  const here = () => window.location.pathname + window.location.search + window.location.hash;
  const cachedUrls: string[] = [];

  beforeEach(() => {
    mocks.currentUser = null;
    uploads = [];
    events = [];
    lastValue = [];
    valueWrites = [];
    mocks.orchestratorUrl = '';
    useImagesUploadingStore.setState({ uploading: [], verifying: [] });
    mocks.uploadConsumerBlob
      .mockReset()
      .mockImplementation(
        () => new Promise((resolve, reject) => uploads.push({ resolve, reject, settled: false }))
      );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.dialogTrigger.mockReset();
    vi.mocked(resizeImage).mockClear();
  });
  afterEach(() => {
    for (const url of cachedUrls.splice(0)) sourceMetadataStore.removeMetadata(url);
  });

  /** Nothing started: no upload, no spinner, nothing holding the generator. */
  async function expectNothingStarted() {
    await sleep(300);
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(vi.mocked(resizeImage)).not.toHaveBeenCalled();
    expect(loaderCount()).toBe(0);
    expect(pendingNow()).toBe(false);
  }

  test('picking a file opens sign-in instead of uploading', async () => {
    renderWithProviders(<PendingHarness max={3} />);
    await pickFiles(1);

    await vi.waitFor(() => expect(mocks.openLoginPopup).toHaveBeenCalledTimes(1));
    expect(mocks.openLoginPopup).toHaveBeenCalledWith(here(), 'image-upload');
    await expectNothingStarted();
    expect(page.getByText(SIGN_IN_MESSAGE).elements()).toHaveLength(0);
  });

  test('pasting a url opens sign-in instead of uploading', async () => {
    renderWithProviders(<PendingHarness layout="url-input" />);
    await userEvent.fill(
      page.getByPlaceholder('Add a file or provide a URL'),
      'https://example.com/a.jpg'
    );
    await userEvent.keyboard('{Enter}');

    await vi.waitFor(() => expect(mocks.openLoginPopup).toHaveBeenCalledTimes(1));
    expect(mocks.openLoginPopup).toHaveBeenCalledWith(here(), 'image-upload');
    await expectNothingStarted();
  });

  test('picking a file into a slot opens sign-in instead of uploading', async () => {
    renderWithProviders(
      <div data-testid="source-images">
        <ImageUploadMultipleInput
          value={[]}
          onChange={() => undefined}
          slots={[{ label: 'First frame' }, { label: 'Last frame' }]}
        />
      </div>
    );
    await pickFiles(1);

    await vi.waitFor(() => expect(mocks.openLoginPopup).toHaveBeenCalledTimes(1));
    expect(mocks.openLoginPopup).toHaveBeenCalledWith(here(), 'image-upload');
    await expectNothingStarted();
  });

  test('confirming a re-crop of an image already in the value opens sign-in instead of uploading', async () => {
    const existing = await loadableImageUrl();
    cachedUrls.push(existing);
    mocks.getImageDimensions.mockResolvedValue({ width: 600, height: 2000 });
    renderWithProviders(
      <PendingHarness
        aspectRatios={['1:1']}
        initialValue={[{ url: existing, width: 600, height: 2000 }]}
      />
    );
    // The crop opens on its own; opening it is not an upload, so sign-in is not asked for yet.
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));
    expect(mocks.openLoginPopup).not.toHaveBeenCalled();

    const { onConfirm, images } = mocks.dialogTrigger.mock.calls[0][0].props;
    // Not awaited: where the upload starts, it never settles here.
    void onConfirm([{ src: images[0].url, cropped: new Blob(['c'], { type: 'image/jpeg' }) }]);

    await vi.waitFor(() => expect(mocks.openLoginPopup).toHaveBeenCalledTimes(1));
    expect(mocks.openLoginPopup).toHaveBeenCalledWith(here(), 'image-upload');
    await expectNothingStarted();
    // The session ended: the modal does not reopen and the image stays.
    expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector(`[data-testid="source-images"] img[src="${existing}"]`)
    ).not.toBeNull();

    // The crop session ended: another image that needs cropping still opens the modal.
    const second = await loadableImageUrl();
    cachedUrls.push(second);
    pushValue({ url: second, width: 600, height: 2000 });
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(2));
  });

  test('confirming a drawing opens sign-in instead of uploading it', async () => {
    const existing = await loadableImageUrl();
    cachedUrls.push(existing);
    renderWithProviders(
      <div data-testid="source-images">
        <ImageUploadMultipleInput
          value={[{ url: existing, width: 1024, height: 1024 }]}
          onChange={() => undefined}
          max={1}
          enableDrawing
        />
      </div>
    );
    await userEvent.click(page.getByText('Sketch Edit'));
    const drawing = await vi.waitFor(() => {
      const call = mocks.dialogTrigger.mock.calls.find(([arg]) =>
        String(arg.id).startsWith('drawing-editor-modal')
      );
      if (!call) throw new Error('drawing editor not opened');
      return call[0].props;
    });
    void drawing.onConfirm(new Blob(['drawing'], { type: 'image/png' }), []);

    await vi.waitFor(() => expect(mocks.openLoginPopup).toHaveBeenCalledTimes(1));
    expect(mocks.openLoginPopup).toHaveBeenCalledWith(here(), 'image-upload');
    await expectNothingStarted();
  });

  test('a data url arriving in the value shows a sign-in message, without opening sign-in or uploading', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const dataUrl = canvas.toDataURL('image/png');
    sourceMetadataStore.setMetadata(dataUrl, { width: 1024, height: 1024 });
    cachedUrls.push(dataUrl);
    renderWithProviders(
      <PendingHarness initialValue={[{ url: dataUrl, width: 1024, height: 1024 }]} />
    );

    await expect.element(page.getByText(SIGN_IN_MESSAGE, { exact: true })).toBeVisible();
    await expectNothingStarted();
    expect(mocks.openLoginPopup).not.toHaveBeenCalled();

    // The message's own button is the gesture that opens sign-in.
    await userEvent.click(page.getByRole('button', { name: 'Sign in' }));
    expect(mocks.openLoginPopup).toHaveBeenCalledTimes(1);
    expect(mocks.openLoginPopup).toHaveBeenCalledWith(here(), 'image-upload');
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
  });

  test('the sign-in message goes once the session resolves signed in', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const dataUrl = canvas.toDataURL('image/png');
    sourceMetadataStore.setMetadata(dataUrl, { width: 1024, height: 1024 });
    cachedUrls.push(dataUrl);
    renderWithProviders(
      <PendingHarness max={2} initialValue={[{ url: dataUrl, width: 1024, height: 1024 }]} />
    );
    await expect.element(page.getByText(SIGN_IN_MESSAGE, { exact: true })).toBeVisible();

    // Signed in elsewhere (a session refetch); the next render reads the new user.
    mocks.currentUser = { id: 1 };
    const other = await loadableImageUrl();
    cachedUrls.push(other);
    pushValue({ url: other, width: 1024, height: 1024 });
    await expect.poll(() => page.getByText(SIGN_IN_MESSAGE).elements().length).toBe(0);
  });

  // While the session is still loading a signed-in user cannot be told apart from a signed-out
  // one, so nothing is refused: the upload goes ahead as before, and a real signed-out one gets
  // the sign-in message from the refused presign request.
  test('while the session loads, a data url in the value is uploaded, not dropped', async () => {
    mocks.sessionLoading = true;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const dataUrl = canvas.toDataURL('image/png');
    sourceMetadataStore.setMetadata(dataUrl, { width: 1024, height: 1024 });
    cachedUrls.push(dataUrl);
    renderWithProviders(
      <PendingHarness initialValue={[{ url: dataUrl, width: 1024, height: 1024 }]} />
    );

    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    expect(page.getByText(SIGN_IN_MESSAGE).elements()).toHaveLength(0);
    expect(mocks.openLoginPopup).not.toHaveBeenCalled();
  });

  test('while the session loads, a pick uploads rather than opening sign-in', async () => {
    mocks.sessionLoading = true;
    renderWithProviders(<PendingHarness max={3} />);
    await pickFiles(1);

    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    expect(mocks.openLoginPopup).not.toHaveBeenCalled();
  });

  // The seam the loading window relies on: the real upload, refused at presign, ends on a card
  // telling the user to sign in.
  test('while the session loads, a signed-out pick refused at presign shows the sign-in message', async () => {
    mocks.sessionLoading = true;
    const actual = await vi.importActual<typeof ConsumerBlobUpload>('~/utils/consumer-blob-upload');
    mocks.uploadConsumerBlob.mockImplementation(actual.uploadConsumerBlob);
    const presign = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', presign);
    try {
      renderWithProviders(<PendingHarness max={3} />);
      await pickFiles(1);

      await expect.element(page.getByText(SIGN_IN_MESSAGE, { exact: true })).toBeVisible();
      expect(presign).toHaveBeenCalledTimes(1);
      expect(presign.mock.calls[0][0]).toBe('/api/orchestrator/getConsumerBlobUploadUrl');
      await expect.poll(loaderCount).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Control for the cases above: the same pick, signed in, uploads and asks for nothing.
  test('signed in, the same pick uploads and does not open sign-in', async () => {
    mocks.currentUser = { id: 1 };
    renderWithProviders(<PendingHarness max={3} />);
    await pickFiles(1);

    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].resolve({ url: await loadableImageUrl(), available: true });
    await vi.waitFor(() => expect(lastValue).toHaveLength(1));
    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(1);
    expect(mocks.openLoginPopup).not.toHaveBeenCalled();
    expect(page.getByText(SIGN_IN_MESSAGE).elements()).toHaveLength(0);
  });
});

/**
 * Some Android photo pickers hand the page a File no API can read (every read rejects with
 * NotReadableError), while the same photo chosen from the Files app reads fine. Such a pick must not
 * start anything; on Android the user is offered a Files chooser instead (a file input with no
 * image-only `accept`), elsewhere only a message, and each such pick is reported once.
 */
describe('SourceImageUploadMultiple — a pick the photo picker made unreadable', () => {
  const PICK_MESSAGE =
    "Your phone's photo picker gave us a file we can't open. Choose it from Files instead.";
  let restoreReads = () => undefined as void;

  beforeEach(() => {
    uploads = [];
    events = [];
    lastValue = [];
    valueWrites = [];
    mocks.orchestratorUrl = '';
    useImagesUploadingStore.setState({ uploading: [], verifying: [] });
    mocks.uploadConsumerBlob
      .mockReset()
      .mockImplementation(
        () => new Promise((resolve, reject) => uploads.push({ resolve, reject, settled: false }))
      );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
    mocks.dialogTrigger.mockReset();
    vi.mocked(resizeImage).mockClear();
    restoreReads = makeUnreadableFilesFail();
  });
  afterEach(() => restoreReads());

  const reports = () =>
    mocks.reportApplicationError.mock.calls.map(([error, ctx]) => [
      (error as Error).message,
      (ctx as { name?: string } | undefined)?.name,
      (ctx as { message?: string } | undefined)?.message,
    ]);
  const PICK_REPORT = [
    'source image prep failed: pick-unreadable',
    'source-image-prep',
    'picked-file image/jpeg <5MB NotReadableError android:true',
  ];

  async function expectFilesFallbackOffered() {
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Choose from Files' })).toBeVisible();
    const input = filesFallbackInput();
    expect(input.type).toBe('file');
    expect(input.hasAttribute('accept')).toBe(false);
  }

  async function expectNothingStarted() {
    await sleep(300);
    expect(mocks.getImageDimensions).not.toHaveBeenCalled();
    expect(vi.mocked(resizeImage)).not.toHaveBeenCalled();
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(loaderCount()).toBe(0);
    expect(pendingNow()).toBe(false);
  }

  test('is not uploaded, offers the Files chooser, and is reported once', async () => {
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);

    await expectFilesFallbackOffered();
    await expectNothingStarted();
    expect(reports()).toEqual([PICK_REPORT]);
    expect(filesFallbackInput().multiple).toBe(true);
  });

  test.each([
    ['one image', { max: 1 }],
    ['the url-input layout', { max: 3, layout: 'url-input' as const }],
  ])('in %s: nothing starts and the Files chooser is offered', async (_, props) => {
    renderWithProviders(<PendingHarness {...props} />);
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);

    await expectFilesFallbackOffered();
    await expectNothingStarted();
    expect(reports()).toEqual([PICK_REPORT]);
  });

  test('alongside a readable pick: only the readable one is uploaded', async () => {
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [imageFile('photo-0.jpg'), imageFile('unreadable-1.jpg')]);

    await expectFilesFallbackOffered();
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await sleep(300);
    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(1);
    expect(reports()).toEqual([PICK_REPORT]);
  });

  test('a file chosen from Files is uploaded and the message goes', async () => {
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    await chooseFiles(filesFallbackInput(), [imageFile('photo-0.jpg')]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    uploads[0].resolve({ url: await loadableImageUrl(), available: true });
    await vi.waitFor(() => expect(lastValue).toHaveLength(1));
    expect(page.getByText(PICK_MESSAGE).elements()).toHaveLength(0);
  });

  test('a file of another type chosen from Files is refused', async () => {
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    await chooseFiles(filesFallbackInput(), [new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    await expect
      .element(page.getByText("That file type isn't supported here.", { exact: true }))
      .toBeVisible();
    await expectNothingStarted();
    // The fallback stays, so the user can choose again.
    await expectFilesFallbackOffered();
  });

  test('a selection from Files mixing an image with another type is refused whole', async () => {
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    await chooseFiles(filesFallbackInput(), [
      imageFile('photo-0.jpg'),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    ]);
    // Not even the image is uploaded (checked first: an upload would clear the alert and its error).
    await expectNothingStarted();
    await expect
      .element(page.getByText("That file type isn't supported here.", { exact: true }))
      .toBeVisible();
    await expectFilesFallbackOffered();
  });

  test('a selection from Files with a file over the size limit is refused, and the fallback stays', async () => {
    renderWithProviders(<PendingHarness max={2} />);
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    const tooLarge = new File([new Uint8Array(maxOrchestratorImageFileSize + 1)], 'big.jpg', {
      type: 'image/jpeg',
    });
    await chooseFiles(filesFallbackInput(), [tooLarge, imageFile('photo-0.jpg')]);
    // The fallback stays (checked first: a cleared alert takes its error text with it).
    await sleep(300);
    await expectFilesFallbackOffered();
    await expect.element(page.getByText(/^Files should not exceed /)).toBeVisible();
    await expectNothingStarted();

    // Choosing again from the same fallback works.
    await chooseFiles(filesFallbackInput(), [imageFile('photo-0.jpg')]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
  });

  test('files chosen from Files keep the image count', async () => {
    renderWithProviders(<PendingHarness max={2} />);
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    await chooseFiles(filesFallbackInput(), [
      imageFile('photo-0.jpg'),
      imageFile('photo-1.jpg'),
      imageFile('photo-2.jpg'),
    ]);
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    await sleep(300);
    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(2);
  });

  test('off Android: a neutral message, no Files chooser, and still reported', async () => {
    mocks.android = false;
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);

    await expect
      .element(
        page.getByText("We couldn't open this file. Try choosing it again.", { exact: true })
      )
      .toBeVisible();
    expect(page.getByRole('button', { name: 'Choose from Files' }).elements()).toHaveLength(0);
    expect(document.querySelector('[data-testid="unreadable-pick-files-input"]')).toBeNull();
    expect(page.getByText(PICK_MESSAGE).elements()).toHaveLength(0);
    await expectNothingStarted();
    expect(reports()).toEqual([
      [
        PICK_REPORT[0],
        PICK_REPORT[1],
        'picked-file image/jpeg <5MB NotReadableError android:false',
      ],
    ]);
  });

  test('into a slot: nothing starts, and a file chosen from Files fills that slot', async () => {
    renderWithProviders(<SlotHarness />);
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);

    await expectFilesFallbackOffered();
    await expectNothingStarted();
    expect(reports()).toEqual([PICK_REPORT]);
    expect(filesFallbackInput().multiple).toBe(false);

    await chooseFiles(filesFallbackInput(), [imageFile('photo-0.jpg')]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const uploaded = await loadableImageUrl();
    uploads[0].resolve({ url: uploaded, available: true });
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([uploaded]));
    // The slot's upload measured it too, so it is not downloaded again.
    await sleep(500);
    expect(mocks.getImageDimensions.mock.calls.filter(([src]) => src === uploaded)).toEqual([]);
  });

  test('several unreadable files dropped on the slots: the Files fallback fills each of their slots', async () => {
    renderWithProviders(<SlotHarness />);
    await chooseFiles(dropzoneInput(), [
      imageFile('unreadable-0.jpg'),
      imageFile('unreadable-1.jpg'),
    ]);

    await expect
      .element(
        page.getByText(
          "Your phone's photo picker gave us 2 files we can't open. Choose them from Files instead.",
          { exact: true }
        )
      )
      .toBeVisible();
    await expectNothingStarted();
    expect(reports()).toEqual([PICK_REPORT, PICK_REPORT]);
    expect(filesFallbackInput().multiple).toBe(true);

    await chooseFiles(filesFallbackInput(), [imageFile('photo-0.jpg'), imageFile('photo-1.jpg')]);
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    const urls = [await loadableImageUrl(), await loadableImageUrl()];
    uploads.forEach((u, i) => u.resolve({ url: urls[i], available: true }));
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual(urls));
  });
});

/**
 * The readability probe must not hold a pick forever: a read that has not settled within
 * UNREADABLE_PROBE_TIMEOUT_MS (a cloud-only photo still downloading) goes on to the normal pipeline.
 * And while the probe runs, the generator is already held (the pick counts as pending).
 */
describe('SourceImageUploadMultiple — a pick whose read stalls', () => {
  let restoreReads = () => undefined as void;
  let unsubscribe = () => undefined as void;

  beforeEach(() => {
    uploads = [];
    lastValue = [];
    useImagesUploadingStore.setState({ uploading: [], verifying: [] });
    unsubscribe = useImagesUploadingStore.subscribe(() => undefined);
    mocks.uploadConsumerBlob
      .mockReset()
      .mockImplementation(
        () => new Promise((resolve, reject) => uploads.push({ resolve, reject, settled: false }))
      );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
    mocks.dialogTrigger.mockReset();
    restoreReads = makeSlowFilesStall();
  });
  afterEach(() => {
    restoreReads();
    unsubscribe();
  });

  const PROBE_WAIT = { timeout: UNREADABLE_PROBE_TIMEOUT_MS + 3_000 };
  const reports = () => mocks.reportApplicationError.mock.calls;

  test.each([
    ['a card', () => <PendingHarness max={3} />],
    ['a slot', () => <SlotHarness />],
  ])('into %s: held pending while the probe runs', async (_, render) => {
    renderWithProviders(render());
    await chooseFiles(dropzoneInput(), [imageFile('slow-0.jpg')]);

    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(pendingNow()).toBe(true);
  });

  test.each([
    ['a card', () => <PendingHarness max={3} />],
    ['a slot', () => <SlotHarness />],
  ])(
    'into %s: goes on to upload once the probe gives up',
    async (_, render) => {
      renderWithProviders(render());
      await chooseFiles(dropzoneInput(), [imageFile('slow-0.jpg')]);

      await vi.waitFor(() => expect(uploads).toHaveLength(1), PROBE_WAIT);
      const uploaded = await loadableImageUrl();
      uploads[0].resolve({ url: uploaded, available: true });
      await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([uploaded]));
      expect(reports()).toEqual([]);
    },
    UNREADABLE_PROBE_TIMEOUT_MS + 10_000
  );
});

/**
 * Some photo-picker Files read fine at the pick and turn unreadable seconds later. The pick is read
 * in full at pick time and every later stage reads that in-memory copy, so the upload completes; and
 * when a later stage does fail to read a picked file, the user is offered the Files fallback rather
 * than a dead-end error.
 */
describe('SourceImageUploadMultiple — a picked file that turns unreadable after the pick', () => {
  const PICK_MESSAGE =
    "Your phone's photo picker gave us a file we can't open. Choose it from Files instead.";
  const LOAD_ERROR = "Couldn't read this image. Try a different file or a screenshot.";
  const PREP_ERROR =
    "Couldn't read this image on your device. Try a different file or a screenshot.";
  let expiry: ReturnType<typeof makeFilesExpireAfterFirstRead> | undefined;
  let restoreFullReads = () => undefined as void;

  beforeEach(() => {
    restoreFullReads = makeFullReadsFail();
    uploads = [];
    events = [];
    lastValue = [];
    valueWrites = [];
    mocks.orchestratorUrl = '';
    useImagesUploadingStore.setState({ uploading: [], verifying: [] });
    mocks.uploadConsumerBlob
      .mockReset()
      .mockImplementation(
        () => new Promise((resolve, reject) => uploads.push({ resolve, reject, settled: false }))
      );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
    mocks.dialogTrigger.mockReset();
    vi.mocked(resizeImage)
      .mockReset()
      .mockImplementation(async () => new Blob(['resized'], { type: 'image/png' }));
    vi.mocked(imageToJpegBlob)
      .mockReset()
      .mockImplementation(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
  });
  afterEach(() => {
    restoreFullReads();
    expiry?.restore();
    expiry = undefined;
    vi.mocked(resizeImage)
      .mockReset()
      .mockImplementation(async () => new Blob(['resized'], { type: 'image/png' }));
    vi.mocked(imageToJpegBlob)
      .mockReset()
      .mockImplementation(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
  });

  const reports = () =>
    mocks.reportApplicationError.mock.calls.map(([error, ctx]) => [
      (error as Error).message,
      (ctx as { message?: string } | undefined)?.message,
    ]);
  /** What `<img>` loading rejects with for a blob: url whose file can no longer be read. */
  const imageLoadError = () =>
    new Error('Image failed to load (complete=true, naturalWidth=0)', {
      cause: new Event('error'),
    });

  /** A decodable PNG, big enough for the upload's minimum size. */
  async function photoFile(name: string) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 400;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#3a7';
    ctx.fillRect(0, 0, 400, 400);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    return new File([await blob.arrayBuffer()], name, { type: 'image/png' });
  }

  /** The real dimension, resize and re-encode steps, so they read the picked file themselves. */
  async function useRealPrepSteps() {
    const imageUtils = await vi.importActual<typeof ImageUtils>('~/utils/image-utils');
    const canvasUtils = await vi.importActual<typeof CanvasUtils>('~/shared/utils/canvas-utils');
    mocks.getImageDimensions.mockImplementation(imageUtils.getImageDimensions);
    vi.mocked(resizeImage).mockImplementation(canvasUtils.resizeImage);
    vi.mocked(imageToJpegBlob).mockImplementation(canvasUtils.imageToJpegBlob);
  }

  test.each([
    ['a card', () => <PendingHarness max={3} />],
    ['a slot', () => <SlotHarness />],
  ])(
    'into %s: read once at the pick, it still uploads from the copy taken then',
    async (_, render) => {
      await useRealPrepSteps();
      const photo = await photoFile('photo-0.png');
      expiry = makeFilesExpireAfterFirstRead();
      renderWithProviders(render());
      await chooseFiles(dropzoneInput(), [expiry.expiringFile(photo)]);

      await vi.waitFor(() => expect(uploads).toHaveLength(1), { timeout: 10_000 });
      const sent = mocks.uploadConsumerBlob.mock.calls[0][0] as Blob;
      expect(sent.type).toBe('image/jpeg');
      expect(sent.size).toBeGreaterThan(0);
      const uploaded = await loadableImageUrl();
      uploads[0].resolve({ url: uploaded, available: true });
      await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([uploaded]));
      expect(reports()).toEqual([]);
      expect(page.getByText(PICK_MESSAGE).elements()).toHaveLength(0);
    },
    20_000
  );

  async function expectFilesFallbackOffered() {
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Choose from Files' })).toBeVisible();
    expect(document.body.textContent).not.toContain(LOAD_ERROR);
    expect(document.body.textContent).not.toContain(PREP_ERROR);
    await expect.poll(loaderCount).toBe(0);
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
  }

  // Picks still backed by the device: their pick-time copy was not taken (here its read failed some
  // other way; a read that times out goes the same way), so a later read can be refused.
  const devicePick = (name: string) => imageFile(`uncopied-${name}`);

  test('its dimensions cannot be read: the Files fallback is offered, and a file from it uploads', async () => {
    mocks.getImageDimensions.mockRejectedValueOnce(imageLoadError());
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [devicePick('0.jpg')]);

    await expectFilesFallbackOffered();
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(reports()).toEqual([
      ['source image prep failed: dims', 'picked-file image/jpeg <5MB Error'],
    ]);

    await chooseFiles(filesFallbackInput(), [imageFile('photo-1.jpg')]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const uploaded = await loadableImageUrl();
    uploads[0].resolve({ url: uploaded, available: true });
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([uploaded]));
    expect(page.getByText(PICK_MESSAGE).elements()).toHaveLength(0);
  });

  test('two picks whose dimensions cannot be read are counted together', async () => {
    mocks.getImageDimensions.mockRejectedValue(imageLoadError());
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [devicePick('0.jpg'), devicePick('1.jpg')]);

    await expect
      .element(
        page.getByText(
          "Your phone's photo picker gave us 2 files we can't open. Choose them from Files instead.",
          { exact: true }
        )
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain(LOAD_ERROR);
  });

  test.each([
    ['read-blob', new TypeError('Failed to fetch'), 'TypeError'],
    ['decode', imageLoadError(), 'Error'],
    ['metadata', new DOMException('x', 'NotReadableError'), 'NotReadableError'],
  ] as const)(
    '%s: the upload cannot read it, so the Files fallback is offered',
    async (stage, cause, name) => {
      vi.mocked(resizeImage).mockRejectedValueOnce(
        new ImagePrepError(stage, false, 'read broke', { cause })
      );
      renderWithProviders(<PendingHarness max={3} />);
      await chooseFiles(dropzoneInput(), [devicePick('0.jpg')]);

      await expectFilesFallbackOffered();
      expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
      expect(reports()).toEqual([
        [`source image prep failed: ${stage}`, `picked-file image/jpeg <5MB ${name}`],
      ]);
    }
  );

  test('a read that fails with any other TypeError (a bug, not the file) keeps its error card', async () => {
    vi.mocked(resizeImage).mockRejectedValueOnce(
      new ImagePrepError('read-blob', false, 'read broke', {
        cause: new TypeError("Cannot read properties of undefined (reading 'width')"),
      })
    );
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [devicePick('0.jpg')]);

    await expect.element(page.getByText(PREP_ERROR, { exact: true })).toBeVisible();
    expect(page.getByText(PICK_MESSAGE).elements()).toHaveLength(0);
  });

  test('the upload of a cropped pick cannot read it: the Files fallback is offered', async () => {
    mocks.getImageDimensions.mockResolvedValue({ width: 600, height: 2000 });
    vi.mocked(resizeImage).mockRejectedValueOnce(
      new ImagePrepError('read-blob', false, 'read broke', {
        cause: new TypeError('Failed to fetch'),
      })
    );
    renderWithProviders(<PendingHarness max={3} aspectRatios={['1:1']} />);
    await chooseFiles(dropzoneInput(), [devicePick('0.jpg')]);
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));
    const { onConfirm, images } = mocks.dialogTrigger.mock.calls[0][0].props;
    void onConfirm([{ src: images[0].url }]);

    await expectFilesFallbackOffered();
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
  });

  test('a copy taken at the pick that cannot be decoded keeps its error: the image itself is bad', async () => {
    vi.mocked(resizeImage).mockRejectedValueOnce(
      new ImagePrepError('decode', false, 'decode broke', { cause: imageLoadError() })
    );
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [imageFile('photo-0.jpg')]);

    await expect.element(page.getByText(PREP_ERROR, { exact: true })).toBeVisible();
    expect(page.getByText(PICK_MESSAGE).elements()).toHaveLength(0);
    expect(reports()).toEqual([
      ['source image prep failed: decode', 'picked-file image/jpeg <5MB Error'],
    ]);
  });

  test('into a slot: the Files fallback is offered, and a file from it fills that slot', async () => {
    mocks.getImageDimensions.mockRejectedValueOnce(imageLoadError());
    renderWithProviders(<SlotHarness />);
    await chooseFiles(dropzoneInput(), [devicePick('0.jpg')]);

    await expectFilesFallbackOffered();
    expect(filesFallbackInput().multiple).toBe(false);

    await chooseFiles(filesFallbackInput(), [imageFile('photo-1.jpg')]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const uploaded = await loadableImageUrl();
    uploads[0].resolve({ url: uploaded, available: true });
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([uploaded]));
  });

  test('into a slot, the upload cannot read it: the Files fallback is offered for that slot', async () => {
    vi.mocked(resizeImage).mockRejectedValueOnce(
      new ImagePrepError('read-blob', false, 'read broke', {
        cause: new TypeError('Failed to fetch'),
      })
    );
    renderWithProviders(<SlotHarness />);
    await chooseFiles(dropzoneInput(), [devicePick('0.jpg')]);

    await expectFilesFallbackOffered();
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();

    await chooseFiles(filesFallbackInput(), [imageFile('photo-1.jpg')]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const uploaded = await loadableImageUrl();
    uploads[0].resolve({ url: uploaded, available: true });
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([uploaded]));
  });

  test('two slots, one unreadable: the other still uploads, and the Files fallback fills the unreadable one', async () => {
    const unreadableUrls = new Set<string>();
    mocks.getImageDimensions.mockImplementation(async (src: unknown) => {
      if (unreadableUrls.has(src as string)) throw imageLoadError();
      return { width: 1024, height: 1024 };
    });
    const { createObjectURL } = URL;
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = createObjectURL.call(URL, obj);
      if (obj instanceof File && obj.name.startsWith('uncopied')) unreadableUrls.add(url);
      return url;
    };
    onTestFinished(() => {
      URL.createObjectURL = createObjectURL;
    });
    renderWithProviders(<SlotHarness />);
    await chooseFiles(dropzoneInput(), [imageFile('photo-0.jpg'), devicePick('1.jpg')]);

    // The other slot's upload is still in flight, so only the message is checked here.
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    expect(filesFallbackInput().multiple).toBe(false);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const first = await loadableImageUrl();
    uploads[0].resolve({ url: first, available: true });
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([first]));

    // The first slot is filled, so a file from Files can only fill the second.
    await chooseFiles(filesFallbackInput(), [imageFile('photo-2.jpg')]);
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    const second = await loadableImageUrl();
    uploads[1].resolve({ url: second, available: true });
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([first, second]));
  });

  test('two slots, one unreadable and one failing otherwise: both are told', async () => {
    const urls = new Map<string, string>();
    mocks.getImageDimensions.mockImplementation(async (src: unknown) => {
      const name = urls.get(src as string);
      if (name?.startsWith('uncopied')) throw imageLoadError();
      throw new DOMException('Image failed to load', 'EncodingError');
    });
    const { createObjectURL } = URL;
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = createObjectURL.call(URL, obj);
      if (obj instanceof File) urls.set(url, obj.name);
      return url;
    };
    onTestFinished(() => {
      URL.createObjectURL = createObjectURL;
    });
    renderWithProviders(<SlotHarness />);
    await chooseFiles(dropzoneInput(), [devicePick('0.jpg'), imageFile('photo-1.jpg')]);

    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    await expect.element(page.getByText(PREP_ERROR, { exact: true })).toBeVisible();
    await expect.poll(loaderCount).toBe(0);
    await vi.waitFor(() => expect(pendingNow()).toBe(false));
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
  });

  test('off Android: a neutral message and no Files chooser', async () => {
    mocks.android = false;
    mocks.getImageDimensions.mockRejectedValueOnce(imageLoadError());
    renderWithProviders(<PendingHarness max={3} />);
    await chooseFiles(dropzoneInput(), [devicePick('0.jpg')]);

    await expect
      .element(
        page.getByText("We couldn't open this file. Try choosing it again.", { exact: true })
      )
      .toBeVisible();
    expect(document.querySelector('[data-testid="unreadable-pick-files-input"]')).toBeNull();
    expect(document.body.textContent).not.toContain(LOAD_ERROR);
  });

  test('a pasted url that fails the same way is not a pick: it keeps its error card', async () => {
    mocks.getImageDimensions.mockRejectedValue(imageLoadError());
    renderWithProviders(<PendingHarness layout="url-input" max={3} />);
    await userEvent.fill(
      page.getByPlaceholder('Add a file or provide a URL'),
      'https://example.com/a.jpg'
    );
    await userEvent.keyboard('{Enter}');

    await expect.element(page.getByText(LOAD_ERROR, { exact: true })).toBeVisible();
    expect(page.getByText(PICK_MESSAGE).elements()).toHaveLength(0);
  });
});

function SlotHarness() {
  const [value, setValue] = useState<ImageValue[]>([]);
  const onChange = (next: ImageValue[]) =>
    setValue((prev) => {
      if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
      lastValue = next ?? [];
      return next;
    });
  return (
    <div data-testid="source-images">
      <ImageUploadMultipleInput
        value={value}
        onChange={onChange}
        slots={[{ label: 'First frame' }, { label: 'Last frame' }]}
      />
    </div>
  );
}

/** The upload measures the image it uploads, so its url is not downloaded again to measure it. */
describe('SourceImageUploadMultiple — an uploaded image', () => {
  beforeEach(() => {
    uploads = [];
    events = [];
    lastValue = [];
    valueWrites = [];
    mocks.orchestratorUrl = '';
    useImagesUploadingStore.setState({ uploading: [], verifying: [] });
    mocks.uploadConsumerBlob
      .mockReset()
      .mockImplementation(
        () => new Promise((resolve, reject) => uploads.push({ resolve, reject, settled: false }))
      );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.dialogTrigger.mockReset();
  });

  test('is not read again for its dimensions once it is in the value', async () => {
    renderWithProviders(<PendingHarness max={3} />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const uploaded = await loadableImageUrl();
    uploads[0].resolve({ url: uploaded, available: true });
    await vi.waitFor(() =>
      expect(lastValue).toEqual([{ url: uploaded, width: 1024, height: 1024 }])
    );
    await sleep(500);

    expect(mocks.getImageDimensions.mock.calls.filter(([src]) => src === uploaded)).toEqual([]);
    expect(pendingNow()).toBe(false);
  });
});

/**
 * A picked image is handed on as an in-memory copy, and a blob: url made for it holds that copy for
 * as long as the url lives. Once its card or slot no longer shows it and nothing is reading it, the
 * url is revoked so the copy can be freed: otherwise every pick stays in memory for the page's life.
 */
describe('SourceImageUploadMultiple — the copy taken at the pick is released', () => {
  let createUrl: MockInstance<typeof URL.createObjectURL>;
  let revokeUrl: MockInstance<typeof URL.revokeObjectURL>;

  beforeEach(() => {
    uploads = [];
    events = [];
    lastValue = [];
    valueWrites = [];
    mocks.orchestratorUrl = '';
    useImagesUploadingStore.setState({ uploading: [], verifying: [] });
    mocks.uploadConsumerBlob
      .mockReset()
      .mockImplementation(
        () => new Promise((resolve, reject) => uploads.push({ resolve, reject, settled: false }))
      );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.dialogTrigger.mockReset();
    createUrl = vi.spyOn(URL, 'createObjectURL');
    revokeUrl = vi.spyOn(URL, 'revokeObjectURL');
  });
  afterEach(() => {
    createUrl.mockRestore();
    revokeUrl.mockRestore();
  });

  /** The blob: urls made for in-memory copies of picks, in the order they were made. */
  const copyUrls = () =>
    createUrl.mock.calls.flatMap(([obj], i) =>
      obj instanceof File && isPickSnapshot(obj) ? [createUrl.mock.results[i].value as string] : []
    );
  const revoked = (url: string) => revokeUrl.mock.calls.some(([u]) => u === url);

  test('a card: its url is revoked once the upload lands, and a re-pick keeps no earlier copy', async () => {
    renderWithProviders(<PendingHarness max={3} />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    expect(copyUrls()).toHaveLength(1);
    const [first] = copyUrls();
    expect(revoked(first)).toBe(false);

    const uploadedA = await loadableImageUrl();
    uploads[0].resolve({ url: uploadedA, available: true });
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([uploadedA]));
    await vi.waitFor(() => expect(revoked(first)).toBe(true));
    // Revoked for real: the copy can no longer be reached through it.
    await expect(fetch(first)).rejects.toThrow();

    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    expect(copyUrls()).toHaveLength(2);
    const second = copyUrls()[1];
    expect(second).not.toBe(first);
    const uploadedB = await loadableImageUrl();
    uploads[1].resolve({ url: uploadedB, available: true });
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([uploadedA, uploadedB]));
    await vi.waitFor(() => expect(revoked(second)).toBe(true));
  });

  test('a read of it still in flight when the upload lands keeps it until that read is done', async () => {
    let finishRead = () => undefined as void;
    vi.mocked(extractSourceMetadata).mockImplementationOnce(
      () => new Promise((resolve) => (finishRead = () => resolve(undefined)))
    );
    // Settled even if an assertion below fails, so no read is left pending into a later test.
    onTestFinished(() => finishRead());
    renderWithProviders(<PendingHarness max={3} />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const [copy] = copyUrls();
    const uploaded = await loadableImageUrl();
    uploads[0].resolve({ url: uploaded, available: true });
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([uploaded]));

    await sleep(300);
    expect(revoked(copy)).toBe(false);
    finishRead();
    await vi.waitFor(() => expect(revoked(copy)).toBe(true));
  });

  test('a card whose upload failed keeps it while the card shows it, and releases it on removal', async () => {
    renderWithProviders(<PendingHarness max={3} />);
    await pickFiles(1);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const [copy] = copyUrls();
    uploads[0].reject(new Error(PRESIGN_ERROR));
    await expect.element(page.getByText(PRESIGN_ERROR)).toBeVisible();
    await sleep(300);
    expect(revoked(copy)).toBe(false);

    const close = await vi.waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>(
        '[data-testid="source-images"] button.mantine-ActionIcon-root:has(.tabler-icon-x)'
      );
      if (!el) throw new Error('remove button not found');
      return el;
    });
    await userEvent.click(close);
    await vi.waitFor(() => expect(revoked(copy)).toBe(true));
  });

  test('a slot: its url is revoked once the upload lands', async () => {
    renderWithProviders(<SlotHarness />);
    await chooseFiles(dropzoneInput(), [imageFile('photo-0.jpg')]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    expect(copyUrls()).toHaveLength(1);
    const [copy] = copyUrls();
    const uploaded = await loadableImageUrl();
    uploads[0].resolve({ url: uploaded, available: true });
    await vi.waitFor(() => expect(lastValue.map((v) => v.url)).toEqual([uploaded]));
    await vi.waitFor(() => expect(revoked(copy)).toBe(true));
  });
});

/**
 * A url that fails to load is reported with where it came from (already in the value, or a new card)
 * and the class of its host, never the url; a remote url that times out loading reads as a network
 * problem, not as one the device had preparing it.
 */
describe('SourceImageUploadMultiple — a url that cannot be loaded', () => {
  const cachedUrls: string[] = [];
  beforeEach(() => {
    uploads = [];
    events = [];
    lastValue = [];
    valueWrites = [];
    mocks.orchestratorUrl = '';
    useImagesUploadingStore.setState({ uploading: [], verifying: [] });
    mocks.uploadConsumerBlob.mockReset();
    mocks.getImageDimensions.mockReset();
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
    mocks.dialogTrigger.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const url of cachedUrls.splice(0)) sourceMetadataStore.removeMetadata(url);
  });

  const reports = () =>
    mocks.reportApplicationError.mock.calls.map(([error, ctx]) => [
      (error as Error).message,
      (ctx as { message?: string } | undefined)?.message,
    ]);

  test('a pasted url that times out loading shows network wording', async () => {
    mocks.getImageDimensions.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    renderWithProviders(<PendingHarness layout="url-input" />);
    await userEvent.fill(
      page.getByPlaceholder('Add a file or provide a URL'),
      'https://example.com/slow.jpg'
    );
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(mocks.getImageDimensions).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(IMAGE_PREP_STAGE_TIMEOUT_MS + 1000);

    await expect
      .element(
        page.getByText("Couldn't load this image. Check your connection and try again.", {
          exact: true,
        })
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain('on your device');
    expect(reports()).toEqual([
      ['source image prep failed: dims:timeout', 'url origin:card host:other'],
    ]);
  });

  test('a picked file that times out keeps the on-device wording', async () => {
    mocks.getImageDimensions.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    renderWithProviders(<PendingHarness />);
    await pickFiles(1);
    await vi.waitFor(() => expect(mocks.getImageDimensions).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(IMAGE_PREP_STAGE_TIMEOUT_MS + 1000);

    await expect
      .element(
        page.getByText(
          "Couldn't process this image on your device. Try a smaller photo or a screenshot.",
          { exact: true }
        )
      )
      .toBeVisible();
  });

  test('a pasted url whose upload times out loading it shows network wording', async () => {
    // The dimension check (which passes options) succeeds; the upload's own load never settles.
    mocks.getImageDimensions.mockImplementation((_src: unknown, options?: unknown) =>
      options ? Promise.resolve({ width: 1024, height: 1024 }) : new Promise(() => undefined)
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    renderWithProviders(<PendingHarness layout="url-input" />);
    const url = 'https://example.com/slow-upload.jpg';
    cachedUrls.push(url);
    await userEvent.fill(page.getByPlaceholder('Add a file or provide a URL'), url);
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(mocks.getImageDimensions).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(IMAGE_PREP_STAGE_TIMEOUT_MS + 1000);

    await expect
      .element(
        page.getByText("Couldn't load this image. Check your connection and try again.", {
          exact: true,
        })
      )
      .toBeVisible();
    expect(reports()).toEqual([
      ['source image prep failed: dims:timeout', 'url origin:card host:other'],
    ]);
  });

  test('re-uploading an image already in the value, after a crop, reports origin:value', async () => {
    // A url the preview can load (served by the test server): an unloadable one removes its own
    // card from the value, and a confirm landing after that reads it as a new card.
    const url = new URL('/test/fixtures/pixel.svg', window.location.origin).href;
    cachedUrls.push(url);
    // The dimension check (which passes options) succeeds; the upload's own load fails.
    mocks.getImageDimensions.mockImplementation((_src: unknown, options?: unknown) =>
      options
        ? Promise.resolve({ width: 600, height: 2000 })
        : Promise.reject(new Error('Image failed to load'))
    );
    renderWithProviders(
      <PendingHarness aspectRatios={['1:1']} initialValue={[{ url, width: 600, height: 2000 }]} />
    );
    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));
    // Confirmed uncropped: an image that is not an orchestrator url is uploaded as it is.
    void mocks.dialogTrigger.mock.calls[0][0].props.onConfirm([{ src: url }]);

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(reports()).toEqual([
      ['source image prep failed: dims', 'url Error origin:value host:other'],
    ]);
  });

  test.each([
    ['https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg', 'orchestrator'],
    [`${IMAGE_LOCATION}/abc/original=true/a.jpeg`, 'image-cdn'],
    ['https://civitai.com/images/123', 'site-page'],
    ['https://example.com/only-in-the-value.jpg', 'other'],
  ])('an image already in the value: %s reports host:%s', async (url, hostClass) => {
    cachedUrls.push(url);
    mocks.getImageDimensions.mockRejectedValue(new Error('Image failed to load'));
    renderWithProviders(<PendingHarness initialValue={[{ url, width: 1024, height: 1024 }]} />);

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(reports()).toEqual([
      ['source image prep failed: dims', `url Error origin:value host:${hostClass}`],
    ]);
  });
});

function dropzoneInput() {
  return vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="source-images"] input[type=file]:not([data-testid="unreadable-pick-files-input"])'
    );
    if (!input) throw new Error('dropzone input not found');
    return input;
  });
}

function filesFallbackInput() {
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="unreadable-pick-files-input"]'
  );
  if (!input) throw new Error('Files fallback input not found');
  return input;
}
