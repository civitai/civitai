import { hashToken as nextAuthHashToken } from 'next-auth/core/lib/utils';
import { env } from '~/env/server.mjs';

export function hashToken(token: string) {
  return nextAuthHashToken(token, {
    provider: {},
    secret: env.NEXTAUTH_SECRET,
  });
}
