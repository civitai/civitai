// Full-height for a playground tab's panel row: viewport minus header/footer and the Tabs bar.
// Shared by both tabs (PlaygroundPage judges row + CategoriesPanel) so they line up and can't drift.
export const PLAYGROUND_PANEL_HEIGHT =
  'calc(100vh - var(--header-height) - var(--footer-height) - 110px)';
