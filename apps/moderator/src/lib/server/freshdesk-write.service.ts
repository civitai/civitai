import { env } from '$env/dynamic/private';
import { freshdeskHost, isFreshdeskId } from './freshdesk.service';

// Freshdesk WRITES, kept apart from `freshdesk.service.ts` so that module stays GET-only.
//
// They use their own key, FRESHDESK_WRITE_API_KEY: customers see the key's seat as the sender, and the
// read key must keep working (and stay unable to write) when this one is absent or rotated. There is
// deliberately no fallback from one to the other.
//
// Never throws. A failed write is a result the caller must report, not an exception that unmounts a page
// holding the operator's typed reply.

export type WriteResult =
  | { status: 'ok' }
  | { status: 'not_configured' }
  | { status: 'error'; httpStatus: number | null; message: string };

const error = (httpStatus: number | null, message: string): WriteResult => ({
  status: 'error',
  httpStatus,
  message,
});

async function freshdeskWrite(
  method: 'POST' | 'PUT',
  path: string,
  body: Record<string, unknown>
): Promise<WriteResult> {
  const key = env.FRESHDESK_WRITE_API_KEY;
  if (!key) return { status: 'not_configured' };
  const auth = Buffer.from(`${key}:X`).toString('base64');
  try {
    const res = await fetch(`https://${freshdeskHost()}/api/v2${path}`, {
      method,
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { status: 'ok' };
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      return error(
        429,
        `Freshdesk's rate limit is reached${
          Number.isFinite(wait) && wait > 0 ? ` — retry in ${wait}s` : ' — retry shortly'
        }.`
      );
    }
    // Only Freshdesk's own one-line description reaches the operator, never the raw body.
    const detail = await res
      .json()
      .then((b: { description?: unknown }) =>
        typeof b?.description === 'string' ? b.description.slice(0, 200) : null
      )
      .catch(() => null);
    return error(res.status, `Freshdesk refused it (${res.status})${detail ? `: ${detail}` : ''}`);
  } catch (e) {
    console.error('[freshdesk] write failed', method, path.replace(/\d+/g, '#'), e);
    return error(null, 'Freshdesk could not be reached.');
  }
}

const ticketPath = (ticketId: string, suffix = '') => `/tickets/${ticketId}${suffix}`;
const badId = error(null, 'Not a Freshdesk ticket id.');

/** A public reply: Freshdesk emails it to the requester. `bodyHtml` must already be safe HTML. */
export const replyToTicket = (ticketId: string, bodyHtml: string): Promise<WriteResult> =>
  isFreshdeskId(ticketId)
    ? freshdeskWrite('POST', ticketPath(ticketId, '/reply'), { body: bodyHtml })
    : Promise.resolve(badId);

/** A note only agents see — never emailed. */
export const addPrivateNote = (ticketId: string, bodyHtml: string): Promise<WriteResult> =>
  isFreshdeskId(ticketId)
    ? freshdeskWrite('POST', ticketPath(ticketId, '/notes'), { body: bodyHtml, private: true })
    : Promise.resolve(badId);

export const setTicketStatus = (ticketId: string, status: number): Promise<WriteResult> =>
  isFreshdeskId(ticketId)
    ? freshdeskWrite('PUT', ticketPath(ticketId), { status })
    : Promise.resolve(badId);
