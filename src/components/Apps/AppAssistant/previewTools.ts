import type { ChatTool } from '@civitai/components-chat/civitai-chat';
import {
  PREVIEW_NOT_ENABLED,
  START_PREVIEW,
  STOP_PREVIEW,
  previewRefusal,
  runnerPreviewOf,
  type ShownPreview,
} from '@civitai/app-assistant';
import { isAppBlockId } from '~/components/Apps/AppAssistant/appKey';

export { PREVIEW_NOT_ENABLED, START_PREVIEW, STOP_PREVIEW, runnerPreviewOf };

export interface PreviewSession {
  blockId: string;
  /**
   * The tunnel's id when this page started it (`blocks.startDevTunnel`); `null` when the server
   * runner did, which never tells the page its id: the page then shows it and never stops it.
   */
  sessionId: string | null;
  host: string;
  /** Counts the runner's starts, so each one fetches a fresh frame even on the same host. */
  view?: number;
}

/** The parts of `blocks.startDevTunnel`'s result the preview uses. */
export interface StartedDevTunnel {
  sessionId: string;
  host: string;
  sshHostPublicKey: string;
}

export interface PreviewToolDeps {
  /** The account may open dev tunnels (author capability + dev-tunnel flag). */
  canPreview: boolean;
  /** The open sandbox's name; a preview started for one must not land on another. */
  currentSandbox: () => string | null;
  /** Used when the assistant passes no `block_id`. */
  defaultBlockId: () => string | null;
  startDevTunnel: (input: {
    blockId: string;
    sshPublicKey: string;
    declaredScopes?: string[];
    declaredAuth?: 'block-token' | 'oauth';
  }) => Promise<StartedDevTunnel>;
  stopDevTunnel: (input: { sessionId: string }) => Promise<unknown>;
  getSession: () => PreviewSession | null;
  setSession: (session: PreviewSession | null) => void;
}

/**
 * What the page does with a finished call the server runner reports (`tool-reported`): show the
 * preview its `start_preview` started (the block and host only: the runner never sends the tunnel's
 * id), hide it on its `stop_preview`, or nothing.
 */
export function runnerPreviewAction(result: {
  name: string;
  output: unknown;
  isError: boolean;
}): { show: ShownPreview } | { hide: true } | null {
  if (result.isError) return null;
  if (result.name === START_PREVIEW) {
    const show = runnerPreviewOf(result.output);
    return show ? { show } : null;
  }
  return result.name === STOP_PREVIEW ? { hide: true } : null;
}

/** What the assistant is told when `startDevTunnel` refuses, by tRPC error code. */
export function previewErrorMessage(error: unknown): string {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  // The words the server runner's start_preview uses for the same refusals (one place for both).
  const shared = previewRefusal(code);
  if (shared) return shared;
  switch (code) {
    case 'BAD_REQUEST':
      return `The preview could not start: ${
        (error as Error).message
      }. Run sandbox__tunnel_key again and retry with its publicKey.`;
    default:
      return 'The preview could not start. Tell the user it failed and try again later.';
  }
}

export function createPreviewTools(deps: PreviewToolDeps): Record<string, ChatTool> {
  const start_preview: ChatTool = {
    description:
      'Step 2 of 3 of the live preview: after sandbox__tunnel_key, authorize its public key for this app. ' +
      'Returns host and ssh_host_public_key; pass both to sandbox__tunnel_connect.',
    activity: 'Starting the preview…',
    inputSchema: {
      properties: {
        public_key: { type: 'string', description: 'The publicKey sandbox__tunnel_key returned.' },
        block_id: {
          type: 'string',
          description:
            "The app's blockId from block.manifest.json: 3-40 characters, lowercase letters, digits and dashes, starting with a letter.",
        },
        declared_scopes: {
          type: 'array',
          items: { type: 'string' },
          description:
            "The scopes in block.manifest.json. Without them the preview runs read-only; spending scopes also depend on the user's account.",
        },
        declared_auth: {
          type: 'string',
          enum: ['block-token', 'oauth'],
          description: "The manifest's auth, if it declares one.",
        },
      },
      required: ['public_key'],
    },
    async execute(input) {
      if (!deps.canPreview) throw new Error(PREVIEW_NOT_ENABLED);
      const publicKey = input.public_key;
      if (typeof publicKey !== 'string' || !publicKey.trim() || /[\r\n]/.test(publicKey.trim()))
        throw new Error('public_key must be the single-line publicKey from sandbox__tunnel_key.');
      const blockId = typeof input.block_id === 'string' ? input.block_id : deps.defaultBlockId();
      if (!blockId || !isAppBlockId(blockId))
        throw new Error(
          'Pass block_id: 3-40 characters, lowercase letters, digits and dashes, starting with a letter.'
        );

      const declaredScopes = Array.isArray(input.declared_scopes)
        ? input.declared_scopes
            // The bounds `blocks.startDevTunnel`'s input enforces.
            .filter((s): s is string => typeof s === 'string' && s.length >= 1 && s.length <= 64)
            .slice(0, 32)
        : undefined;
      const declaredAuth =
        input.declared_auth === 'oauth' || input.declared_auth === 'block-token'
          ? input.declared_auth
          : undefined;

      const sandbox = deps.currentSandbox();
      let started: StartedDevTunnel;
      try {
        started = await deps.startDevTunnel({
          blockId,
          sshPublicKey: publicKey.trim(),
          ...(declaredScopes ? { declaredScopes } : {}),
          ...(declaredAuth ? { declaredAuth } : {}),
        });
      } catch (error) {
        throw new Error(previewErrorMessage(error));
      }
      // No host key means the sandbox cannot pin it, so it must not connect.
      if (!started.sshHostPublicKey) {
        await deps.stopDevTunnel({ sessionId: started.sessionId }).catch(() => undefined);
        throw new Error('The preview service is not configured. Tell the user; do not retry.');
      }

      if (deps.currentSandbox() !== sandbox) {
        await deps.stopDevTunnel({ sessionId: started.sessionId }).catch(() => undefined);
        throw new Error(
          'The sandbox changed while the preview was starting. Start the preview again in the open sandbox.'
        );
      }

      const previous = deps.getSession();
      if (previous?.sessionId && previous.blockId !== blockId)
        await deps.stopDevTunnel({ sessionId: previous.sessionId }).catch(() => undefined);
      deps.setSession({ blockId, sessionId: started.sessionId, host: started.host });
      return {
        host: started.host,
        ssh_host_public_key: started.sshHostPublicKey,
        next_step: 'Call sandbox__tunnel_connect with host and ssh_host_public_key.',
      };
    },
  };

  const stop_preview: ChatTool = {
    description: 'Stop the live preview. Then call sandbox__tunnel_disconnect to close the tunnel.',
    activity: 'Stopping the preview…',
    inputSchema: { properties: {} },
    async execute() {
      const session = deps.getSession();
      if (!session?.sessionId) return { stopped: false };
      await deps.stopDevTunnel({ sessionId: session.sessionId });
      deps.setSession(null);
      return { stopped: true, next_step: 'Call sandbox__tunnel_disconnect.' };
    },
  };

  return { start_preview, stop_preview };
}
