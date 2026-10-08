import { css } from 'lit';

// Everything here reads `--civitai-*` tokens only, so a theme change in @civitai/theme reaches the
// planner without a code change. Layout values that are not tokens are local custom properties.
export const plannerStyles = css`
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

  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface-2);
    border: 1px solid var(--civitai-color-border);
  }

  /* Month grid */
  .weekdays,
  .grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }
  .weekdays div {
    padding: 4px 8px;
    color: var(--civitai-color-text-dimmed);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .grid {
    gap: 6px;
  }
  .grid .week {
    display: contents;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .cell {
    position: relative;
    container-type: inline-size;
    min-height: var(--pp-cell-min);
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface);
    border: 1px solid var(--civitai-color-border);
    transition: border-color 120ms, background 120ms;
  }
  .cell.out {
    opacity: 0.55;
  }
  .cell.today {
    border-color: var(--civitai-color-primary);
  }
  .cell.over {
    border-color: var(--civitai-color-primary);
    background: color-mix(in srgb, var(--civitai-color-primary) 10%, var(--civitai-color-surface));
  }
  .cell-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-height: 22px;
  }
  .cell-head .num {
    font-weight: 600;
    font-size: 13px;
  }
  .cell.today .num {
    color: var(--civitai-color-primary);
  }
  .cell .quick-add {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--civitai-color-primary);
    font-size: 22px;
    opacity: 0;
    transition: opacity 120ms;
  }
  .cell:hover .quick-add,
  .cell:focus-within .quick-add {
    opacity: 1;
  }
  .more {
    color: var(--civitai-color-primary);
    font-size: 12px;
    font-weight: 600;
    padding: 2px 4px;
  }

  /* Chips */
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    padding: 3px 6px 3px 4px;
    border-radius: 6px;
    border: 1px solid var(--civitai-color-border);
    border-left: 3px solid var(--civitai-color-primary);
    background: var(--civitai-color-surface-2);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    user-select: none;
  }
  .chip:hover {
    border-color: var(--civitai-color-primary);
  }
  .chip.release {
    border-left-color: var(--civitai-color-warning);
  }
  .chip.published {
    border-left-color: var(--civitai-color-gray-5);
    color: var(--civitai-color-text-dimmed);
    cursor: default;
  }
  .chip.pending {
    opacity: 0.5;
  }
  .chip.dragging {
    opacity: 0.4;
  }
  .chip.selected {
    outline: 2px solid var(--civitai-color-primary);
    outline-offset: 1px;
  }
  .chip[draggable='true'] {
    cursor: grab;
  }
  .chip .time {
    flex: none;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    white-space: nowrap;
  }
  /* Cells shed detail as they narrow: first the item count, then the thumbnail and handle, so the
     time is the last thing standing. */
  @container (max-width: 190px) {
    .chip .count {
      display: none;
    }
  }
  @container (max-width: 120px) {
    .chip .thumb,
    .chip .handle {
      display: none;
    }
  }
  .chip .count {
    flex: 1 1 auto;
    color: var(--civitai-color-text-dimmed);
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .chip .rocket {
    color: var(--civitai-color-warning);
    flex: none;
  }
  .chip .handle {
    margin-left: auto;
    color: var(--civitai-color-text-dimmed);
    opacity: 0;
  }
  .chip:hover .handle {
    opacity: 1;
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

  /* Agenda / list rows */
  .day-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .day-group h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--civitai-color-text-dimmed);
  }
  .row {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface);
    border: 1px solid var(--civitai-color-border);
    border-left: 3px solid var(--civitai-color-primary);
    cursor: pointer;
  }
  .row.release {
    border-left-color: var(--civitai-color-warning);
  }
  .row.published {
    border-left-color: var(--civitai-color-gray-5);
    color: var(--civitai-color-text-dimmed);
  }
  .row.selected {
    outline: 2px solid var(--civitai-color-primary);
  }
  .row {
    min-width: 0;
    overflow: hidden;
  }
  .row .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .row .meta .line {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .row .time {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .loading {
    min-height: 320px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
  }
  .empty {
    padding: 24px;
    text-align: center;
    color: var(--civitai-color-text-dimmed);
    border: 1px dashed var(--civitai-color-border);
    border-radius: var(--civitai-radius);
  }

  /* Drawer */
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
  .muted {
    color: var(--civitai-color-text-dimmed);
    font-size: 12px;
  }

  .bulk-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--civitai-radius);
    background: var(--civitai-color-surface-2);
    border: 1px solid var(--civitai-color-border);
    position: sticky;
    bottom: 8px;
  }

  @media (max-width: 1023px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
    }
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
  @media (max-width: 767px) {
    :host {
      --pp-cell-min: 96px;
    }
    header.top h1 {
      font-size: 20px;
    }
  }
`;
