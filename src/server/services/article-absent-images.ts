import { getEdgeUrl } from '~/client-utils/edge-url';
import { cdnStateUrls } from '~/server/services/cdn-access.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  isProbeableMediaKey,
  probeCreatedImageMedia,
  type CreatedImageMediaVerdict,
} from '~/server/utils/created-image-media-probe';
import { outboundFetch } from '~/server/utils/fetch-timeout';

export type EdgeVerdict = 'present' | 'absent' | 'unknown';

/**
 * Whether an image's file is gone: the upload store answers absent, and the image server answers
 * 404 for a url it is not denying. A url it denies also answers 404 with the file stored, and a key
 * kept in another store answers absent from the upload store, so either alone proves nothing.
 */
export function isConfirmedAbsent(answers: {
  store: CreatedImageMediaVerdict;
  edge: EdgeVerdict;
  denied: boolean;
}) {
  return answers.store === 'absent' && answers.edge === 'absent' && !answers.denied;
}

const EDGE_PROBE_TIMEOUT_MS = 3000;

/**
 * What the image server answers for one byte of `url`. Only a 404 says absent; a 403, a 5xx, a
 * timeout or a url that is not absolute says nothing.
 */
export async function probeEdgeUrl(url: string): Promise<EdgeVerdict> {
  if (!/^https?:\/\//.test(url)) return 'unknown';
  try {
    const res = await outboundFetch(url, {
      headers: { Range: 'bytes=0-0' },
      timeoutMs: EDGE_PROBE_TIMEOUT_MS,
    });
    await res.body?.cancel();
    if (res.status === 404) return 'absent';
    if (res.status === 200 || res.status === 206) return 'present';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export type AbsentImageDeps = {
  probeStore: (key: string) => Promise<CreatedImageMediaVerdict>;
  probeEdge: (key: string) => Promise<EdgeVerdict>;
  /** The urls the image server has been told to deny. */
  deniedUrls: (urls: string[]) => Promise<Set<string>>;
};

const defaultDeps: AbsentImageDeps = {
  // Objects are stored under lowercase keys.
  probeStore: (key) => probeCreatedImageMedia(key.toLowerCase()),
  probeEdge: (key) => probeEdgeUrl(getEdgeUrl(key, { original: true })),
  deniedUrls: cdnStateUrls,
};

const PROBE_CONCURRENCY = 4;

/** The ids among `images` whose file is confirmed gone (`isConfirmedAbsent`). A failed lookup confirms none. */
export async function findAbsentImages(
  images: { id: number; url: string }[],
  deps: AbsentImageDeps = defaultDeps
) {
  const absent = new Set<number>();
  const probeable = images.filter((image) => isProbeableMediaKey(image.url));
  if (!probeable.length) return absent;
  let denied: Set<string>;
  try {
    denied = await deps.deniedUrls(probeable.map((image) => image.url));
  } catch {
    return absent;
  }
  await limitConcurrency(
    probeable.map((image) => async () => {
      const store = await deps.probeStore(image.url);
      if (store !== 'absent') return;
      const edge = await deps.probeEdge(image.url);
      if (isConfirmedAbsent({ store, edge, denied: denied.has(image.url) })) absent.add(image.id);
    }),
    PROBE_CONCURRENCY
  );
  return absent;
}
