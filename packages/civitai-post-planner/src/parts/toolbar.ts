import type { CivitaiSegmentedControl } from '@civitai/components/civitai-segmented-control';
import type { CivitaiSelect } from '@civitai/components/civitai-select';
import { css, html, nothing, type TemplateResult } from 'lit';
import type { PlannerHost, PlannerLocation, PlannerView } from '../host.js';
import { formatRangeLabel, stepAnchor } from '../model/calendar.js';
import type { Filters } from '../model/posts.js';
import type { PlannerActions } from './props.js';

const VIEWS: { value: PlannerView; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'agenda', label: 'Agenda' },
];

export interface ToolbarProps {
  host: PlannerHost;
  loc: PlannerLocation;
  today: string;
  loading: boolean;
  filters: Filters;
  showMature: boolean;
  hasMature: boolean;
  selectMode: boolean;
  modelOptions: { value: string; label: string }[];
  actions: PlannerActions;
}

export function renderToolbar(props: ToolbarProps): TemplateResult {
  const { host, loc, filters, actions } = props;
  const todayLoc = { ...loc, anchor: props.today };
  const prevLoc = { ...loc, anchor: stepAnchor(loc.view, loc.anchor, -1) };
  const nextLoc = { ...loc, anchor: stepAnchor(loc.view, loc.anchor, 1) };
  return html`
    <div class="toolbar">
      <civitai-segmented-control
        aria-label="View"
        size="sm"
        .data=${VIEWS}
        .value=${loc.view}
        @change=${(e: Event) => {
          const view = (e.target as CivitaiSegmentedControl).value as PlannerView;
          if (view && view !== loc.view) actions.navigate({ ...loc, view });
        }}
      ></civitai-segmented-control>
      <civitai-button-group>
        <civitai-button
          variant="outline"
          size="sm"
          href=${host.hrefFor(prevLoc)}
          @click=${(e: Event) => actions.link(e, prevLoc)}
          aria-label="Previous"
          >‹</civitai-button
        >
        <civitai-button
          variant="outline"
          size="sm"
          href=${host.hrefFor(todayLoc)}
          @click=${(e: Event) => actions.link(e, todayLoc)}
          >Today</civitai-button
        >
        <civitai-button
          variant="outline"
          size="sm"
          href=${host.hrefFor(nextLoc)}
          @click=${(e: Event) => actions.link(e, nextLoc)}
          aria-label="Next"
          >›</civitai-button
        >
      </civitai-button-group>
      <span class="range"
        >${formatRangeLabel(loc.view, loc.anchor)}${props.loading
          ? html` <civitai-loader size="sm" label="Loading"></civitai-loader>`
          : nothing}</span
      >
      <span class="spacer"></span>
      ${renderModelFilter(props)}
      <div class="filters">
        <civitai-checkbox
          label="Scheduled"
          size="sm"
          .checked=${filters.scheduled}
          @change=${(e: Event) =>
            actions.setFilters({ scheduled: (e.target as HTMLInputElement).checked })}
        ></civitai-checkbox>
        <civitai-checkbox
          label="Published"
          size="sm"
          .checked=${filters.published}
          @change=${(e: Event) =>
            actions.setFilters({ published: (e.target as HTMLInputElement).checked })}
        ></civitai-checkbox>
        <civitai-checkbox
          label="Releases"
          size="sm"
          .checked=${filters.releases}
          @change=${(e: Event) =>
            actions.setFilters({ releases: (e.target as HTMLInputElement).checked })}
        ></civitai-checkbox>
      </div>
      ${props.hasMature
        ? html`<civitai-switch
            label="Show mature"
            size="sm"
            .checked=${props.showMature}
            @change=${(e: Event) => actions.setShowMature((e.target as HTMLInputElement).checked)}
          ></civitai-switch>`
        : nothing}
      <civitai-button
        variant=${props.selectMode ? 'light' : 'outline'}
        size="sm"
        @click=${() => actions.toggleSelectMode()}
        >${props.selectMode ? 'Done' : 'Select'}</civitai-button
      >
    </div>
  `;
}

function renderModelFilter({
  loc,
  modelOptions,
  actions,
}: ToolbarProps): TemplateResult | typeof nothing {
  if (modelOptions.length === 0 && !loc.modelVersionId) return nothing;
  const data = [{ value: '', label: 'All models' }, ...modelOptions];
  return html`<civitai-select
    aria-label="Model"
    size="sm"
    .data=${data}
    .value=${loc.modelVersionId ? String(loc.modelVersionId) : ''}
    @change=${(e: Event) => {
      const value = (e.target as CivitaiSelect).value;
      actions.navigate({ ...loc, modelVersionId: value ? Number(value) : undefined });
    }}
  ></civitai-select>`;
}

export const toolbarStyles = css`
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .toolbar .range {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    min-width: 180px;
  }
  .toolbar .spacer {
    flex: 1;
  }
  .filters {
    display: inline-flex;
    align-items: center;
    gap: 12px;
  }
`;
