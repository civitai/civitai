/** A sandbox as the hosted sandbox service returns it. */
export interface Sandbox {
  name: string;
  /** The app key it was created for. */
  app: string;
  /**
   * `seed_lost`: a sandbox created with a seed whose files never landed (its starting files could
   * not be copied in). It is empty; the remedy is to delete it and fork again.
   */
  state: 'starting' | 'running' | 'suspended' | 'seed_lost';
  /** The sandbox's MCP endpoint, served behind the same bearer token. */
  mcpUrl: string;
  createdAt: string | null;
  lastActivityAt: string | null;
  /** When an idle, suspended sandbox is deleted. */
  expiresAt: string | null;
}

export type SandboxErrorKind =
  | 'limit'
  | 'conflict'
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable';

export class SandboxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: SandboxErrorKind,
    /** The service's machine-readable `code`, when it sent one (`already_exists`, `seed_*`). */
    readonly code: string | null = null
  ) {
    super(message);
    this.name = 'SandboxApiError';
  }
}

/**
 * The starting files for a NEW sandbox: a ZIP the service downloads once from `url` (an HTTPS URL
 * on a host it allows), checks against `sha256` and `bytes`, and unpacks into the app's folder.
 */
export interface SandboxSeed {
  url: string;
  sha256: string;
  bytes: number;
}

/** What the service reports about a seed it unpacked. */
export interface SandboxSeedResult {
  files: number;
  skipped: string[];
}

/** The service's sandbox names: a DNS label. Checked before a name goes into a path. */
const SANDBOX_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** 409 covers both the per-user caps and a transient concurrent change; only the message tells them apart. */
const LIMIT_MESSAGE = /limit \(\d+\) reached/;

function errorKind(status: number, message: string): SandboxErrorKind {
  switch (status) {
    case 400:
    case 413:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return LIMIT_MESSAGE.test(message) ? 'limit' : 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return 'unavailable';
  }
}

/** The cap on sandboxes running at once, as opposed to the cap on sandboxes kept. */
export function isRunningLimit(error: unknown): boolean {
  return (
    error instanceof SandboxApiError && error.kind === 'limit' && /running/.test(error.message)
  );
}

/** Whether `url` is served by the sandbox service at `baseUrl`, so it may receive the user's token. */
export function isSandboxServiceUrl(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export interface SandboxClient {
  list(): Promise<Sandbox[]>;
  get(name: string): Promise<Sandbox>;
  /**
   * Finds, creates or resumes the caller's sandbox for `app`. With a `seed` it only CREATES: the
   * service refuses with 409 `already_exists` when the app has a sandbox, and `seed` on the result
   * says what was unpacked.
   */
  open(
    app: string,
    seed?: SandboxSeed
  ): Promise<{ sandbox: Sandbox; created: boolean; seed?: SandboxSeedResult }>;
  suspend(name: string): Promise<Sandbox>;
  remove(name: string): Promise<void>;
}

export interface SandboxClientOptions {
  baseUrl: string;
  /** The caller's OAuth access token; `refresh` asks for a new one after a 401. */
  getToken: (opts?: { refresh?: boolean }) => Promise<string>;
  fetch?: typeof fetch;
}

export function createSandboxClient({
  baseUrl,
  getToken,
  fetch: fetchImpl = (...args) => fetch(...args),
}: SandboxClientOptions): SandboxClient {
  const base = baseUrl.replace(/\/+$/, '');

  async function send(method: string, path: string, body?: unknown, refresh = false) {
    const token = await getToken({ refresh });
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !refresh) return send(method, path, body, true);
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const message =
        typeof data?.error === 'string' ? data.error : `Sandbox service error (${res.status})`;
      const code = typeof data?.code === 'string' ? data.code : null;
      throw new SandboxApiError(message, res.status, errorKind(res.status, message), code);
    }
    return { status: res.status, data };
  }

  function itemPath(name: string, suffix = '') {
    if (!SANDBOX_NAME.test(name))
      throw new SandboxApiError('Invalid sandbox name', 400, 'bad_request');
    return `/v1/sandboxes/${name}${suffix}`;
  }

  return {
    async list() {
      const { data } = await send('GET', '/v1/sandboxes');
      return Array.isArray(data?.sandboxes) ? (data.sandboxes as Sandbox[]) : [];
    },
    async get(name) {
      return (await send('GET', itemPath(name))).data as unknown as Sandbox;
    },
    async open(app, seed) {
      const { status, data } = await send('POST', '/v1/sandboxes', seed ? { app, seed } : { app });
      if (!seed) return { sandbox: data as unknown as Sandbox, created: status === 201 };
      // A seeded create is answered 201 with what was unpacked. Anything else means the service
      // did not seed it (one that predates seeding finds or creates an EMPTY sandbox), which must
      // not pass for a fork.
      const result = (data as { seed?: unknown } | null)?.seed as SandboxSeedResult | undefined;
      if (status !== 201 || !result || typeof result.files !== 'number')
        throw new SandboxSeedNotAppliedError((data as unknown as Sandbox | null) ?? null);
      return { sandbox: data as unknown as Sandbox, created: true, seed: result };
    },
    async suspend(name) {
      return (await send('POST', itemPath(name, '/suspend'))).data as unknown as Sandbox;
    },
    async remove(name) {
      await send('DELETE', itemPath(name));
    },
  };
}

/**
 * A seeded create the service answered without unpacking the seed: the sandbox it names (if any)
 * exists but is EMPTY. Read like `seed_lost`: delete it and fork again.
 */
export class SandboxSeedNotAppliedError extends Error {
  readonly code = 'seed_lost';
  constructor(readonly sandbox: Sandbox | null) {
    super('The sandbox service did not apply the seed');
    this.name = 'SandboxSeedNotAppliedError';
  }
}

/**
 * Creates or resumes the sandbox for `app` (with `seed`, creates it seeded). The service runs one at
 * a time, so when it refuses for that reason the others are suspended and the open is tried once
 * more; any other refusal leaves them running.
 */
export async function openApp(
  client: SandboxClient,
  app: string,
  seed?: SandboxSeed
): Promise<{ sandbox: Sandbox; created: boolean; seed?: SandboxSeedResult }> {
  try {
    return await client.open(app, seed);
  } catch (error) {
    // The service checks the kept-apps cap before the running cap, so at that cap nothing is paused.
    if (!isRunningLimit(error)) throw error;
  }
  const others = (await client.list()).filter((s) => s.app !== app && s.state !== 'suspended');
  for (const sandbox of others) await client.suspend(sandbox.name);
  return client.open(app, seed);
}
