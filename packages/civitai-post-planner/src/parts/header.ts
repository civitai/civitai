import { css, html, nothing, type TemplateResult } from 'lit';
import type { PlannerHost } from '../host.js';

export interface HeaderProps {
  host: PlannerHost;
  scheduledCount: number;
  dailyLimit: number | null;
}

export function renderHeader({ host, scheduledCount, dailyLimit }: HeaderProps): TemplateResult {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = [
    `${scheduledCount} queued in view`,
    dailyLimit != null ? `${dailyLimit}/day limit` : null,
    zone,
  ].filter(Boolean);
  const composer = host.config.composerAvailable && host.composerUrl;
  return html`
    <header class="top">
      <div>
        <h1>Scheduled posts</h1>
        <div class="stat">${parts.join(' · ')}</div>
      </div>
      ${composer
        ? html`<civitai-button variant="filled" href=${host.composerUrl!({})}
            >+ Schedule a batch</civitai-button
          >`
        : nothing}
    </header>
  `;
}

export const headerStyles = css`
  header.top {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--pp-gap);
  }
  header.top h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    line-height: 1.2;
  }
  .stat {
    color: var(--civitai-color-text-dimmed);
    font-size: 13px;
  }
  @media (max-width: 767px) {
    header.top h1 {
      font-size: 20px;
    }
  }
`;
