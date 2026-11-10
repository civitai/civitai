import { createHash } from 'node:crypto';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { ApiKeyType } from '~/shared/utils/prisma/enums';

export type RequestCredential = {
  tokenScope: number;
  apiKeyId: number | undefined;
  apiKeyType: ApiKeyType | undefined;
  subject: { type: 'apiKey'; id: number } | { type: 'oauth'; id: string } | undefined;
};

/**
 * The credential `getServerAuthSession` recorded on `req.context`, so it must have run on this
 * request object first. A cookie session records none: it gets the full scope and no key fields.
 */
export function getRequestCredential(req: unknown): RequestCredential {
  const context = (req as { context?: Record<string, unknown> } | undefined)?.context;
  return {
    tokenScope: (context?.tokenScope as number | null | undefined) ?? TokenScope.Full,
    apiKeyId: (context?.apiKeyId ?? undefined) as RequestCredential['apiKeyId'],
    apiKeyType: (context?.apiKeyType ?? undefined) as RequestCredential['apiKeyType'],
    subject: (context?.subject ?? undefined) as RequestCredential['subject'],
  };
}

/** The credential's kind for a log line: no user, key id or address, and an OAuth client id hashed. */
export function credentialLogFields({ tokenScope, apiKeyType, subject }: RequestCredential) {
  return {
    tokenScope,
    apiKeyType: apiKeyType ?? null,
    client: subject?.type === 'oauth' ? 'oauth' : 'personal-key',
    clientIdHash:
      subject?.type === 'oauth'
        ? createHash('sha256').update(String(subject.id)).digest('hex').slice(0, 16)
        : undefined,
  };
}
