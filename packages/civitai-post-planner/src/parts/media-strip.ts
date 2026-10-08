import { css, html, nothing, type TemplateResult } from 'lit';
import type { PlannerHost, PlannerPost, PlannerPostDetail } from '../host.js';
import { renderLightbox } from './lightbox.js';
import { eyeIcon, mediaUrl, PG_LEVEL, thumb } from './media.js';
import type { PlannerActions } from './props.js';

export interface MediaStripProps {
  host: PlannerHost;
  post: PlannerPost;
  detail: PlannerPostDetail | null;
  lightbox: number | null;
  isBlurred(item: { id: number; nsfwLevel: number }): boolean;
  actions: PlannerActions;
}

export function renderMediaStrip(props: MediaStripProps): TemplateResult {
  const { host, post, detail, isBlurred, actions } = props;
  const location = host.config.imageLocation;
  if (!detail) {
    return html`<div class="strip">
      <figure>
        ${thumb({
          imageLocation: location,
          media: post.cover,
          blurred: isBlurred(post),
          large: true,
        })}
      </figure>
    </div>`;
  }
  return html`<div class="strip" aria-label="Media">
      ${detail.media.map((m, i) => {
        const blurred = isBlurred(m);
        return html`<figure>
          <button
            class="plain zoom"
            aria-label="Open item ${i + 1} of ${detail.media.length}"
            @click=${() => actions.setLightbox(i)}
          >
            ${m.type === 'audio'
              ? html`<span class="thumb lg"></span>`
              : html`<img
                  class=${blurred ? 'blurred' : ''}
                  src=${mediaUrl(location, m.url, 192)}
                  alt=""
                  loading="lazy"
                />`}
          </button>
          <span class="idx">${i + 1} / ${detail.media.length}</span>
          ${m.nsfwLevel > PG_LEVEL
            ? html`<button
                class="plain eye"
                aria-label=${blurred ? 'Show' : 'Hide'}
                @click=${() => actions.toggleUnblur(m.id)}
              >
                ${eyeIcon(blurred)}
              </button>`
            : nothing}
        </figure>`;
      })}
    </div>
    ${renderLightbox({ host, detail, index: props.lightbox, isBlurred, actions })}`;
}

export const mediaStripStyles = css`
  .strip {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .strip figure {
    position: relative;
    flex: none;
    margin: 0;
    width: 96px;
    height: 96px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--civitai-color-media-placeholder);
  }
  .strip img,
  .strip video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .strip .zoom {
    display: block;
    width: 100%;
    height: 100%;
    cursor: zoom-in;
  }
  .strip .zoom img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .strip .eye {
    position: absolute;
    right: 4px;
    bottom: 4px;
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
  }
  .strip .idx {
    position: absolute;
    left: 4px;
    top: 4px;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
  }
`;
