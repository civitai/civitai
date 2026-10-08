import { css, html, type TemplateResult } from 'lit';
import type { PlannerLocation, PlannerPost } from '../host.js';
import { addDays, monthGrid, weekDays } from '../model/calendar.js';
import type { PostContext } from '../parts/props.js';
import { renderList } from './list.js';
import { renderMonth } from './month.js';

export interface ViewProps {
  loc: PlannerLocation;
  today: string;
  now: Date;
  narrow: boolean;
  loading: boolean;
  loaded: boolean;
  posts: PlannerPost[];
  cap: number;
  dragOver: string | null;
  context: PostContext;
}

export function renderView(props: ViewProps): TemplateResult {
  const { loc, today } = props;
  if (!props.loaded && props.loading) {
    return html`<div class="loading" role="status">
      <civitai-loader size="lg" label="Loading your schedule"></civitai-loader>
      <span class="muted">Loading your schedule…</span>
    </div>`;
  }
  const list = (dayKeys: string[], skipEmpty = false) =>
    renderList({
      dayKeys,
      skipEmpty,
      now: props.now,
      posts: props.posts,
      cap: props.cap,
      context: props.context,
    });
  // A seven-column grid has no room on a phone; the same range reads fine as a day list.
  if (props.narrow && loc.view === 'month') {
    const days = monthGrid(loc.anchor, today)
      .filter((d) => d.inMonth)
      .map((d) => d.key);
    return list(days, true);
  }
  switch (loc.view) {
    case 'month':
      return renderMonth(props);
    case 'week':
      return list(weekDays(loc.anchor, today).map((d) => d.key));
    case 'day':
      return list([loc.anchor]);
    case 'agenda':
      return list(
        Array.from({ length: 42 }, (_, i) => addDays(loc.anchor, i)),
        true
      );
  }
}

export const viewStyles = css`
  .loading {
    min-height: 320px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
  }
`;
