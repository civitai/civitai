import jwt from 'jsonwebtoken';
import { env } from '~/env/server.mjs';
import { logToAxiom } from '~/server/logging/client';
import { toBase64 } from '~/utils/string-helpers';

export async function createFreshdeskToken(
  user: { id?: number; username?: string; email?: string },
  nonce: string
) {
  if (!env.FRESHDESK_JWT_SECRET) return;
  if (!user.id || !user.username || !user.email) return;

  createContact(user);

  const body = {
    sub: `civitai-${user.id}`,
    email: user.email,
    iat: Math.floor(Date.now() / 1000),
    nonce,
    given_name: user.username,
    family_name: 'Civitan',
  };

  return jwt.sign(body, env.FRESHDESK_JWT_SECRET.replace(/\\n/g, '\n'), {
    algorithm: 'RS256',
  });
}

export async function createContact(user: { id?: number; username?: string; email?: string }) {
  if (!env.FRESHDESK_TOKEN || !env.FRESHDESK_DOMAIN) return;
  if (!user.id || !user.username || !user.email) return;

  try {
    const response = await fetch(`${env.FRESHDESK_DOMAIN}/api/v2/contacts`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${toBase64(`${env.FRESHDESK_TOKEN}:X`)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        active: true,
        name: user.username,
        email: user.email,
        unique_external_id: `civitai-${user.id}`,
      }),
    });

    if (!response.ok) {
      if (response.status === 409) return;
      logToAxiom(
        {
          name: 'freshdesk',
          type: 'error',
          statusCode: response.status,
          message: await response.text(),
        },
        'civitai-prod'
      );
    }
  } catch (error) {
    logToAxiom(
      {
        name: 'freshdesk',
        type: 'error',
        statusCode: 500,
        message: (error as Error).message,
      },
      'civitai-prod'
    );
  }
}
