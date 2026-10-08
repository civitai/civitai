import { css, html, nothing, type TemplateResult } from 'lit';
import type { PlannerPost } from '../host.js';
import { bucketByLocalDay, dayStart } from '../model/calendar.js';
import { capColor, countScheduled } from '../model/posts.js';
import type { PostContext } from '../parts/props.js';
import { renderRow } from '../parts/row.js';

export interface ListProps {
  dayKeys: string[];
  skipEmpty?: boolean;
  now: Date;
  posts: PlannerPost[];
  cap: number;
  context: PostContext;
}

/** One section per day; the week, day, agenda and narrow-month views all read as this list. */
export function renderList({
  dayKeys,
  skipEmpty,
  now,
  posts,
  cap,
  context,
}: ListProps): TemplateResult {
  const { actions } = context;
  const byDay = bucketByLocalDay(posts);
  const groups = dayKeys.filter((key) => !skipEmpty || byDay.has(key));
  if (groups.length === 0) return html`<div class="empty">Nothing scheduled in this range.</div>`;
  return html`${groups.map((key) => {
    const dayPosts = byDay.get(key) ?? [];
    const scheduled = countScheduled(dayPosts, now);
    const color = capColor(scheduled, cap);
    return html`<section
      class="day-group"
      @dragover=${(e: DragEvent) => actions.onDragOver(key, e)}
      @drop=${(e: DragEvent) => actions.onDrop(key, e)}
    >
      <h3>
        ${dayStart(key).toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        })}
        ${scheduled
          ? html`<civitai-badge size="sm" variant=${color ? 'filled' : 'light'} color=${color}
              >${scheduled}${cap ? `/${cap}` : ''}</civitai-badge
            >`
          : nothing}
      </h3>
      ${dayPosts.length === 0
        ? html`<div class="empty">No posts scheduled.</div>`
        : dayPosts.map((post) => renderRow(post, context))}
    </section>`;
  })}`;
}

export const listStyles = css`
  .day-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .day-group h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--civitai-color-text-dimmed);
  }
  .empty {
    padding: 24px;
    text-align: center;
    color: var(--civitai-color-text-dimmed);
    border: 1px dashed var(--civitai-color-border);
    border-radius: var(--civitai-radius);
  }
`;
