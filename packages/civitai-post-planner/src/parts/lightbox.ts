import { css, html, nothing, type TemplateResult } from 'lit';
import type { PlannerHost, PlannerPostDetail } from '../host.js';
import { mediaUrl, PG_LEVEL } from './media.js';
import type { PlannerActions } from './props.js';

export interface LightboxProps {
  host: PlannerHost;
  detail: PlannerPostDetail;
  index: number | null;
  isBlurred(item: { id: number; nsfwLevel: number }): boolean;
  actions: PlannerActions;
}

export function renderLightbox({
  host,
  detail,
  index,
  isBlurred,
  actions,
}: LightboxProps): TemplateResult | typeof nothing {
  if (index == null || !detail.media[index]) return nothing;
  const media = detail.media[index];
  const location = host.config.imageLocation;
  const blurred = isBlurred(media);
  const count = detail.media.length;
  const step = (delta: number) => actions.setLightbox((index + delta + count) % count);
  return html`<civitai-modal
    size="lg"
    heading="${index + 1} / ${count}"
    .open=${true}
    @close=${() => actions.setLightbox(null)}
  >
    <div class="lightbox">
      ${media.type === 'video'
        ? html`<video
            class=${blurred ? 'blurred' : ''}
            controls
            autoplay
            muted
            loop
            playsinline
            src=${videoUrl(location, media.url, 1200)}
          ></video>`
        : media.type === 'audio'
        ? html`<p class="muted">Audio item · open the post to listen.</p>`
        : html`<img
            class=${blurred ? 'blurred' : ''}
            src=${mediaUrl(location, media.url, 1200)}
            alt=""
          />`}
      <div class="lightbox-bar">
        <civitai-button variant="subtle" size="sm" ?disabled=${count < 2} @click=${() => step(-1)}
          >‹ Previous</civitai-button
        >
        ${media.nsfwLevel > PG_LEVEL
          ? html`<civitai-button
              variant="outline"
              size="sm"
              @click=${() => actions.toggleUnblur(media.id)}
            >
              ${blurred ? 'Show' : 'Hide'}
            </civitai-button>`
          : nothing}
        <civitai-button variant="subtle" size="sm" ?disabled=${count < 2} @click=${() => step(1)}
          >Next ›</civitai-button
        >
      </div>
    </div>
  </civitai-modal>`;
}

/** The delivery URL for a playable video, the shape the main app's EdgeVideo builds. */
function videoUrl(imageLocation: string, key: string, width: number): string {
  const base = imageLocation.replace(/\/$/, '');
  return `${base}/${key}/anim=true,transcode=true,width=${width}/${key}.mp4`;
}

export const lightboxStyles = css`
  .lightbox {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .lightbox img,
  .lightbox video {
    max-width: 100%;
    max-height: 70vh;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-media-placeholder);
  }
  .lightbox .blurred {
    filter: blur(24px);
  }
  .lightbox-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
  }
`;
