import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { env } from '~/env/server.mjs';

export function createFeaturebaseToken(user: { username: string; email: string }) {
  if (!env.FEATUREBASE_JWT_SECRET) return;

  const body = {
    name: user.username,
    email: user.email,
    jti: uuid(),
  };

  return jwt.sign(body, env.FEATUREBASE_JWT_SECRET, {
    algorithm: 'HS256',
  });
}
