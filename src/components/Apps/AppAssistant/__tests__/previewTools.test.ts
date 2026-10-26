import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewSession, PreviewToolDeps } from '~/components/Apps/AppAssistant/previewTools';
import {
  PREVIEW_NOT_ENABLED,
  createPreviewTools,
  runnerPreviewAction,
} from '~/components/Apps/AppAssistant/previewTools';

const KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExample sandbox-dev-tunnel';
const STARTED = {
  sessionId: 'bki_01',
  host: 'dev-0123456789abcdef.civit.ai',
  sshHostPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyHostKeyHostKey',
};
const ctx = { signal: new AbortController().signal, conversationId: 'c1', files: [] };
const trpcError = (code: string, message = code) =>
  Object.assign(new Error(message), { data: { code } });

let session: PreviewSession | null;
let sandboxName: string | null;
let deps: PreviewToolDeps & {
  startDevTunnel: ReturnType<typeof vi.fn>;
  stopDevTunnel: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  session = null;
  sandboxName = 'sbx-aaaaaaaaaaaa';
  deps = {
    currentSandbox: () => sandboxName,
    canPreview: true,
    defaultBlockId: () => 'my-app',
    startDevTunnel: vi.fn(async () => STARTED),
    stopDevTunnel: vi.fn(async () => ({ ok: true })),
    getSession: () => session,
    setSession: (next) => {
      session = next;
    },
  };
});

const start = (input: Record<string, unknown>) =>
  createPreviewTools(deps).start_preview.execute(input, ctx);

