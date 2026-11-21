import { extractTrpcErrorCode } from '~/components/AppBlocks/blockImageScanLogic';
import type { NavigateRequest } from '~/components/AppBlocks/pageBlockHostLogic';
import { resolveNavigateRequest } from '~/components/AppBlocks/pageBlockHostLogic';
import { effectiveSandboxIsOpaque, MINIMAL_SANDBOX } from '~/components/AppBlocks/sandbox';
import {
  isInboundOriginAccepted,
  resolveOutboundTargetOrigin,
} from '~/components/AppBlocks/usePostMessage';
import type { FeaturePageFrameError } from '~/shared/constants/feature-pages.constants';
import { FeaturePageFrameMessage as Msg } from '~/shared/constants/feature-pages.constants';

// The frame is served from a non-civitai registrable domain, so it may keep its real origin, and
// every message is pinned to that origin both ways.
export const FEATURE_PAGE_SANDBOX = [...MINIMAL_SANDBOX, 'allow-same-origin'].join(' ');
const OPAQUE = effectiveSandboxIsOpaque(FEATURE_PAGE_SANDBOX);

type MineVotes = Record<string, 0 | 1>;

export type FeaturePageHostDeps = {
  embedOrigin: string;
  feature: string;
  frameWindow: () => Window | null | undefined;
  theme: 'light' | 'dark';
  signedIn: boolean;
  openLogin: () => void;
  vote: (input: { request: unknown; value: unknown }) => Promise<{ votes: number }>;
  mine: (input: { requests: unknown }) => Promise<{ votes: MineVotes }>;
  navigate: (req: NavigateRequest) => void;
};

export function frameErrorFor(error: unknown): FeaturePageFrameError {
  switch (extractTrpcErrorCode(error)) {
    case 'UNAUTHORIZED':
      return 'sign_in';
    case 'FORBIDDEN':
    case 'BAD_REQUEST':
    case 'NOT_FOUND':
    case 'PRECONDITION_FAILED':
      return 'refused';
    default:
      return 'try_again';
  }
}

/** The `message` listener for one feature-page frame. */
export function createFeaturePageMessageHandler(deps: FeaturePageHostDeps) {
  const targetOrigin = resolveOutboundTargetOrigin(deps.embedOrigin, OPAQUE);

  const post = (type: string, payload: unknown) => {
    const frame = deps.frameWindow();
    if (frame && targetOrigin) frame.postMessage({ type, payload }, targetOrigin);
  };

  const answer = <T>(type: string, requestId: string, work: () => Promise<T>) => {
    work().then(
      (result) => post(type, { requestId, ok: true, ...result }),
      (error) => post(type, { requestId, ok: false, error: frameErrorFor(error) })
    );
  };

  return (event: Pick<MessageEvent, 'origin' | 'source' | 'data'>) => {
    const frame = deps.frameWindow();
    if (!frame || event.source !== frame) return;
    if (!isInboundOriginAccepted(event.origin, deps.embedOrigin, OPAQUE)) return;
    const data = event.data as { type?: unknown; payload?: unknown } | null;
    if (!data || typeof data !== 'object') return;

    if (data.type === Msg.Ready) {
      post(Msg.Init, { theme: deps.theme, feature: deps.feature });
      return;
    }
    if (data.type === Msg.Navigate) {
      const req = resolveNavigateRequest(data.payload, {
        base: null,
        slug: '',
        siteNavigation: true,
      });
      if (req) deps.navigate(req);
      return;
    }

    const payload = (data.payload ?? {}) as Record<string, unknown>;
    const requestId = payload.requestId;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 128) return;

    if (data.type === Msg.Vote) {
      if (!deps.signedIn) {
        // Synchronous, so the click's user activation still allows the login popup.
        deps.openLogin();
        post(Msg.VoteResult, { requestId, ok: false, error: 'sign_in' });
        return;
      }
      answer(Msg.VoteResult, requestId, () =>
        deps.vote({ request: payload.request, value: payload.value })
      );
      return;
    }
    if (data.type === Msg.Mine) {
      if (!deps.signedIn) {
        post(Msg.MineResult, { requestId, ok: false, error: 'sign_in' });
        return;
      }
      answer(Msg.MineResult, requestId, () => deps.mine({ requests: payload.requests }));
    }
  };
}
