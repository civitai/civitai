import {
  POST_MAXIMUM_SCHEDULE_MONTHS,
  POST_MINIMUM_SCHEDULE_MINUTES,
} from '@civitai/shared/post-scheduling';
import { css, html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { hostLink, type PlannerHost, type PlannerPost, type PlannerPostDetail } from '../host.js';
import { formatDateTime, localDayKey, toTimeInput } from '../model/calendar.js';
import { releaseScopeLabel } from '../model/messages.js';
import { renderMediaStrip } from './media-strip.js';
import type { PlannerActions } from './props.js';

export interface DrawerProps {
  host: PlannerHost;
  post: PlannerPost;
  detail: PlannerPostDetail | null;
  detailLoading: boolean;
  scheduled: boolean;
  pending: boolean;
  draft: Date;
  now: Date;
  cap: number | undefined;
  sameDay: number;
  descriptionExpanded: boolean;
  lightbox: number | null;
  prev: PlannerPost | null;
  next: PlannerPost | null;
  isBlurred(item: { id: number; nsfwLevel: number }): boolean;
  actions: PlannerActions;
}

export function renderDrawer(props: DrawerProps): TemplateResult {
  const { host, post, detail, scheduled, draft, actions } = props;
  const edit = hostLink(host.editPostUrl(post));
  const view = hostLink(host.viewPostUrl(post));
  return html`
    <aside class="drawer" aria-label="Post details" @keydown=${actions.onDrawerKey}>
      <div class="drawer-head">
        <div>
          <h2>
            ${post.title ?? 'Untitled post'} · ${post.imageCount}
            item${post.imageCount === 1 ? '' : 's'}
          </h2>
          <div class="muted">
            ${scheduled ? 'Scheduled for' : 'Published'}
            ${formatDateTime(new Date(post.publishedAt))}
          </div>
        </div>
        <civitai-button
          variant="subtle"
          size="sm"
          aria-label="Close"
          @click=${() => actions.close()}
          >✕</civitai-button
        >
      </div>

      ${renderMediaStrip({
        host,
        post,
        detail,
        lightbox: props.lightbox,
        isBlurred: props.isBlurred,
        actions,
      })}
      ${post.release
        ? html`<civitai-alert color="warning">
            This post goes live with ${post.release.modelName} · ${post.release.versionName}.
            Rescheduling or publishing it moves ${releaseScopeLabel(post.release.scope)} and every
            post scheduled with it.
          </civitai-alert>`
        : nothing}
      ${detail?.description
        ? html`<div class="section">
            <h4>Description</h4>
            <div class="description ${props.descriptionExpanded ? 'expanded' : ''}">
              ${detail.description}
            </div>
            ${detail.description.length > 240
              ? html`<button class="plain more" @click=${() => actions.toggleDescription()}>
                  ${props.descriptionExpanded ? 'Show less' : 'Show more'}
                </button>`
              : nothing}
          </div>`
        : nothing}
      ${scheduled ? renderSchedule(props) : nothing}
      ${detail?.model ? renderModel(props, detail.model) : nothing}
      ${detail && detail.resources.length
        ? html`<div class="section">
            <h4>Resources</h4>
            <div class="pills">
              ${detail.resources.map((r) => {
                const link = hostLink(
                  host.modelPageUrl({
                    modelId: r.modelId,
                    modelVersionId: r.versionId,
                    nsfwLevel: post.nsfwLevel,
                  })
                );
                return html`<a
                  class="pill"
                  href=${link.href}
                  target=${ifDefined(link.target)}
                  rel=${ifDefined(link.rel)}
                  >${r.name} <span class="muted">${r.type}</span></a
                >`;
              })}
            </div>
          </div>`
        : nothing}
      ${detail && (detail.tools.length || detail.techniques.length)
        ? html`<div class="section">
            <h4>Tools & techniques</h4>
            <div class="pills">
              ${[...detail.tools, ...detail.techniques].map(
                (t) => html`<span class="pill">${t}</span>`
              )}
            </div>
          </div>`
        : nothing}
      ${detail && detail.tags.length
        ? html`<div class="section">
            <h4>Tags</h4>
            <div class="pills">
              ${detail.tags.map((t) => html`<span class="pill">#${t}</span>`)}
            </div>
          </div>`
        : nothing}
      ${detail?.stats
        ? html`<div class="section">
            <h4>Engagement</h4>
            <div>${detail.stats.reactions} reactions · ${detail.stats.comments} comments</div>
          </div>`
        : nothing}
      ${props.detailLoading && !detail
        ? html`<div class="muted">
            <civitai-loader size="sm" label="Loading"></civitai-loader> Loading details…
          </div>`
        : nothing}

      <div class="actions">
        ${scheduled
          ? html`
              ${post.release
                ? nothing
                : html`<civitai-button
                    variant="outline"
                    full-width
                    @click=${() => actions.unschedule([post.id])}
                    >Unschedule to draft</civitai-button
                  >`}
              <civitai-button variant="outline" full-width @click=${() => actions.publishNow(post)}>
                ${post.release
                  ? post.release.scope === 'model'
                    ? 'Publish model now'
                    : 'Publish version now'
                  : 'Publish now'}
              </civitai-button>
            `
          : nothing}
        <div class="links">
          <a href=${edit.href} target=${ifDefined(edit.target)} rel=${ifDefined(edit.rel)}
            >Edit post →</a
          >
          ${scheduled
            ? nothing
            : html`<a href=${view.href} target=${ifDefined(view.target)} rel=${ifDefined(view.rel)}
                >View post →</a
              >`}
        </div>
      </div>

      <div class="nav-posts">
        ${props.prev
          ? html`<button class="plain more" @click=${() => actions.open(props.prev!)}>
              ‹ Previous post
            </button>`
          : html`<span></span>`}
        ${props.next
          ? html`<button class="plain more" @click=${() => actions.open(props.next!)}>
              Next post ›
            </button>`
          : html`<span></span>`}
      </div>
    </aside>
  `;
}

function renderSchedule({ post, draft, now, cap, sameDay, pending, actions }: DrawerProps) {
  return html`<div class="section">
    <h4>Goes live</h4>
    <div class="fields">
      <label
        >Date<input
          type="date"
          .value=${localDayKey(draft)}
          min=${localDayKey(now)}
          @change=${(e: Event) => actions.setDraft((e.target as HTMLInputElement).value, null)}
      /></label>
      <label
        >Time<input
          type="time"
          step="300"
          .value=${toTimeInput(draft)}
          @change=${(e: Event) => actions.setDraft(null, (e.target as HTMLInputElement).value)}
      /></label>
    </div>
    <civitai-button
      variant="filled"
      full-width
      ?disabled=${pending || draft.getTime() === new Date(post.publishedAt).getTime()}
      ?loading=${pending}
      @click=${() => actions.reschedule(post, draft)}
    >
      ${post.release ? 'Move release' : 'Reschedule'}
    </civitai-button>
    <div class="muted">
      In your local time. ${POST_MINIMUM_SCHEDULE_MINUTES} minutes to
      ${POST_MAXIMUM_SCHEDULE_MONTHS} months
      ahead.${cap ? ` ${sameDay} of ${cap} on this day.` : ''}
    </div>
  </div>`;
}

function renderModel(
  { host, post }: DrawerProps,
  model: NonNullable<PlannerPostDetail['model']>
): TemplateResult {
  const link = hostLink(
    host.modelPageUrl({
      modelId: model.id,
      modelVersionId: post.modelVersionId ?? 0,
      nsfwLevel: post.nsfwLevel,
    })
  );
  return html`<div class="section">
    <h4>Model</h4>
    <div class="pills">
      <a class="pill" href=${link.href} target=${ifDefined(link.target)} rel=${ifDefined(link.rel)}
        >${model.name} · ${model.versionName}</a
      >
    </div>
  </div>`;
}

export const drawerStyles = css`
  aside.drawer {
    width: var(--pp-drawer-width);
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface);
    border: 1px solid var(--civitai-color-border);
    position: sticky;
    top: 12px;
  }
  .drawer-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }
  .drawer h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .section h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--civitai-color-text-dimmed);
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pill {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    background: var(--civitai-color-surface-2);
    border: 1px solid var(--civitai-color-border);
  }
  .description {
    white-space: pre-wrap;
    color: var(--civitai-color-text);
    max-height: 5.6em;
    overflow: hidden;
  }
  .description.expanded {
    max-height: none;
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .fields label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--civitai-color-text-dimmed);
  }
  .fields input {
    font: inherit;
    color: var(--civitai-color-text);
    background: var(--civitai-color-surface-2);
    border: 1px solid var(--civitai-color-border);
    border-radius: var(--civitai-radius);
    padding: 6px 8px;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 13px;
  }
  .nav-posts {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
  }

  @media (max-width: 1023px) {
    aside.drawer {
      position: fixed;
      inset: auto 0 0 0;
      width: auto;
      max-height: 85vh;
      overflow-y: auto;
      border-radius: var(--civitai-radius) var(--civitai-radius) 0 0;
      z-index: 20;
    }
  }
`;
