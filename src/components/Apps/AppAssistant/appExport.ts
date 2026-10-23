import type { Sandbox, SandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';

/** What the zip leaves out, as the gateway builds it (`appExportPath`). */
export const EXPORT_NOTE =
  'It has the app’s own files only: no node_modules, build output, caches, .git or .env files.';
export const EXPORT_TOO_LARGE = 'This app is too large to export.';
export const EXPORT_FAILED = 'The app could not be exported. Try again in a moment.';

export const exportFileName = (app: string) => `${app}.zip`;

export class AppExportError extends Error {
  constructor(message: string, readonly kind: 'too_large' | 'failed', options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppExportError';
  }
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Asks for the sandbox until it runs; throws once `timeoutMs` passed without it running. */
export async function waitUntilRunning(
  client: Pick<SandboxClient, 'get'>,
  name: string,
  { pollMs = 2_000, timeoutMs = 120_000 }: { pollMs?: number; timeoutMs?: number } = {}
): Promise<Sandbox> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const sandbox = await client.get(name);
    if (sandbox.state === 'running') return sandbox;
    if (Date.now() >= until) throw new Error('The app did not start in time.');
    await sleepFor(pollMs);
  }
}

/**
 * The app as a zip. A paused app is started first (`start`, which may pause the one that runs) and
 * waited for; a 409 (the sandbox is not running) starts it once more and asks again. A 413 is
 * `too_large`; anything else is `failed`.
 */
export async function exportAppZip({
  client,
  sandbox,
  start,
  pollMs,
  timeoutMs,
}: {
  client: Pick<SandboxClient, 'get' | 'exportApp'>;
  sandbox: Sandbox;
  start: (sandbox: Sandbox) => Promise<Sandbox>;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<Blob> {
  const startAndWait = async (target: Sandbox) => {
    const started = await start(target);
    return waitUntilRunning(client, started.name, { pollMs, timeoutMs });
  };
  try {
    let target = sandbox.state === 'running' ? sandbox : await startAndWait(sandbox);
    let restarted = false;
    for (;;) {
      try {
        return await client.exportApp(target.name, target.app);
      } catch (error) {
        if (!(error instanceof SandboxApiError) || error.status !== 409 || restarted) throw error;
        restarted = true;
        target = await startAndWait(target);
      }
    }
  } catch (error) {
    if (error instanceof SandboxApiError && error.status === 413)
      throw new AppExportError(EXPORT_TOO_LARGE, 'too_large', { cause: error });
    throw new AppExportError(EXPORT_FAILED, 'failed', { cause: error });
  }
}

/** Hands `blob` to the browser to save as `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // After the click has handed the file over.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }
}
