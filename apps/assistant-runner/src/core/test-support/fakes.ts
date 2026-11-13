import { jsonSchema, tool, type ToolSet } from 'ai';

import type { Authenticator, OpenTools, ToolProvider } from '../interfaces';

/**
 * Takes the viewer from `authorization: Bearer user:<id>`, as a real authenticator turns a token
 * into a user id. Refuses anything else.
 */
export const bearerAuthenticator: Authenticator = {
  authenticate: async (headers) => {
    const match = /^Bearer user:([^\s:]+)(?::.*)?$/.exec(headers.authorization ?? '');
    return match
      ? { ok: true, userId: match[1]! }
      : { ok: false, status: 401, message: 'Sign in.' };
  },
};

export type ToolBody = (
  input: Record<string, unknown>,
  options: { abortSignal?: AbortSignal }
) => Promise<unknown>;

/** Tools from plain functions; counts how often the set was opened and closed. */
export function fakeTools(bodies: Record<string, ToolBody>) {
  const stats = { opened: 0, closed: 0 };
  const provider: ToolProvider = {
    open: async (): Promise<OpenTools> => {
      stats.opened++;
      const tools: ToolSet = {};
      for (const [name, body] of Object.entries(bodies)) {
        tools[name] = tool({
          description: name,
          inputSchema: jsonSchema<Record<string, unknown>>({
            type: 'object',
            additionalProperties: true,
          }),
          execute: (input, { abortSignal }) => body(input, { abortSignal }),
        });
      }
      return {
        tools,
        close: async () => {
          stats.closed++;
        },
      };
    },
  };
  return { provider, stats };
}

/** Resolves when `signal` aborts (or after `ms`): a tool call that runs until the run stops. */
export function untilAborted(signal: AbortSignal | undefined, ms = 120_000): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('finished'), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve('aborted');
    });
  });
}
