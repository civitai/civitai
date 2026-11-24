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

// allow-same-origin is safe only because the frame is on a non-civitai registrable domain
// (resolveFeaturePageEmbed).
export const FEATURE_PAGE_SANDBOX = [...MINIMAL_SANDBOX, 'allow-same-origin'].join(' ');
const OPAQUE = effectiveSandboxIsOpaque(FEATURE_PAGE_SANDBOX);

/** The answer each frame request gets. */
const RESULT_OF: Record<string, string> = {
  [Msg.Vote]: Msg.VoteResult,
  [Msg.Mine]: Msg.MineResult,
  [Msg.Comment]: Msg.CommentResult,
  [Msg.CommentEdit]: Msg.CommentResult,
  [Msg.CommentRetract]: Msg.CommentResult,
  [Msg.CommentReport]: Msg.CommentResult,
};

type MineVotes = Record<string, 0 | 1>;
type CommentReply = { comment: unknown };

export type FeaturePageHostDeps = {
  embedOrigin: string;
  feature: string;
  frameWindow: () => Window | null | undefined;
  theme: 'light' | 'dark';
  signedIn: boolean;
  openLogin: () => void;
  /** Whether the viewer sees profanity masked (their blur setting), sent in fp-init. */
  maskProfanity: boolean;
  /** The viewer's featurePagesDiscussion flag: the frame offers comments only when it is on. */
  discussion: boolean;
  vote: (input: { request: unknown; value: unknown }) => Promise<{ votes: number }>;
  mine: (input: { requests: unknown }) => Promise<{ votes: MineVotes }>;
  comment: (input: {
    requestId: string;
    subject: unknown;
    parent: unknown;
    text: unknown;
  }) => Promise<CommentReply>;
  editComment: (input: {
    requestId: string;
    comment: unknown;
    text: unknown;
  }) => Promise<CommentReply>;
  retractComment: (input: { requestId: string; comment: unknown }) => Promise<unknown>;
  reportComment: (input: {
    comment: unknown;
    reason: unknown;
    details: unknown;
  }) => Promise<unknown>;
  navigate: (req: NavigateRequest) => void;
};

export function frameErrorFor(error: unknown): FeaturePageFrameError {
  switch (extractTrpcErrorCode(error)) {
    case 'UNAUTHORIZED':
      return 'sign_in';
    case 'UNPROCESSABLE_CONTENT':
      return 'blocked';
    case 'FORBIDDEN':
    case 'BAD_REQUEST':
    case 'NOT_FOUND':
    case 'PRECONDITION_FAILED':
      return 'refused';
    default:
      return 'try_again';
  }
}

// fp-ready can arrive before the listener attaches (the iframe is server-rendered), so the host
// also sends fp-init unasked.
export function createFeaturePageHost(deps: FeaturePageHostDeps) {
  const targetOrigin = resolveOutboundTargetOrigin(deps.embedOrigin, OPAQUE);

  const post = (type: string, payload: unknown) => {
    const frame = deps.frameWindow();
    if (frame && targetOrigin) frame.postMessage({ type, payload }, targetOrigin);
  };

  // No fp-* request is answered before the frame has had fp-init, which tells it what it may ask.
  let initialised = false;
  const sendInit = () => {
    const frame = deps.frameWindow();
    if (!frame || !targetOrigin) return;
    post(Msg.Init, {
      theme: deps.theme,
      feature: deps.feature,
      capabilities: { comments: deps.discussion, edit: deps.discussion },
      maskProfanity: deps.maskProfanity,
    });
    initialised = true;
  };

  const answer = <T>(type: string, requestId: string, work: () => Promise<T>) => {
    work().then(
      (result) => post(type, { requestId, ok: true, ...result }),
      (error) => post(type, { requestId, ok: false, error: frameErrorFor(error) })
    );
  };

  const onMessage = (event: Pick<MessageEvent, 'origin' | 'source' | 'data'>) => {
    const frame = deps.frameWindow();
    if (!frame || event.source !== frame) return;
    if (!isInboundOriginAccepted(event.origin, deps.embedOrigin, OPAQUE)) return;
    const data = event.data as { type?: unknown; payload?: unknown } | null;
    if (!data || typeof data !== 'object') return;

    if (data.type === Msg.Ready) {
      sendInit();
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
    if (!initialised) {
      const resultType =
        typeof data.type === 'string' && Object.hasOwn(RESULT_OF, data.type)
          ? RESULT_OF[data.type]
          : undefined;
      if (resultType) post(resultType, { requestId, ok: false, error: 'try_again' });
      return;
    }

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
      return;
    }

    const commentWork: Record<string, (() => Promise<unknown>) | undefined> = {
      [Msg.Comment]: () =>
        deps.comment({
          requestId,
          subject: payload.subject,
          parent: payload.parent,
          text: payload.text,
        }),
      [Msg.CommentEdit]: () =>
        deps.editComment({ requestId, comment: payload.comment, text: payload.text }),
      [Msg.CommentRetract]: () => deps.retractComment({ requestId, comment: payload.comment }),
      [Msg.CommentReport]: () =>
        deps.reportComment({
          comment: payload.comment,
          reason: payload.reason,
          details: payload.details,
        }),
    };
    const work =
      typeof data.type === 'string' && Object.hasOwn(commentWork, data.type)
        ? commentWork[data.type]
        : undefined;
    if (!work) return;
    if (!deps.signedIn) {
      deps.openLogin();
      post(Msg.CommentResult, { requestId, ok: false, error: 'sign_in' });
      return;
    }
    answer(Msg.CommentResult, requestId, work as () => Promise<Record<string, unknown>>);
  };

  return { onMessage, sendInit };
}
