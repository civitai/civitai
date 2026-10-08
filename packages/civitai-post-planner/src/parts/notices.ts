import { css, html, type TemplateResult } from 'lit';
import type { PlannerPost, PlannerView } from '../host.js';

export function renderNotice(message: string): TemplateResult {
  return html`<div class="notice">${message}</div>`;
}

export function renderUndo({ until, onUndo }: { until: number; onUndo(): void }): TemplateResult {
  if (until <= Date.now()) return html``;
  return html`<div class="notice">
    <span>Moved. </span>
    <civitai-button variant="subtle" size="sm" @click=${onUndo}>Undo</civitai-button>
  </div>`;
}

export interface TruncatedNoticeProps {
  view: PlannerView;
  posts: PlannerPost[];
  hasModelFilter: boolean;
}

export function renderTruncatedNotice({
  view,
  posts,
  hasModelFilter,
}: TruncatedNoticeProps): TemplateResult {
  const last = posts.length ? new Date(posts[posts.length - 1].publishedAt) : null;
  const lastLabel = last
    ? last.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : null;
  const narrower = view === 'month' ? 'Week or Day' : view === 'week' ? 'Day' : 'a shorter range';
  return html`<div class="notice">
    <span>
      This range holds more than ${posts.length} posts;
      ${lastLabel ? `days after ${lastLabel} are incomplete` : 'the end of it is cut off'}. Switch
      to ${narrower}${hasModelFilter ? ' or filter by model' : ''} to see everything.
    </span>
  </div>`;
}

export const noticeStyles = css`
  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface-2);
    border: 1px solid var(--civitai-color-border);
  }
`;
