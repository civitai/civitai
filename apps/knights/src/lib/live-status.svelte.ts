import { getContext, setContext } from 'svelte';
import type { PlayerStatus } from './server/player-status';

/** A status fresher than the page's data, from a stats signal: /play writes it, the header reads it. */
export type LiveStatus = { current: PlayerStatus | null };

const KEY = Symbol('live-status');

/** Created by the root layout, so each request on the server and each tab in the browser has its own. */
export function provideLiveStatus(): LiveStatus {
  const live = $state<LiveStatus>({ current: null });
  return setContext(KEY, live);
}

export const liveStatus = () => getContext<LiveStatus>(KEY);
