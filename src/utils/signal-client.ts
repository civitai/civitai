import * as z from 'zod';
import { env } from '~/env/server';
import type { SignalTopic } from '~/server/common/enums';
import { withSignals } from '~/server/signals/wrapper';

class SignalClient {
  private _endpoint: string;

  // TODO - since this could be called on the client, we should find a way to obfuscate the userId
  getUserToken = async (userId: number): Promise<{ accessToken: string }> => {
    // Wrap with withSignals so a signals brownout fails fast at
    // SIGNALS_CALL_TIMEOUT_MS instead of bleeding the event loop until
    // Traefik's 30s router timeout. SignalsCallTimeoutError surfaces here
    // as-is — callers already throw on any failure mode.
    const response = await withSignals(() =>
      fetch(`${this._endpoint}/users/${userId}/accessToken`)
    );
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
    // Wrap with withSignals + retain the in-call AbortSignal.timeout(5000) as a
    // belt-and-suspenders deadline. The withSignals timer is the load-shed
    // gate; the AbortSignal aborts the underlying connection so a slow
    // upstream doesn't leak a socket past the timer race.
    const response = await withSignals(() =>
      fetch(`${this._endpoint}/users/${userId}/signals/${target}`, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      })
    );

    if (!response.ok) {
      // Fallback to text if json fails
      const errorData = await response
        .json()
        .catch(() => response.text())
        .catch(() => null);

      throw new Error(`failed to send signal: ${target}. Expected 200, got ${response.status}`, {
        cause: errorData,
      });
    }
  };

  topicSend = async ({
    topic,
    target,
    data,
  }: {
    topic: `${SignalTopic}${'' | `:${number}` | `:${string}`}`;
    target: string;
    data: Record<string, unknown>;
  }) => {
    const response = await withSignals(() =>
      fetch(`${this._endpoint}/topics/${topic}/signals/${target}`, {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      })
    );

    if (!response.ok) {
      throw new Error(`failed to send topic signal: ${target}`);
    }
  };

  constructor({ endpoint }: { endpoint: string }) {
    this._endpoint = z
      .string()
      .url()
      .parse(endpoint || 'http://localhost');
  }
}

export const signalClient = new SignalClient({ endpoint: env.SIGNALS_ENDPOINT ?? '' });