describe('start_preview', () => {
  it('mints with the sandbox key and returns exactly what tunnel_connect needs', async () => {
    const out = await start({ public_key: `${KEY}\n`, block_id: 'other-app' });

    expect(deps.startDevTunnel).toHaveBeenCalledWith({ blockId: 'other-app', sshPublicKey: KEY });
    expect(out).toEqual({
      host: STARTED.host,
      ssh_host_public_key: STARTED.sshHostPublicKey,
      next_step: expect.stringContaining('sandbox__tunnel_connect'),
    });
    expect(session).toEqual({ blockId: 'other-app', sessionId: 'bki_01', host: STARTED.host });
  });

  it("falls back to the sandbox's app key as the blockId", async () => {
    await start({ public_key: KEY });
    expect(deps.startDevTunnel).toHaveBeenCalledWith({ blockId: 'my-app', sshPublicKey: KEY });
  });

  it('refuses a block id the dev tunnel would refuse, before minting', async () => {
    deps.defaultBlockId = () => 'My App';
    await expect(start({ public_key: KEY })).rejects.toThrow(/block_id/);
    await expect(start({ public_key: KEY, block_id: 'ab' })).rejects.toThrow(/block_id/);
    expect(deps.startDevTunnel).not.toHaveBeenCalled();
  });

  it('refuses a multi-line key before minting', async () => {
    await expect(start({ public_key: `${KEY}\nssh-rsa AAAA second` })).rejects.toThrow(
      /single-line/
    );
    expect(deps.startDevTunnel).not.toHaveBeenCalled();
  });

  it('turns FORBIDDEN into a plain "not enabled" message for the assistant', async () => {
    deps.startDevTunnel.mockRejectedValue(trpcError('FORBIDDEN', 'Dev tunnels are not available'));
    await expect(start({ public_key: KEY })).rejects.toThrow(PREVIEW_NOT_ENABLED);
    expect(session).toBeNull();
  });

  it('names the cause for NOT_FOUND and the rate limit', async () => {
    deps.startDevTunnel.mockRejectedValueOnce(trpcError('NOT_FOUND'));
    await expect(start({ public_key: KEY })).rejects.toThrow(/belongs to another app/);
    deps.startDevTunnel.mockRejectedValueOnce(trpcError('TOO_MANY_REQUESTS'));
    await expect(start({ public_key: KEY })).rejects.toThrow(/last hour/);
  });

  it('never calls the server without the flag', async () => {
    deps.canPreview = false;
    await expect(start({ public_key: KEY })).rejects.toThrow(PREVIEW_NOT_ENABLED);
    expect(deps.startDevTunnel).not.toHaveBeenCalled();
  });

  it('fails closed and tears the mint down when the server sends no host key', async () => {
    deps.startDevTunnel.mockResolvedValue({ ...STARTED, sshHostPublicKey: '' });
    await expect(start({ public_key: KEY })).rejects.toThrow(/not configured/);
    expect(deps.stopDevTunnel).toHaveBeenCalledWith({ sessionId: 'bki_01' });
    expect(session).toBeNull();
  });

  it("stops the previous app's tunnel when the preview moves to another app", async () => {
    session = { blockId: 'old-app', sessionId: 'bki_old', host: 'dev-ffffffffffffffff.civit.ai' };
    await start({ public_key: KEY, block_id: 'my-app' });
    expect(deps.stopDevTunnel).toHaveBeenCalledWith({ sessionId: 'bki_old' });
  });

  it('does not stop the session it replaces for the same app (the server already did)', async () => {
    session = { blockId: 'my-app', sessionId: 'bki_old', host: 'dev-ffffffffffffffff.civit.ai' };
    await start({ public_key: KEY, block_id: 'my-app' });
    expect(deps.stopDevTunnel).not.toHaveBeenCalled();
    expect(session?.sessionId).toBe('bki_01');
  });

  it('still starts when stopping the previous app fails', async () => {
    session = { blockId: 'old-app', sessionId: 'bki_old', host: 'dev-ffffffffffffffff.civit.ai' };
    deps.stopDevTunnel.mockRejectedValueOnce(new Error('gone'));
    await expect(start({ public_key: KEY, block_id: 'my-app' })).resolves.toMatchObject({
      host: STARTED.host,
    });
    expect(session?.sessionId).toBe('bki_01');
  });

  it("forwards the manifest's scopes and auth, dropping values the server would refuse", async () => {
    await start({
      public_key: KEY,
      declared_scopes: ['ai:write:budgeted', '', 7, 'x'.repeat(65), 'user:read:self'],
      declared_auth: 'oauth',
    });
    expect(deps.startDevTunnel).toHaveBeenCalledWith({
      blockId: 'my-app',
      sshPublicKey: KEY,
      declaredScopes: ['ai:write:budgeted', 'user:read:self'],
      declaredAuth: 'oauth',
    });
  });

  it.each([
    ['block-token', 'block-token'],
    ['bogus', undefined],
  ])('forwards declared_auth %j as %j', async (given, sent) => {
    await start({ public_key: KEY, declared_auth: given });
    expect(deps.startDevTunnel.mock.calls[0][0].declaredAuth).toBe(sent);
  });

  it('caps declared scopes at 32 and keeps a 64-character scope', async () => {
    const scopes = ['x'.repeat(64), ...Array.from({ length: 40 }, (_, i) => `scope-${i}`)];
    await start({ public_key: KEY, declared_scopes: scopes });
    const sent = deps.startDevTunnel.mock.calls[0][0].declaredScopes;
    expect(sent).toHaveLength(32);
    expect(sent[0]).toBe('x'.repeat(64));
  });

  it('turns BAD_REQUEST into a retry hint and anything else into a plain failure', async () => {
    deps.startDevTunnel.mockRejectedValueOnce(trpcError('BAD_REQUEST', 'invalid SSH public key'));
    await expect(start({ public_key: KEY })).rejects.toThrow(
      /invalid SSH public key.*sandbox__tunnel_key/
    );
    deps.startDevTunnel.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(start({ public_key: KEY })).rejects.toThrow(/could not start/);
  });
});

