import { env } from '$env/dynamic/private';
import { Agent, fetch as undiciFetch } from 'undici';
import { civitaiAppUrl } from './civitai-url';

const agents = new Map<string, Agent>();

type DispatchHeaders = Agent.DispatchOptions['headers'];

function withHost(headers: DispatchHeaders, host: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const add = (name: string, value: unknown) => {
    if (name.toLowerCase() !== 'host' && value != null) out[name] = value as string | string[];
  };
  if (Array.isArray(headers))
    for (let i = 0; i + 1 < headers.length; i += 2) add(String(headers[i]), headers[i + 1]);
  else if (headers && typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function')
    for (const [name, value] of headers as Iterable<[string, string | string[] | undefined]>)
      add(name, value);
  else if (headers) for (const [name, value] of Object.entries(headers)) add(name, value);
  out.host = host;
  return out;
}

/** An agent that sends `host` as the Host header. Node's global fetch drops a Host set in `headers`;
 *  a dispatcher sees the request after that filter. */
function agentFor(host: string): Agent {
  let agent = agents.get(host);
  if (!agent) {
    agent = new Agent().compose(
      (dispatch) => (opts, handler) =>
        dispatch({ ...opts, headers: withHost(opts.headers, host) }, handler)
    ) as Agent;
    agents.set(host, agent);
  }
  return agent;
}

/**
 * `fetch` for a URL under `civitaiInternalUrl()`. With `CIVITAI_INTERNAL_URL` set it carries the public Host
 * from `CIVITAI_APP_URL`: the main app picks which session cookie to read by Host, so the relayed
 * moderator session must look like it arrived on the public site. A redirect comes back as the 3xx
 * rather than being followed: the next hop would get the public Host forced on it, and a hop to the
 * public https origin would drop the Cookie. Unset, it is the global fetch.
 */
export const mainAppHostFetch: typeof fetch = (input, init = {}) => {
  if (!env.CIVITAI_INTERNAL_URL) return globalThis.fetch(input, init);
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    redirect: 'manual',
    dispatcher: agentFor(new URL(civitaiAppUrl()).host),
  }) as unknown as Promise<Response>;
};
