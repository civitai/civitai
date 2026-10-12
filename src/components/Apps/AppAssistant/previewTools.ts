import type { ChatTool } from '@civitai/components-chat/civitai-chat';
import { isAppBlockId } from '~/components/Apps/AppAssistant/appKey';

export interface PreviewSession {
  blockId: string;
  sessionId: string;
  host: string;
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
  /** Used when the assistant passes no `block_id`. */
  defaultBlockId: () => string | null;
  startDevTunnel: (input: { blockId: string; sshPublicKey: string }) => Promise<StartedDevTunnel>;
  stopDevTunnel: (input: { sessionId: string }) => Promise<unknown>;
  getSession: () => PreviewSession | null;
  setSession: (session: PreviewSession | null) => void;
}

export const PREVIEW_NOT_ENABLED =
  'Live preview is not enabled for this account. Tell the user, and keep building without it.';

/** What the assistant is told when `startDevTunnel` refuses, by tRPC error code. */
export function previewErrorMessage(error: unknown): string {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  switch (code) {
    case 'FORBIDDEN':
      return PREVIEW_NOT_ENABLED;
    case 'NOT_FOUND':
      return 'That block_id belongs to another app. Choose a different blockId, update block.manifest.json, and try again.';
    case 'TOO_MANY_REQUESTS':
      return 'Too many previews were started in the last hour. Tell the user to wait a few minutes.';
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

      let started: StartedDevTunnel;
      try {
        started = await deps.startDevTunnel({ blockId, sshPublicKey: publicKey.trim() });
      } catch (error) {
        throw new Error(previewErrorMessage(error));
      }
      // Without the server's host key sandbox__tunnel_connect cannot pin it and must not connect.
      if (!started.sshHostPublicKey) {
        await deps.stopDevTunnel({ sessionId: started.sessionId }).catch(() => undefined);
        throw new Error('The preview service is not configured. Tell the user; do not retry.');
      }

      const previous = deps.getSession();
      if (previous && previous.blockId !== blockId)
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
      if (!session) return { stopped: false };
      await deps.stopDevTunnel({ sessionId: session.sessionId });
      deps.setSession(null);
      return { stopped: true, next_step: 'Call sandbox__tunnel_disconnect.' };
    },
  };

  return { start_preview, stop_preview };
}
