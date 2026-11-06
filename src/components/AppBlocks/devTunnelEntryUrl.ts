/** A freshly signed dev-tunnel entry URL and the host it is on. */
export interface DevTunnelEntryUrl {
  iframeSrc: string;
  host: string;
}

/** A dev-tunnel entry-URL route's JSON answer, as far as this module reads it. */
export type EntryUrlBody = Partial<DevTunnelEntryUrl> & { error?: string } & Record<
    string,
    unknown
  >;

/**
 * GETs an entry-URL route same-origin and returns its JSON body (`{}` when it is not JSON). A
 * non-2xx answer throws `refuse(status, body)` when that returns an error, else
 * `Error(body.error ?? fallback)`.
 */
export async function fetchEntryUrlBody(
  path: string,
  fetchImpl: typeof fetch,
  {
    fallback,
    refuse,
  }: { fallback: string; refuse?: (status: number, body: EntryUrlBody | null) => Error | undefined }
): Promise<EntryUrlBody> {
  const res = await fetchImpl(path, { credentials: 'same-origin' });
  const data = (await res.json().catch(() => null)) as EntryUrlBody | null;
  if (!res.ok) throw refuse?.(res.status, data) ?? new Error(data?.error ?? fallback);
  return data ?? {};
}

/** The body's entry URL, only when it is an https URL on the host the body names. */
export function checkedEntryUrl(body: EntryUrlBody, fallback: string): DevTunnelEntryUrl {
  const { iframeSrc, host } = body;
  if (!iframeSrc || !host) throw new Error(body.error ?? fallback);
  let url: URL;
  try {
    url = new URL(iframeSrc);
  } catch {
    throw new Error('The entry URL is malformed');
  }
  if (url.protocol !== 'https:' || url.host !== host)
    throw new Error('The entry URL is not on its tunnel host');
  return { iframeSrc, host };
}

const NO_ENTRY_URL = 'No fresh entry URL is available';

/** A freshly signed entry URL for the caller's own `blockId`, from `/api/apps/dev/entry-url`. */
export async function fetchDevTunnelEntryUrl(
  blockId: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): Promise<DevTunnelEntryUrl> {
  const body = await fetchEntryUrlBody(
    `/api/apps/dev/entry-url?blockId=${encodeURIComponent(blockId)}`,
    fetchImpl,
    { fallback: NO_ENTRY_URL }
  );
  return checkedEntryUrl(body, NO_ENTRY_URL);
}
