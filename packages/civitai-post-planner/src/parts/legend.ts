import { css, html, type TemplateResult } from 'lit';

export function renderLegend(): TemplateResult {
  return html`<div class="legend">
    <span class="scheduled"><i></i>scheduled</span>
    <span class="release"><i></i>release — moves with its model</span>
    <span class="published"><i></i>published</span>
  </div>`;
}

export const legendStyles = css`
  .legend {
    display: flex;
    gap: 16px;
    color: var(--civitai-color-text-dimmed);
    font-size: 12px;
  }
  .legend i {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    margin-right: 6px;
    vertical-align: -1px;
  }
  .legend .scheduled i {
    background: var(--civitai-color-primary);
  }
  .legend .release i {
    background: var(--civitai-color-warning);
  }
  .legend .published i {
    border: 1px solid var(--civitai-color-gray-5);
  }
`;
