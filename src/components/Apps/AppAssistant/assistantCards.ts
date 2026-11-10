/** The look the App Assistant's confirm cards share (submit, feedback status, cover). */

export const CARD_STYLE =
  'border:1px solid var(--civitai-color-border, #8884);border-radius:8px;padding:8px 12px;margin:4px 0';
export const BUTTON_STYLE =
  'min-height:44px;margin-top:8px;padding:0 16px;border-radius:6px;border:0;cursor:pointer;font:inherit;font-weight:600;color:#fff;background:var(--civitai-color-primary, #228be6)';
export const SECONDARY_STYLE =
  'min-height:44px;margin-top:8px;padding:0 16px;border-radius:6px;border:1px solid var(--civitai-color-border, #8884);cursor:pointer;font:inherit;background:transparent;color:inherit';

/** One line of a card: `textContent` only, so text from the assistant is never markup. */
export function line(text: string, role: 'status' | 'alert' | null = null): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = text;
  if (role) el.setAttribute('role', role);
  return el;
}
