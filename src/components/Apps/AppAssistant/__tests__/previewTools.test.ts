import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewSession, PreviewToolDeps } from '~/components/Apps/AppAssistant/previewTools';
import {
  PREVIEW_NOT_ENABLED,
  createPreviewTools,
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
let deps: PreviewToolDeps & {
  startDevTunnel: ReturnType<typeof vi.fn>;
  stopDevTunnel: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  session = null;
  deps = {
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
});

describe('stop_preview', () => {
  const stop = () => createPreviewTools(deps).stop_preview.execute({}, ctx);

  it('stops the running session and clears it', async () => {
    session = { blockId: 'my-app', sessionId: 'bki_01', host: STARTED.host };
    expect(await stop()).toMatchObject({ stopped: true });
    expect(deps.stopDevTunnel).toHaveBeenCalledWith({ sessionId: 'bki_01' });
    expect(session).toBeNull();
  });

  it('is a no-op without a session', async () => {
    expect(await stop()).toEqual({ stopped: false });
    expect(deps.stopDevTunnel).not.toHaveBeenCalled();
  });
});
