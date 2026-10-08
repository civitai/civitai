import { css, html, nothing, type TemplateResult } from 'lit';
import type { PlannerPost } from '../host.js';
import { formatTime } from '../model/calendar.js';
import { handleIcon, rocketIcon, thumb } from './media.js';
import type { PostContext } from './props.js';

export function renderChip(post: PlannerPost, context: PostContext): TemplateResult {
  const { host, selectMode, selectedIds, pending, actions } = context;
  const scheduled = context.isScheduled(post);
  const classes = [
    'chip',
    post.release ? 'release' : '',
    scheduled ? '' : 'published',
    pending.has(post.id) ? 'pending' : '',
    context.dragId === post.id ? 'dragging' : '',
    selectedIds.has(post.id) ? 'selected' : '',
  ].join(' ');
  const when = new Date(post.publishedAt);
  return html`
    <button
      type="button"
      class=${classes}
      draggable=${scheduled && !selectMode && !pending.has(post.id) ? 'true' : 'false'}
      aria-label="${formatTime(when)}, ${post.title ??
      'untitled'}, ${post.imageCount} items${post.release ? ', release' : ''}${scheduled
        ? ''
        : ', published'}"
      @click=${() =>
        selectMode && scheduled ? actions.toggleSelected(post.id) : actions.open(post)}
      @keydown=${(e: KeyboardEvent) => actions.onChipKey(post, e)}
      @dragstart=${(e: DragEvent) => actions.onDragStart(post, e)}
      @dragend=${() => actions.onDragEnd()}
    >
      ${selectMode && scheduled
        ? html`<civitai-checkbox
            size="sm"
            tabindex="-1"
            aria-hidden="true"
            .checked=${selectedIds.has(post.id)}
            @click=${(e: Event) => e.stopPropagation()}
            @change=${() => actions.toggleSelected(post.id)}
          ></civitai-checkbox>`
        : thumb({
            imageLocation: host.config.imageLocation,
            media: post.cover,
            blurred: context.isBlurred(post),
          })}
      <span class="time">${formatTime(when)}</span>
      ${post.release ? rocketIcon : nothing}
      ${post.title
        ? html`<span class="title">${post.title}</span>`
        : html`<span class="count"
            >· ${post.imageCount} item${post.imageCount === 1 ? '' : 's'}</span
          >`}
      ${scheduled && !selectMode ? handleIcon : nothing}
    </button>
  `;
}

export const chipStyles = css`
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    padding: 3px 6px 3px 4px;
    border-radius: 6px;
    border: 1px solid var(--civitai-color-border);
    border-left: 3px solid var(--civitai-color-primary);
    background: var(--civitai-color-surface-2);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    user-select: none;
  }
  .chip:hover {
    border-color: var(--civitai-color-primary);
  }
  .chip.release {
    border-left-color: var(--civitai-color-warning);
  }
  .chip.published {
    border-left-color: var(--civitai-color-gray-5);
    color: var(--civitai-color-text-dimmed);
    cursor: default;
  }
  .chip.pending {
    opacity: 0.5;
  }
  .chip.dragging {
    opacity: 0.4;
  }
  .chip.selected {
    outline: 2px solid var(--civitai-color-primary);
    outline-offset: 1px;
  }
  .chip[draggable='true'] {
    cursor: grab;
  }
  .chip .time {
    flex: none;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    white-space: nowrap;
  }
  /* Cells shed detail as they narrow: first the item count, then the thumbnail and handle, so the
     time is the last thing standing. */
  @container (max-width: 190px) {
    .chip .count {
      display: none;
    }
  }
  @container (max-width: 120px) {
    .chip .thumb,
    .chip .handle {
      display: none;
    }
  }
  .chip .count {
    flex: 1 1 auto;
    color: var(--civitai-color-text-dimmed);
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .chip .rocket {
    color: var(--civitai-color-warning);
    flex: none;
  }
  .chip .handle {
    margin-left: auto;
    color: var(--civitai-color-text-dimmed);
    opacity: 0;
  }
  .chip:hover .handle {
    opacity: 1;
  }
`;
