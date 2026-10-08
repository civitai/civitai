import { html, type TemplateResult } from 'lit';
import type { PlannerMedia } from '../host.js';

/** Cloudflare Images delivery URL for a media key at a given width. */
export function mediaUrl(imageLocation: string, key: string, width: number): string {
  const base = imageLocation.replace(/\/$/, '');
  return `${base}/${key}/width=${width}`;
}

/** Everything above PG counts as mature for the toggle; the viewer's browsing level still caps what
 *  "Show mature" reveals, so a per-image unblur is the only way past it. */
export const PG_LEVEL = 1;

export function shouldBlur(
  nsfwLevel: number,
  browsingLevel: number,
  showMature: boolean,
  unblurred: boolean
): boolean {
  if (unblurred || nsfwLevel <= PG_LEVEL) return false;
  return !showMature || nsfwLevel > browsingLevel;
}

export const eyeIcon = (open: boolean): TemplateResult =>
  open
    ? html`<svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>`
    : html`<svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 3l18 18" />
        <path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" />
        <path d="M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.4 17.4 0 0 1-3.2 4.2" />
        <path d="M6.6 6.6C3.9 8.5 2 12 2 12s3.5 7 10 7c1.6 0 3-.3 4.3-.9" />
      </svg>`;

export const rocketIcon = html`<svg
  class="rocket"
  width="12"
  height="12"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2.2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M4 13a8 8 0 0 1 7-7 8 8 0 0 1 9 9 8 8 0 0 1-7 7l-2-5-5-2 0-2Z" />
  <path d="M15 9l-5 5" />
</svg>`;

export const handleIcon = html`<svg
  class="handle"
  width="10"
  height="14"
  viewBox="0 0 10 14"
  fill="currentColor"
  aria-hidden="true"
>
  <circle cx="2.5" cy="2" r="1.4" />
  <circle cx="7.5" cy="2" r="1.4" />
  <circle cx="2.5" cy="7" r="1.4" />
  <circle cx="7.5" cy="7" r="1.4" />
  <circle cx="2.5" cy="12" r="1.4" />
  <circle cx="7.5" cy="12" r="1.4" />
</svg>`;

export function thumb(opts: {
  imageLocation: string;
  media: Pick<PlannerMedia, 'url' | 'type'> | null;
  blurred: boolean;
  large?: boolean;
}): TemplateResult {
  const cls = `thumb${opts.large ? ' lg' : ''}${opts.blurred ? ' blurred' : ''}`;
  if (!opts.media || opts.media.type === 'audio') return html`<span class=${cls}></span>`;
  // Cloudflare serves a poster frame for a video key when asked for a static width.
  return html`<img
    class=${cls}
    src=${mediaUrl(opts.imageLocation, opts.media.url, opts.large ? 96 : 48)}
    alt=""
    loading="lazy"
  />`;
}
