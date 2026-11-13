import { css, html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { PlannerPost } from '../host';
import { dayStart, formatTime } from '../model/calendar';
import {
  bandHeight,
  CHIP_HEIGHT_PX,
  countOutsideBand,
  type HourBand,
  type HourRow,
  fittedBand,
  hourBand,
  hourLabel,
  hourRows,
  layoutColumn,
  placeInBand,
  timeAtOffset,
  topOf,
} from '../model/hour-grid';
import { capColor, countScheduledOn } from '../model/posts';
import { renderChip } from '../parts/chip';
import type { PostContext } from '../parts/props';

export interface HourGridProps {
  dayKeys: string[];
  today: string;
  now: Date;
  posts: PlannerPost[];
  cap: number;
  allHours: boolean;
  dragOver: string | null;
  dragAt: Date | null;
  context: PostContext;
}

export function renderHourGrid(props: HourGridProps): TemplateResult {
  const { dayKeys, allHours, context } = props;
  const band = hourBand(allHours, props.posts, dayKeys);
  const rows = hourRows(band);
  const fitted = allHours ? fittedBand(props.posts, dayKeys) : band;
  const hidden = countOutsideBand(props.posts, dayKeys, band);
  const nowPlace = placeInBand(props.now, band);
  return html`
    <div
      class="hour-grid ${dayKeys.length === 1 ? 'single' : ''}"
      style="--pp-columns: ${dayKeys.length}; --pp-band-height: ${bandHeight(band)}px"
    >
      <div class="hour-head">
        <div class="gutter"></div>
        ${dayKeys.map((key) => renderDayHead(key, props))}
      </div>
      <div class="hour-body">
        <div class="gutter">
          ${rows.map(
            (row) => html`<div class="hour-label" style="top: ${row.top}px">${row.label}</div>`
          )}
        </div>
        ${repeat(
          dayKeys,
          (key) => key,
          (key) => renderColumn(key, band, rows, nowPlace, props)
        )}
      </div>
      <div class="hour-foot">
        <button class="plain more" type="button" @click=${() => context.actions.toggleAllHours()}>
          ${allHours
            ? `Show ${hourLabel(fitted.startHour)} – ${hourLabel(fitted.endHour)}`
            : hidden
            ? `Show all hours (${hidden} hidden)`
            : 'Show all hours'}
        </button>
      </div>
    </div>
  `;
}

function longDate(key: string): string {
  return dayStart(key).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function renderDayHead(key: string, props: HourGridProps): TemplateResult {
  const day = dayStart(key);
  const scheduled = countScheduledOn(props.posts, key, props.now);
  const color = capColor(scheduled, props.cap);
  return html`<div class="day-head ${key === props.today ? 'today' : ''}">
    <span>
      <span class="weekday">${day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      <span class="num">${day.getDate()}</span>
    </span>
    ${scheduled
      ? html`<civitai-badge size="sm" variant=${color ? 'filled' : 'light'} color=${color}
          >${scheduled}${props.cap ? `/${props.cap}` : ''}</civitai-badge
        >`
      : nothing}
  </div>`;
}

function renderColumn(
  key: string,
  band: HourBand,
  rows: HourRow[],
  nowPlace: { dayKey: string; minutes: number } | null,
  props: HourGridProps
): TemplateResult {
  const { context, dragOver, dragAt } = props;
  const { actions } = context;
  const chips = layoutColumn(props.posts, key, band);
  const offsetOf = (event: DragEvent) =>
    event.clientY - (event.currentTarget as HTMLElement).getBoundingClientRect().top;
  const dropAt = dragOver === key && dragAt ? placeInBand(dragAt, band) : null;
  const classes = [
    'hour-col',
    key === props.today ? 'today' : '',
    dragOver === key ? 'over' : '',
  ].join(' ');
  return html`<section
    class=${classes}
    aria-label=${longDate(key)}
    @dragover=${(e: DragEvent) =>
      actions.onDragOverAt(key, timeAtOffset(key, offsetOf(e), band), e)}
    @dragleave=${() => actions.onDragLeave(key)}
    @drop=${(e: DragEvent) => actions.onDropAt(timeAtOffset(key, offsetOf(e), band), e)}
  >
    ${rows.map((row) => html`<div class="hour-line" style="top: ${row.top}px"></div>`)}
    ${nowPlace?.dayKey === key
      ? html`<div class="now-line" style="top: ${topOf(nowPlace.minutes, band)}px"></div>`
      : nothing}
    ${repeat(
      chips,
      (chip) => chip.post.id,
      (chip) => html`<div
        class="slot"
        style="top: ${chip.top}px; left: calc(${chip.lane} * 100% / ${chip.lanes}); width: calc(100% / ${chip.lanes})"
      >
        ${renderChip(chip.post, context)}
      </div>`
    )}
    ${dropAt && dragAt
      ? html`<div class="drop-line" style="top: ${topOf(dropAt.minutes, band)}px">
          <span>${formatTime(dragAt)}</span>
        </div>`
      : nothing}
  </section>`;
}

export const hourGridStyles = css`
  .hour-grid {
    --pp-gutter: 52px;
    --pp-slot: ${CHIP_HEIGHT_PX}px;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--civitai-color-border);
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface);
    overflow: hidden;
  }
  .hour-head,
  .hour-body {
    display: grid;
    grid-template-columns: var(--pp-gutter) repeat(var(--pp-columns), minmax(0, 1fr));
  }
  .hour-head {
    position: sticky;
    top: 0;
    z-index: 3;
    background: var(--civitai-color-surface);
    border-bottom: 1px solid var(--civitai-color-border);
  }
  .day-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
    padding: 6px 8px;
    font-size: 12px;
    font-weight: 600;
    border-left: 1px solid var(--civitai-color-border);
  }
  .day-head .weekday {
    color: var(--civitai-color-text-dimmed);
    text-transform: uppercase;
    letter-spacing: 0.02em;
    margin-right: 4px;
  }
  .day-head .num {
    font-size: 15px;
  }
  .day-head.today .num {
    color: var(--civitai-color-primary);
  }
  .hour-body {
    position: relative;
    padding: 10px 0;
    height: calc(var(--pp-band-height) + 20px);
  }
  .hour-body .gutter {
    position: relative;
  }
  .hour-label {
    position: absolute;
    right: 6px;
    transform: translateY(-50%);
    font-size: 11px;
    white-space: nowrap;
    color: var(--civitai-color-text-dimmed);
  }
  .hour-col {
    position: relative;
    container-type: inline-size;
    min-width: 0;
    border-left: 1px solid var(--civitai-color-border);
    transition: background 120ms;
  }
  .hour-col.today {
    background: color-mix(in srgb, var(--civitai-color-primary) 4%, transparent);
  }
  .hour-col.over {
    background: color-mix(in srgb, var(--civitai-color-primary) 10%, transparent);
  }
  .hour-line,
  .now-line,
  .drop-line {
    position: absolute;
    left: 0;
    right: 0;
    pointer-events: none;
  }
  .hour-line {
    border-top: 1px solid var(--civitai-color-border);
    opacity: 0.6;
  }
  .now-line {
    border-top: 2px solid var(--civitai-color-error);
    z-index: 1;
  }
  .drop-line {
    border-top: 2px dashed var(--civitai-color-primary);
    z-index: 3;
  }
  .drop-line span {
    position: absolute;
    right: 4px;
    top: -9px;
    padding: 0 6px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    background: var(--civitai-color-primary);
    color: #fff;
  }
  .slot {
    position: absolute;
    height: var(--pp-slot);
    padding: 0 2px;
    z-index: 2;
  }
  .slot .chip {
    height: 100%;
    padding: 0 6px 0 3px;
    border-radius: 4px;
  }
  .slot .chip .thumb {
    width: 18px;
    height: 18px;
  }
  .hour-foot {
    display: flex;
    justify-content: flex-end;
    padding: 4px 8px;
    border-top: 1px solid var(--civitai-color-border);
  }
  @media (max-width: 767px) {
    .hour-grid {
      --pp-gutter: 44px;
    }
    .hour-grid:not(.single) {
      overflow-x: auto;
    }
    .hour-grid:not(.single) .hour-head,
    .hour-grid:not(.single) .hour-body {
      min-width: calc(var(--pp-gutter) + var(--pp-columns) * 96px);
    }
  }
`;