describe('start_preview when the sandbox changes mid-start', () => {
  it('stops the tunnel it started and records nothing for the new sandbox', async () => {
    deps.startDevTunnel.mockImplementation(async () => {
      sandboxName = 'sbx-bbbbbbbbbbbb'; // the user switched while the mint was in flight
      return STARTED;
    });
    await expect(start({ public_key: KEY })).rejects.toThrow(/sandbox changed/);
    expect(deps.stopDevTunnel).toHaveBeenCalledWith({ sessionId: STARTED.sessionId });
    expect(session).toBeNull();
  });

  it('CONTROL: an unchanged sandbox keeps its preview', async () => {
    await start({ public_key: KEY });
    expect(deps.stopDevTunnel).not.toHaveBeenCalled();
    expect(session?.sessionId).toBe(STARTED.sessionId);
  });
});

describe('stop_preview', () => {
  const stop = () => createPreviewTools(deps).stop_preview.execute({}, ctx);

  it('stops the running session and clears it', async () => {
    session = { blockId: 'my-app', sessionId: 'bki_01', host: STARTED.host };
    expect(await stop()).toMatchObject({ stopped: true });
    expect(deps.stopDevTunnel).toHaveBeenCalledWith({ sessionId: 'bki_01' });
    expect(session).toBeNull();
  });

  it('keeps the session when stopping fails, so a retry can stop it', async () => {
    session = { blockId: 'my-app', sessionId: 'bki_01', host: STARTED.host };
    deps.stopDevTunnel.mockRejectedValueOnce(new Error('network'));
    await expect(stop()).rejects.toThrow('network');
    expect(session).not.toBeNull();
  });

  it('is a no-op without a session', async () => {
    expect(await stop()).toEqual({ stopped: false });
    expect(deps.stopDevTunnel).not.toHaveBeenCalled();
  });
});

describe('a preview the server runner started', () => {
  const HOST = 'dev-0123456789abcdef.civit.ai';
  const reported = (name: string, output: unknown, isError = false) => ({
    name,
    input: {},
    output,
    isError,
  });

  it('is shown from the block and host the runner reported', () => {
    expect(
      runnerPreviewAction(
        reported('start_preview', { shown: true, blockId: 'my-app', host: HOST, next_step: 'x' })
      )
    ).toEqual({ show: { blockId: 'my-app', host: HOST } });
  });

  it('carries no tunnel id onward, whatever else the result holds', () => {
    const action = runnerPreviewAction(
      reported('start_preview', { blockId: 'my-app', host: HOST, sessionId: 'bki_TEST_ONLY' })
    );
    expect(JSON.stringify(action)).not.toContain('bki_TEST_ONLY');
  });

  it('is hidden on the runner’s stop_preview', () => {
    expect(runnerPreviewAction(reported('stop_preview', { stopped: true }))).toEqual({
      hide: true,
    });
  });

  it.each([
    ['a failed start', reported('start_preview', { error: 'no' }, true)],
    ['a failed stop', reported('stop_preview', { error: 'no' }, true)],
    ['no block id', reported('start_preview', { host: HOST })],
    ['a block id that is not one', reported('start_preview', { blockId: 'My App', host: HOST })],
    ['no host', reported('start_preview', { blockId: 'my-app' })],
    ['a host that is not one', reported('start_preview', { blockId: 'my-app', host: 'a b/c' })],
    ['a URL for a host', reported('start_preview', { blockId: 'my-app', host: `https://${HOST}` })],
    ['another tool', reported('sandbox__run_command', { blockId: 'my-app', host: HOST })],
  ])('does nothing for %s', (_, result) => {
    expect(runnerPreviewAction(result)).toBeNull();
  });

  it('stop_preview on the page never stops a tunnel it has no id for', async () => {
    session = { blockId: 'my-app', sessionId: null, host: HOST };
    expect(await createPreviewTools(deps).stop_preview.execute({}, ctx)).toEqual({
      stopped: false,
    });
    expect(deps.stopDevTunnel).not.toHaveBeenCalled();
  });
});
