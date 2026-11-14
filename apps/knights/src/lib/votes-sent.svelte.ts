import { getContext, setContext } from 'svelte';

/** Votes posted in the background that the page's data does not hold yet; /play writes it, the header reads it. */
export type VotesSent = { count: number };

const KEY = Symbol('votes-sent');

/** Created by the root layout, so each request on the server and each tab in the browser has its own count. */
export function provideVotesSent(): VotesSent {
  const sent = $state<VotesSent>({ count: 0 });
  return setContext(KEY, sent);
}

export const votesSent = () => getContext<VotesSent>(KEY);
