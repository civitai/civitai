import { env } from '$env/dynamic/private';
import {
  basicAuthHeader,
  freshdeskApiUrl,
  isFreshdeskId,
  rateLimitMessage,
} from './freshdesk.service';

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
  /** `certain`: Freshdesk refused the request (or none was made), so the write did NOT happen. False
   *  for a network failure, a timeout or a 5xx, where it may have landed before the answer was lost. */
  | { status: 'error'; httpStatus: number | null; certain: boolean; message: string };

const error = (httpStatus: number | null, message: string, certain: boolean): WriteResult => ({
  status: 'error',
  httpStatus,
  certain,
  message,
});

/** A 4xx other than 408 is a refusal; 408 says the server gave up waiting, which proves nothing. */
const isRefusal = (httpStatus: number) =>
  httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408;

async function freshdeskWrite(
  method: 'POST' | 'PUT',
  path: string,
  body: Record<string, unknown>
): Promise<WriteResult> {
  const key = env.FRESHDESK_WRITE_API_KEY;
  if (!key) return { status: 'not_configured' };
  try {
    const res = await fetch(freshdeskApiUrl(path), {
      method,
      headers: { authorization: basicAuthHeader(key), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { status: 'ok' };
    if (res.status === 429) return error(429, rateLimitMessage(res), true);
    // Only Freshdesk's own one-line description reaches the operator, never the raw body.
    const detail = await res
      .json()
      .then((b: { description?: unknown }) =>
        typeof b?.description === 'string' ? b.description.slice(0, 200) : null
      )
      .catch(() => null);
    return error(
      res.status,
      `Freshdesk refused it (${res.status})${detail ? `: ${detail}` : ''}`,
      isRefusal(res.status)
    );
  } catch (e) {
    console.error('[freshdesk] write failed', method, path.replace(/\d+/g, '#'), e);
    return error(null, 'Freshdesk could not be reached.', false);
  }
}

const ticketPath = (ticketId: string, suffix = '') => `/tickets/${ticketId}${suffix}`;
const badId = error(null, 'Not a Freshdesk ticket id.', true);

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

/** Fields of one ticket, replaced as given: Freshdesk's PUT replaces `tags` wholesale, so the caller
 *  sends the full array. */
export const updateTicket = (
  ticketId: string,
  fields: Record<string, unknown>
): Promise<WriteResult> =>
  isFreshdeskId(ticketId)
    ? freshdeskWrite('PUT', ticketPath(ticketId), fields)
    : Promise.resolve(badId);
