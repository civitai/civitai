import { css, html, type TemplateResult } from 'lit';
import type { PlannerActions } from './props.js';

export interface BulkBarProps {
  selectedIds: ReadonlySet<number>;
  actions: PlannerActions;
}

export function renderBulkBar({ selectedIds, actions }: BulkBarProps): TemplateResult {
  const count = selectedIds.size;
  return html`<div class="bulk-bar">
    <strong>${count} selected</strong>
    <civitai-button
      size="sm"
      variant="outline"
      ?disabled=${count === 0}
      @click=${() => actions.shiftSelected(-1440)}
      >−1 day</civitai-button
    >
    <civitai-button
      size="sm"
      variant="outline"
      ?disabled=${count === 0}
      @click=${() => actions.shiftSelected(1440)}
      >+1 day</civitai-button
    >
    <civitai-button
      size="sm"
      variant="outline"
      ?disabled=${count === 0}
      @click=${() => actions.shiftSelected(7 * 1440)}
      >+1 week</civitai-button
    >
    <civitai-button
      size="sm"
      variant="outline"
      color="error"
      ?disabled=${count === 0}
      @click=${() => actions.unschedule([...selectedIds])}
      >Unschedule</civitai-button
    >
    <civitai-button size="sm" variant="subtle" @click=${() => actions.clearSelection()}
      >Clear</civitai-button
    >
    <span class="muted">Release posts move with their model and are skipped.</span>
  </div>`;
}

export const bulkBarStyles = css`
  .bulk-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface-2);
    border: 1px solid var(--civitai-color-border);
    position: sticky;
    bottom: 8px;
  }
`;
