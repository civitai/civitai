import type { CivitaiSegmentedControl } from '@civitai/components/civitai-segmented-control';
import type { CivitaiSelect } from '@civitai/components/civitai-select';
import { css, html, nothing, type TemplateResult } from 'lit';
import type { PlannerHost, PlannerLocation, PlannerView } from '../host';
import { formatRangeLabel, stepAnchor } from '../model/calendar';
import type { Filters } from '../model/posts';
import { renderLegend } from './legend';
import type { PlannerActions } from './props';

const VIEWS: { value: PlannerView; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'agenda', label: 'Agenda' },
];

const DEFAULT_FILTERS: Filters = { scheduled: true, published: false, releases: true };

export interface ToolbarProps {
  host: PlannerHost;
  loc: PlannerLocation;
  today: string;
  loading: boolean;
  filters: Filters;
  showMature: boolean;
  hasMature: boolean;
  selectMode: boolean;
  narrow: boolean;
  filtersOpen: boolean;
  modelOptions: { value: string; label: string }[];
  actions: PlannerActions;
}

export function renderToolbar(props: ToolbarProps): TemplateResult {
  return props.narrow ? renderNarrowToolbar(props) : renderWideToolbar(props);
}

function renderWideToolbar(props: ToolbarProps): TemplateResult {
  return html`
    <div class="toolbar">
      ${renderViewSwitcher(props)} ${renderNav(props)}
      <span class="range"
        >${formatRangeLabel(props.loc.view, props.loc.anchor)}${renderLoader(props)}</span
      >
      <span class="spacer"></span>
      ${renderModelFilter(props)} ${renderTagFilter(props)}
      <div class="filters">${renderStatusFilters(props)}</div>
      ${renderMatureToggle(props)} ${renderSelectToggle(props)}
    </div>
  `;
}

function renderNarrowToolbar(props: ToolbarProps): TemplateResult {
  const active = activeFilterCount(props);
  return html`
    <div class="toolbar narrow">
      <div class="view-row">
        ${renderViewSwitcher(props)}
        <span class="range"
          >${formatRangeLabel(props.loc.view, props.loc.anchor, undefined, {
            compact: true,
          })}${renderLoader(props)}</span
        >
      </div>
      <div class="nav-row">
        ${renderNav(props)}
        <span class="spacer"></span>
        <civitai-button
          variant=${props.filtersOpen || active ? 'light' : 'outline'}
          size="sm"
          aria-expanded=${props.filtersOpen ? 'true' : 'false'}
          @click=${() => props.actions.toggleFilters()}
          >Filters${active ? ` · ${active}` : ''}</civitai-button
        >
        ${renderSelectToggle(props)}
      </div>
      ${props.filtersOpen
        ? html`<div class="filters-panel">
            ${renderModelFilter(props)} ${renderTagFilter(props)}
            <div class="filters">${renderStatusFilters(props)}</div>
            ${renderMatureToggle(props)} ${renderLegend()}
          </div>`
        : nothing}
    </div>
  `;
}

function activeFilterCount({ filters, loc }: ToolbarProps): number {
  const changed = (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).filter(
    (key) => filters[key] !== DEFAULT_FILTERS[key]
  ).length;
  return changed + (loc.modelVersionId ? 1 : 0) + (loc.tag ? 1 : 0);
}

function renderTagFilter({ loc, actions }: ToolbarProps): TemplateResult | typeof nothing {
  if (!loc.tag) return nothing;
  return html`<span class="tag-filter" aria-label="Tag filter"
    >#${loc.tag}
    <button
      class="plain clear"
      type="button"
      aria-label="Clear tag filter"
      @click=${() => actions.setTag(undefined)}
    >
      ✕
    </button></span
  >`;
}

function renderViewSwitcher({ loc, actions }: ToolbarProps): TemplateResult {
  return html`<civitai-segmented-control
    aria-label="View"
    size="sm"
    .data=${VIEWS}
    .value=${loc.view}
    @change=${(e: Event) => {
      const view = (e.target as CivitaiSegmentedControl).value as PlannerView;
      if (view && view !== loc.view) actions.navigate({ ...loc, view });
    }}
  ></civitai-segmented-control>`;
}

function renderNav({ host, loc, today, actions }: ToolbarProps): TemplateResult {
  const todayLoc = { ...loc, anchor: today };
  const prevLoc = { ...loc, anchor: stepAnchor(loc.view, loc.anchor, -1) };
  const nextLoc = { ...loc, anchor: stepAnchor(loc.view, loc.anchor, 1) };
  return html`<civitai-button-group>
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
  </civitai-button-group>`;
}

function renderLoader({ loading }: ToolbarProps): TemplateResult | typeof nothing {
  return loading ? html` <civitai-loader size="sm" label="Loading"></civitai-loader>` : nothing;
}

function renderStatusFilters({ filters, actions }: ToolbarProps): TemplateResult {
  const checkbox = (key: keyof Filters, label: string) =>
    html`<civitai-checkbox
      label=${label}
      size="sm"
      .checked=${filters[key]}
      @change=${(e: Event) => actions.setFilters({ [key]: (e.target as HTMLInputElement).checked })}
    ></civitai-checkbox>`;
  return html`${checkbox('scheduled', 'Scheduled')} ${checkbox('published', 'Published')}
  ${checkbox('releases', 'Releases')}`;
}

function renderMatureToggle(props: ToolbarProps): TemplateResult | typeof nothing {
  if (!props.hasMature) return nothing;
  return html`<civitai-switch
    label="Show mature"
    size="sm"
    .checked=${props.showMature}
    @change=${(e: Event) => props.actions.setShowMature((e.target as HTMLInputElement).checked)}
  ></civitai-switch>`;
}

function renderSelectToggle({ selectMode, actions }: ToolbarProps): TemplateResult {
  return html`<civitai-button
    variant=${selectMode ? 'light' : 'outline'}
    size="sm"
    @click=${() => actions.toggleSelectMode()}
    >${selectMode ? 'Done' : 'Select'}</civitai-button
  >`;
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
  .tag-filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    color: var(--civitai-color-primary);
    background: color-mix(in srgb, var(--civitai-color-primary) 12%, transparent);
  }
  .tag-filter .clear {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    font-size: 11px;
  }
  .tag-filter .clear:hover {
    background: color-mix(in srgb, var(--civitai-color-primary) 20%, transparent);
  }
  .filters {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }
  .toolbar.narrow {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .view-row,
  .nav-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .view-row > civitai-segmented-control,
  .nav-row > civitai-button-group,
  .nav-row > civitai-button {
    flex: none;
  }
  .toolbar.narrow .range {
    display: block;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    font-size: 13px;
  }
  .filters-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface-2);
    border: 1px solid var(--civitai-color-border);
  }
  .filters-panel .legend {
    flex-wrap: wrap;
    gap: 6px 14px;
  }
`;
