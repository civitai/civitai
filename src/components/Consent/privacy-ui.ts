import { create } from 'zustand';

/** IAB CMP ids, as reported by `__tcfapi('ping')`. */
export const ADMIRAL_CMP_ID = 9;

export type PrivacySignals = {
  cmpId: number | null;
  gdprApplies: boolean | null;
  /** IAB US Privacy string, e.g. `1YNN`; `1---` means no US privacy law applies. */
  uspString: string | null;
  /** GPP section ids; `[-1]` or `[0]` means none apply. */
  gppSections: number[] | null;
};

export function privacyLawApplies({ gdprApplies, uspString, gppSections }: PrivacySignals) {
  if (gdprApplies) return true;
  if (uspString && uspString.length >= 2 && uspString[1] !== '-') return true;
  return !!gppSections?.some((section) => section > 0);
}

/** Admiral's footer link and floating button only work while Admiral is the active CMP, and only
 *  matter where a privacy law applies. */
export function shouldShowPrivacyUi(signals: PrivacySignals) {
  return signals.cmpId === ADMIRAL_CMP_ID && privacyLawApplies(signals);
}

export const usePrivacyUiStore = create<{ visible: boolean }>(() => ({ visible: false }));

type CmpWindow = Window & {
  __tcfapi?: (command: string, version: number, callback: (data: any) => void) => void;
  __uspapi?: (command: string, version: number, callback: (data: any) => void) => void;
  __gpp?: (command: string, callback: (data: any) => void) => void;
};

const ask = <T>(call: (callback: (data: T) => void) => void, timeoutMs = 1000) =>
  new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      call((data) => {
        clearTimeout(timer);
        resolve(data ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });

/** Gives up after `attempts` polls, leaving the UI hidden. */
export function detectPrivacyUi({ intervalMs = 500, attempts = 60 } = {}) {
  const win = window as CmpWindow;
  let cancelled = false;

  (async () => {
    for (let i = 0; i < attempts && !cancelled; i++) {
      const ping = win.__tcfapi
        ? await ask<{ cmpLoaded?: boolean; cmpId?: number; gdprApplies?: boolean }>((cb) =>
            win.__tcfapi?.('ping', 2, cb)
          )
        : null;
      if (ping?.cmpLoaded) {
        const usp = win.__uspapi
          ? await ask<{ uspString?: string }>((cb) => win.__uspapi?.('getUSPData', 1, cb))
          : null;
        const gpp = win.__gpp
          ? await ask<{ applicableSections?: number[] }>((cb) => win.__gpp?.('ping', cb))
          : null;
        if (cancelled) return;
        const visible = shouldShowPrivacyUi({
          cmpId: ping.cmpId ?? null,
          gdprApplies: ping.gdprApplies ?? null,
          uspString: usp?.uspString ?? null,
          gppSections: gpp?.applicableSections ?? null,
        });
        usePrivacyUiStore.setState({ visible });
        // Read by globals.css, which hides Admiral's own injected link and button.
        document.documentElement.dataset.privacyUi = visible ? 'visible' : 'hidden';
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();

  return () => {
    cancelled = true;
  };
}
