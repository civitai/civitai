import { grantForConversation, type RunGrants } from './grants';
import { MintRefusedError, type TokenMinter, type TokenSource } from './minter';

/**
 * Where the runner's providers get tokens: each request finds the grant it acts with (the run's
 * own, or the one for the conversation) and trades it at civitai, inside the provider's own fetch.
 * Nothing here hands a token or a grant to a workflow, a step or the journal.
 */
export class RunCredentials {
  readonly #grants: Pick<RunGrants, 'forRun' | 'forConversation'>;
  readonly #minter: Pick<TokenMinter, 'token'>;

  constructor(
    grants: Pick<RunGrants, 'forRun' | 'forConversation'>,
    minter: Pick<TokenMinter, 'token'>
  ) {
    this.#grants = grants;
    this.#minter = minter;
  }

  /** Tokens for one run's model calls, from that run's grant. */
  forRun(runId: string): TokenSource {
    return this.#source(() => this.#grants.forRun(runId));
  }

  /** Tokens for one user's conversation: the request's own grant, else a live run's for it. */
  forConversation(userId: string, conversationId: string): TokenSource {
    return this.#source(() => grantForConversation(this.#grants, userId, conversationId));
  }

  /**
   * Tokens from a grant one request carried (a Restart preview's), for that request only: the grant
   * is held by the returned function and never stored.
   */
  forGrant(grant: string): TokenSource {
    return this.#source(async () => grant);
  }

  #source(grant: () => Promise<string | null>): TokenSource {
    return async (purpose, options) => {
      const token = await grant();
      if (!token)
        throw new MintRefusedError(
          'invalid_grant',
          'This reply can no longer act for you. Send your message again.',
          401
        );
      return this.#minter.token(token, purpose, options);
    };
  }
}
