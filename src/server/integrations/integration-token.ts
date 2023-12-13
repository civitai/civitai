import jwt from 'jsonwebtoken';
import { env } from '~/env/server.mjs';

interface TokenPayload {
  userId: number;
}

export const createToken = (userId: number): string => {
  if (!env.INTEGRATION_TOKEN) throw new Error('Token secret is not set');

  const payload: TokenPayload = { userId };
  return jwt.sign(payload, env.INTEGRATION_TOKEN, { expiresIn: '1h' }); // Token expires in 1 hour
};

export const readToken = (token: string): number => {
  if (!env.INTEGRATION_TOKEN) throw new Error('Token secret is not set');

  try {
    const decoded = jwt.verify(token, env.INTEGRATION_TOKEN) as TokenPayload;
    return decoded.userId;
  } catch (error) {
    throw new Error('Invalid token');
  }
};
