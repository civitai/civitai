import { css, html, type TemplateResult } from 'lit';
import type { PlannerActions } from './props';

export interface BulkBarProps {
  selectedIds: ReadonlySet<number>;
  selectableIds: number[];
  actions: PlannerActions;
}

export function renderBulkBar({
  selectedIds,
  selectableIds,
  actions,
}: BulkBarProps): TemplateResult {
  const count = selectedIds.size;
  const allSelected = selectableIds.every((id) => selectedIds.has(id));
  return html`<div class="bulk-bar">
    <strong>${count} selected</strong>
    <civitai-button
      size="sm"
      variant="subtle"
      ?disabled=${allSelected}
      @click=${() => actions.selectAll()}
      >Select all ${selectableIds.length}</civitai-button
    >
    <civitai-button
      size="sm"
      variant="outline"
      ?disabled=${count === 0}
      @click=${() => actions.openShiftDialog()}
      >Shift ±…</civitai-button
    >
    <civitai-button
      size="sm"
      variant="outline"
      ?disabled=${count === 0}
      @click=${() => actions.openMoveDialog()}
      >Move to day…</civitai-button
    >
    <civitai-button
      size="sm"
      variant="outline"
      color="error"
      ?disabled=${count === 0}
      @click=${() => actions.unschedule([...selectedIds])}
      >Unschedule to drafts</civitai-button
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
