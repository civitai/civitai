import { z } from 'zod';
import { env } from '~/env/client.mjs';

class SignalClient {
  private _endpoint: string;

  // TODO - since this could be called on the client, we should find a way to obfuscate the userId
  getUserToken = async (userId: number): Promise<{ accessToken: string }> => {
    const response = await fetch(`${this._endpoint}/users/${userId}/accessToken`);
    if (!response.ok) throw new Error('failed to fetch user token');
    return await response.json();
  };

  send = async ({
    target,
    data,
    userId,
  }: {
    target: string;
    data: Record<string, unknown>;
    userId: number;
  }) => {
    const response = await fetch(`${this._endpoint}/users/${userId}/signals/${target}`, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`failed to send signal: ${target}`);
    }
  };

  constructor({ endpoint }: { endpoint: string }) {
    this._endpoint = z.string().url().parse(endpoint);
  }
}

export const signalClient = new SignalClient({ endpoint: env.NEXT_PUBLIC_SIGNALS_ENDPOINT ?? '' });
