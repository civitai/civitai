import { css, html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { hostLink, type PlannerLocation, type PlannerPost } from '../host.js';
import {
  bucketByLocalDay,
  type CalendarDay,
  dayStart,
  formatRangeLabel,
  monthGrid,
  weeksOf,
} from '../model/calendar.js';
import { capColor, countScheduled } from '../model/posts.js';
import { renderChip } from '../parts/chip.js';
import type { PostContext } from '../parts/props.js';

const MONTH_CHIPS_PER_CELL = 3;

export interface MonthProps {
  loc: PlannerLocation;
  today: string;
  now: Date;
  posts: PlannerPost[];
  cap: number;
  dragOver: string | null;
  context: PostContext;
}

export function renderMonth(props: MonthProps): TemplateResult {
  const days = monthGrid(props.loc.anchor, props.today);
  const byDay = bucketByLocalDay(props.posts);
  return html`
    <div class="weekdays" role="row">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(
        (d) => html`<div role="columnheader">${d}</div>`
      )}
    </div>
    <div class="grid month" role="grid" aria-label=${formatRangeLabel('month', props.loc.anchor)}>
      ${repeat(
        weeksOf(days),
        (week) => week[0].key,
        (week) => html`<div class="week" role="row">
          ${repeat(
            week,
            (d) => d.key,
            (day) => renderCell(day, byDay.get(day.key) ?? [], props)
          )}
        </div>`
      )}
    </div>
    <div class="muted">
      Day counts are the posts scheduled that day; the daily limit is counted on UTC days by the
      server.
    </div>
  `;
}

function renderCell(day: CalendarDay, posts: PlannerPost[], props: MonthProps): TemplateResult {
  const { loc, cap, context } = props;
  const { host, actions } = context;
  const scheduled = countScheduled(posts, props.now);
  const badgeColor = capColor(scheduled, cap);
  const shown = posts.slice(0, MONTH_CHIPS_PER_CELL);
  const hidden = posts.length - shown.length;
  const canQuickAdd =
    posts.length === 0 &&
    host.config.composerAvailable &&
    host.composerUrl &&
    day.key >= props.today;
  const quickAdd = canQuickAdd
    ? hostLink(host.composerUrl!({ startAt: dayStart(day.key).toISOString() }))
    : null;
  const classes = [
    'cell',
    day.inMonth ? '' : 'out',
    day.isToday ? 'today' : '',
    props.dragOver === day.key ? 'over' : '',
  ].join(' ');
  return html`
    <div
      class=${classes}
      role="gridcell"
      @dragover=${(e: DragEvent) => actions.onDragOver(day.key, e)}
      @dragleave=${() => actions.onDragLeave(day.key)}
      @drop=${(e: DragEvent) => actions.onDrop(day.key, e)}
    >
      <div class="cell-head">
        <span class="num">${day.day}</span>
        ${scheduled
          ? html`<civitai-badge
              size="sm"
              variant=${badgeColor ? 'filled' : 'light'}
              color=${badgeColor}
              >${scheduled}${cap ? `/${cap}` : ''}</civitai-badge
            >`
          : nothing}
      </div>
      ${shown.map((post) => renderChip(post, context))}
      ${hidden > 0
        ? html`<button
            class="plain more"
            @click=${() => actions.navigate({ ...loc, view: 'day', anchor: day.key })}
          >
            +${hidden} more
          </button>`
        : nothing}
      ${quickAdd
        ? html`<a
            class="quick-add"
            href=${quickAdd.href}
            target=${ifDefined(quickAdd.target)}
            rel=${ifDefined(quickAdd.rel)}
            aria-label="Schedule a batch starting ${day.key}"
            >+</a
          >`
        : nothing}
    </div>
  `;
}

export const monthStyles = css`
  .weekdays,
  .grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }
  .weekdays div {
    padding: 4px 8px;
    color: var(--civitai-color-text-dimmed);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .grid {
    gap: 6px;
  }
  .grid .week {
    display: contents;
  }
  .cell {
    position: relative;
    container-type: inline-size;
    min-height: var(--pp-cell-min);
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface);
    border: 1px solid var(--civitai-color-border);
    transition: border-color 120ms, background 120ms;
  }
  .cell.out {
    opacity: 0.55;
  }
  .cell.today {
    border-color: var(--civitai-color-primary);
  }
  .cell.over {
    border-color: var(--civitai-color-primary);
    background: color-mix(in srgb, var(--civitai-color-primary) 10%, var(--civitai-color-surface));
  }
  .cell-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-height: 22px;
  }
  .cell-head .num {
    font-weight: 600;
    font-size: 13px;
  }
  .cell.today .num {
    color: var(--civitai-color-primary);
  }
  .cell .quick-add {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--civitai-color-primary);
    font-size: 22px;
    opacity: 0;
    transition: opacity 120ms;
  }
  .cell:hover .quick-add,
  .cell:focus-within .quick-add {
    opacity: 1;
  }
`;
