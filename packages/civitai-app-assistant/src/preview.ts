import { isAppBlockId } from './app-key';

/** The live preview's tools, named the same on the page and the server runner so one prompt fits both. */
export const START_PREVIEW = 'start_preview';
export const STOP_PREVIEW = 'stop_preview';

export const PREVIEW_NOT_ENABLED =
  'Live preview is not enabled for this account. Tell the user, and keep building without it.';

/**
 * What the assistant is told when civitai refuses to start a preview, by the code it refuses with:
 * `blocks.startDevTunnel`'s tRPC code on the page, the same code in the body of the runner's
 * internal endpoint. `null` for a code with no words of its own.
 */
export function previewRefusal(code: unknown): string | null {
  switch (code) {
    case 'FORBIDDEN':
      return PREVIEW_NOT_ENABLED;
    case 'NOT_FOUND':
      return 'That block_id belongs to another app. Choose a different blockId, update block.manifest.json, and try again.';
    case 'TOO_MANY_REQUESTS':
      return 'Too many previews were started in the last hour. Tell the user to wait a few minutes.';
    default:
      return null;
  }
}

/** What the page shows of a preview the server runner started: never the tunnel's id. */
export interface ShownPreview {
  blockId: string;
  host: string;
}

/** A dev-tunnel host, as civitai names one: a DNS name, nothing else. */
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The preview a server runner's `start_preview` result shows (`{ blockId, host }`), or `null` when the
 * output is not one: the page reads only these two fields of it.
 */
export function runnerPreviewOf(output: unknown): ShownPreview | null {
  if (!output || typeof output !== 'object') return null;
  const { blockId, host } = output as { blockId?: unknown; host?: unknown };
  if (typeof blockId !== 'string' || !isAppBlockId(blockId)) return null;
  if (typeof host !== 'string' || !HOST.test(host)) return null;
  return { blockId, host };
}

/**
 * The conversation a preview grant names for the page's Restart preview on the server runner:
 * `preview:<app>`. civitai signs what the page asks for; the runner takes the grant only for that
 * app's restart, so one grant opens one app's preview.
 */
export function previewGrantConversation(app: string): string {
  return `preview:${app}`;
}
