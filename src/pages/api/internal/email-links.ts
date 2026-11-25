import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { loadAuthEnv } from '@civitai/auth';
import { EMAIL_LINK_MAX_LENGTH, EMAIL_LINKS_MAX, isSendId, MAIL_CLASSES } from '@civitai/email';
import { trackEmailHrefs } from '~/server/email/link-tracking';
import { TokenSecuredEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Signs another app's email links for the click redirect, so an app without the signing key (the
 * moderator app, through @civitai/email's createRemoteLinkTracker) sends tracked links and the key
 * never leaves this app. Given one send's tags and its hrefs in document order, it returns the same
 * number of hrefs in the same order: each same-site one (the shared return-path rule) as its signed
 * /api/email/click link, numbered among the tracked ones, and every other one exactly as given. It
 * records nothing; the click route does, when a link is followed.
 *
 * Never an address in or out: the body is the send's tags and web links only (a mailto: or any
 * other scheme is refused), and a body naming anything else is refused whole. A template whose
 * links carry a one-time token never calls this (createEmail's `oneTimeTokenLinks`).
 *
 * Authenticated by AUTH_INTERNAL_TOKEN as the Bearer, like /api/internal/email-events. Unset or
 * blank here, every call is refused (503).
 */

// A web link as written in the attribute: absolute http(s) or a path. Anything else (mailto:,
// javascript:, data:) is refused, so no address is ever sent here.
const link = z
  .string()
  .max(EMAIL_LINK_MAX_LENGTH)
  .regex(/^(?:https?:\/\/|\/)/i);

const body = z.strictObject({
  // Lowercase, as the sender's transport writes it (resolveSendId).
  sendId: z.string().refine(isSendId),
  template: z.string().min(1).max(100),
  mailClass: z.enum(MAIL_CLASSES),
  campaign: z.string().max(200),
  variant: z.string().max(200),
  userId: z
    .number()
    .int()
    .min(0)
    .max(2 ** 32 - 1),
  links: z.array(link).min(1).max(EMAIL_LINKS_MAX),
});

export async function handleEmailLinks(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid links' });
    return;
  }
  const { links, ...send } = parsed.data;
  res.status(200).json({ links: trackEmailHrefs(links, send) });
}

// The token is read per request, so the route never parses the auth env at import.
export default function emailLinksRoute(req: NextApiRequest, res: NextApiResponse) {
  return TokenSecuredEndpoint(loadAuthEnv().AUTH_INTERNAL_TOKEN ?? '', handleEmailLinks)(req, res);
}
