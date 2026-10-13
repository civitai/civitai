import type { CivitaiNumberInput } from '@civitai/components/civitai-number-input';
import type { CivitaiSelect } from '@civitai/components/civitai-select';
import { css, html, nothing, type TemplateResult } from 'lit';
import {
  type MovePreview,
  type ShiftDraft,
  type ShiftUnit,
  shiftDeltaMinutes,
} from '../model/bulk';
import { previewLine } from '../model/messages';
import type { PlannerActions } from './props';

const UNITS: { value: ShiftUnit; label: string }[] = [
  { value: 'days', label: 'days' },
  { value: 'hours', label: 'hours' },
];

export interface ShiftDialogProps {
  draft: ShiftDraft;
  preview: MovePreview;
  busy: boolean;
  actions: PlannerActions;
}

export function renderShiftDialog({
  draft,
  preview,
  busy,
  actions,
}: ShiftDialogProps): TemplateResult {
  const delta = shiftDeltaMinutes(draft);
  const canApply = delta !== 0 && preview.moves.length > 0 && preview.issues.length === 0 && !busy;
  return html`<civitai-modal
    heading="Shift selected posts"
    .open=${true}
    @close=${() => actions.closeDialog()}
  >
    <div class="dialog-body">
      <div class="stepper" role="group" aria-label="Shift by">
        <civitai-button
          variant="outline"
          size="sm"
          aria-label="One less"
          @click=${() => actions.setShiftDraft({ amount: draft.amount - 1 })}
          >−</civitai-button
        >
        <civitai-number-input
          aria-label="Amount"
          step="1"
          .value=${String(draft.amount)}
          @change=${(e: Event) =>
            actions.setShiftDraft({
              amount: (e.target as CivitaiNumberInput).valueAsNumber ?? 0,
            })}
        ></civitai-number-input>
        <civitai-button
          variant="outline"
          size="sm"
          aria-label="One more"
          @click=${() => actions.setShiftDraft({ amount: draft.amount + 1 })}
          >+</civitai-button
        >
        <civitai-select
          aria-label="Unit"
          .data=${UNITS}
          .value=${draft.unit}
          @change=${(e: Event) =>
            actions.setShiftDraft({ unit: (e.target as CivitaiSelect).value as ShiftUnit })}
        ></civitai-select>
      </div>
      ${renderPreview(preview)}
      <div class="dialog-actions">
        <civitai-button variant="subtle" @click=${() => actions.closeDialog()}
          >Cancel</civitai-button
        >
        <civitai-button
          variant="filled"
          ?disabled=${!canApply}
          ?loading=${busy}
          @click=${() => actions.applyShift()}
          >Apply</civitai-button
        >
      </div>
    </div>
  </civitai-modal>`;
}

export interface MoveDialogProps {
  day: string;
  today: string;
  preview: MovePreview;
  busy: boolean;
  actions: PlannerActions;
}

export function renderMoveDialog({
  day,
  today,
  preview,
  busy,
  actions,
}: MoveDialogProps): TemplateResult {
  const canApply = preview.moves.length > 0 && preview.issues.length === 0 && !busy;
  return html`<civitai-modal
    heading="Move to day"
    .open=${true}
    @close=${() => actions.closeDialog()}
  >
    <div class="dialog-body">
      <label class="field"
        >Day<input
          type="date"
          .value=${day}
          min=${today}
          @change=${(e: Event) => actions.setMoveDay((e.target as HTMLInputElement).value)}
      /></label>
      <div class="muted">Each post keeps its time of day.</div>
      ${renderPreview(preview)}
      <div class="dialog-actions">
        <civitai-button variant="subtle" @click=${() => actions.closeDialog()}
          >Cancel</civitai-button
        >
        <civitai-button
          variant="filled"
          ?disabled=${!canApply}
          ?loading=${busy}
          @click=${() => actions.applyMoveToDay()}
          >Move</civitai-button
        >
      </div>
    </div>
  </civitai-modal>`;
}

function renderPreview(preview: MovePreview): TemplateResult {
  return html`<div class="preview" aria-live="polite">${previewLine(preview)}</div>
    ${preview.issues.length
      ? html`<civitai-alert color="error">${preview.issues.join(' ')}</civitai-alert>`
      : nothing}`;
}

export const shiftDialogStyles = css`
  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(360px, 80vw);
  }
  .stepper {
    display: grid;
    grid-template-columns: auto 80px auto minmax(0, 1fr);
    align-items: center;
    gap: 8px;
  }
  .preview {
    font-weight: 600;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--civitai-color-text-dimmed);
  }
  .field input {
    font: inherit;
    color: var(--civitai-color-text);
    background: var(--civitai-color-surface-2);
    border: 1px solid var(--civitai-color-border);
    border-radius: var(--civitai-radius);
    padding: 6px 8px;
  }
`;
