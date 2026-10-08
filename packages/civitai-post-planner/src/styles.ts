import { css } from 'lit';

// Everything here and in the per-part stylesheets reads `--civitai-*` tokens only, so a theme change
// in @civitai/theme reaches the planner without a code change. Layout values that are not tokens are
// local custom properties.
export const baseStyles = css`
  :host {
    --pp-gap: 12px;
    --pp-cell-min: 132px;
    --pp-drawer-width: 420px;
    display: block;
    color: var(--civitai-color-text);
    font-family: var(--civitai-font);
    font-size: 14px;
    line-height: 1.4;
  }
  * {
    box-sizing: border-box;
  }
  a {
    color: var(--civitai-color-primary);
    text-decoration: none;
  }
  button.plain {
    all: unset;
    cursor: pointer;
  }

  .shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--pp-gap);
    align-items: start;
  }
  .shell.with-drawer {
    --pp-cell-min: 112px;
  }
  .main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--pp-gap);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .more {
    color: var(--civitai-color-primary);
    font-size: 12px;
    font-weight: 600;
    padding: 2px 4px;
  }

  .thumb {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    background: var(--civitai-color-media-placeholder);
    object-fit: cover;
    overflow: hidden;
  }
  .thumb.lg {
    width: 44px;
    height: 44px;
    border-radius: 6px;
  }
  .blurred {
    filter: blur(6px);
    clip-path: inset(0 round 4px);
  }
  .muted {
    color: var(--civitai-color-text-dimmed);
    font-size: 12px;
  }

  @media (max-width: 1023px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 767px) {
    :host {
      --pp-cell-min: 96px;
    }
  }
`;
