// The auto-label shapes both Studio surfaces share. Labelling itself runs on the main app's
// system-paid path, never on the user's own orchestrator client, which would charge them: the shell
// through lib/server/main-app-autolabel.ts, the embed through its host.

export type AutoLabelMode = 'tag' | 'caption';
export interface AutoLabelItem {
  /** The uploaded blob's media URL. */
  mediaUrl: string;
  /** The caller's key for this item, unique within the run, echoed back on each result. */
  key: string;
}

export interface AutoLabelResult {
  key: string;
  status: 'succeeded' | 'failed' | 'pending';
  tags?: string[];
  caption?: string;
  /** Why the item failed (shown on the tile). */
  error?: string;
  /** Refused before it ran (no worker free): sending it again later may succeed. */
  retryable?: boolean;
}
