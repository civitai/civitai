import { css, html, nothing, type TemplateResult } from 'lit';
import type { PlannerPost } from '../host.js';
import { formatTime } from '../model/calendar.js';
import { thumb } from './media.js';
import type { PostContext } from './props.js';

export function renderRow(post: PlannerPost, context: PostContext): TemplateResult {
  const { host, selectMode, selectedIds, pending, actions } = context;
  const scheduled = context.isScheduled(post);
  const classes = [
    'row',
    post.release ? 'release' : '',
    scheduled ? '' : 'published',
    selectedIds.has(post.id) ? 'selected' : '',
  ].join(' ');
  const when = new Date(post.publishedAt);
  return html`<div
    class=${classes}
    role="button"
    tabindex="0"
    draggable=${scheduled && !selectMode && !pending.has(post.id) ? 'true' : 'false'}
    @dragstart=${(e: DragEvent) => actions.onDragStart(post, e)}
    @dragend=${() => actions.onDragEnd()}
    @click=${() => (selectMode && scheduled ? actions.toggleSelected(post.id) : actions.open(post))}
    @keydown=${(e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (selectMode && scheduled) actions.toggleSelected(post.id);
        else actions.open(post);
        return;
      }
      actions.onChipKey(post, e);
    }}
  >
    ${selectMode
      ? html`<civitai-checkbox
          size="sm"
          .checked=${selectedIds.has(post.id)}
          ?disabled=${!scheduled || !!post.release}
          @click=${(e: Event) => e.stopPropagation()}
          @change=${() => actions.toggleSelected(post.id)}
        ></civitai-checkbox>`
      : html`<span></span>`}
    ${thumb({
      imageLocation: host.config.imageLocation,
      media: post.cover,
      blurred: context.isBlurred(post),
      large: true,
    })}
    <div class="meta">
      <div class="line">
        <span class="time">${formatTime(when)}</span
        ><span
          >${post.title ?? 'Untitled'} · ${post.imageCount}
          item${post.imageCount === 1 ? '' : 's'}</span
        >
      </div>
      <div class="line">
        ${post.release
          ? html`<civitai-badge size="sm" color="warning">Release</civitai-badge
              ><span class="muted">${post.release.modelName} · ${post.release.versionName}</span>`
          : nothing}
        <span class="muted">${scheduled ? 'Scheduled' : 'Published'}</span>
      </div>
    </div>
    ${scheduled
      ? html`<civitai-menu
          label="Actions"
          placement="bottom-end"
          @click=${(e: Event) => e.stopPropagation()}
          @select=${(e: CustomEvent<{ value: string }>) => actions.rowAction(post, e.detail.value)}
        >
          <civitai-button slot="trigger" variant="subtle" size="sm" aria-label="Actions"
            >⋯</civitai-button
          >
          <civitai-menu-item value="open">Details</civitai-menu-item>
          <civitai-menu-item value="publish">Publish now</civitai-menu-item>
          ${post.release
            ? nothing
            : html`<civitai-menu-item value="unschedule" destructive
                >Unschedule</civitai-menu-item
              >`}
        </civitai-menu>`
      : html`<span></span>`}
  </div>`;
}

export const rowStyles = css`
  .row {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface);
    border: 1px solid var(--civitai-color-border);
    border-left: 3px solid var(--civitai-color-primary);
    cursor: pointer;
  }
  .row.release {
    border-left-color: var(--civitai-color-warning);
  }
  .row.published {
    border-left-color: var(--civitai-color-gray-5);
    color: var(--civitai-color-text-dimmed);
  }
  .row.selected {
    outline: 2px solid var(--civitai-color-primary);
  }
  .row {
    min-width: 0;
    overflow: hidden;
  }
  .row .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .row .meta .line {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .row .time {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
`;
