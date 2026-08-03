import { useDebouncedValue } from '@mantine/hooks';
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import type { MetaSuggestions } from '~/components/Apps/ListingAssetStep';
import {
  computeAutofillStatus,
  type ListingAutofillResult,
} from '~/components/Apps/listingAutofillStatus';
import {
  OFFSITE_SUBMIT_LIMITS,
  normalizeLinkUrl,
  type OffsiteSubmitFormValues,
} from '~/components/Apps/offsiteSubmitFormConfig';
import type { ListingMetaSuggestion } from '~/server/utils/og-metadata';
import { trpc } from '~/utils/trpc';

/**
 * App Store Listings (W13) — the SHARED external-listing autofill hook, consumed by
 * both the CREATE (`ExternalSubmitForm`) and EDIT (`ExternalListingEditForm`) wizards.
 * It replaces the duplicated auto-pull logic (and the removed manual "Pull from site"
 * / "Autofill from website" buttons) with ONE auto-triggering core:
 *
 *   - AUTO-TRIGGER: fires the SSRF-safe `fetchListingMetaFromUrl` query when the
 *     external-URL field holds a valid https URL — on blur/Enter/step-advance
 *     (`triggerFromUrl`) AND on a debounced change (`debounceMs`). It fires at most
 *     ONCE per distinct normalized URL (`firedUrlRef`) and re-fires when the URL
 *     changes to a new valid URL. Invalid/empty URLs never fire.
 *   - FILL-IF-EMPTY apply: name / tagline / description are filled ONLY when empty,
 *     so a field the author has edited is never clobbered. CREATE prefers the page
 *     `<title>` and falls back to a host-derived name (`nameFallbackRef`).
 *   - SUGGESTIONS: the `{ coverImageUrl, iconImageUrl, iconDataUri }` object handed
 *     to `ListingAssetStep` for its accept-suggestion tiles.
 *   - STATUS: the four-state note (applied / partial / empty / error) via the pure
 *     `computeAutofillStatus`, honest about what the SITE exposed vs. what was
 *     actionable (never "already filled" when the pull genuinely found nothing).
 *   - REPULL: `repull()` — the manual retry (the assets-step "Re-pull from site"
 *     button), re-runs the query for the current URL even when unchanged.
 *
 * Form-specific field wiring (which setters to call, host-name fallback, whether an
 * asset slot is empty, URL-side effects like slug derivation) is injected via params
 * so both forms reuse the identical core.
 */

export type UseListingAutofillParams = {
  /** The raw (unnormalized) external-URL form value — drives the debounced auto-trigger. */
  externalUrl: string;
  /** Form setter — the apply effect fills empty name/tagline/description through it. */
  setValues: Dispatch<SetStateAction<OffsiteSubmitFormValues>>;
  /**
   * Ref to the latest form values. The apply effect reads pre-apply emptiness from
   * here (its own `setValues` updater hasn't committed when the note is computed).
   */
  valuesRef: MutableRefObject<OffsiteSubmitFormValues>;
  /**
   * CREATE only: host-derived fallback name, used to fill an empty Name when the page
   * exposes no `<title>`. Omit for EDIT (no fallback — an empty name stays empty).
   */
  nameFallbackRef?: MutableRefObject<string>;
  /**
   * Whether an icon/cover suggestion is ACTIONABLE right now — i.e. its asset slot is
   * empty (a suggestion for an already-filled slot is not actionable, so it must not
   * count toward an "applied"/"partial" note). CREATE → always true (every slot starts
   * empty); EDIT → depends on the prefill/attached state. Default: always actionable.
   */
  isSuggestionActionable?: (kind: 'icon' | 'cover') => boolean;
  /**
   * Optional side effect run right before an actual fire, with the normalized URL —
   * CREATE uses it to canonicalize the URL field + derive the slug + stash the
   * host-name fallback; EDIT uses it to canonicalize the URL field.
   */
  onBeforeFire?: (normalizedUrl: string) => void;
  /**
   * A pre-existing URL (EDIT prefill) that should NOT auto-fire on mount — only a
   * CHANGE to a new URL (or an explicit `repull`) fires. Seeds the once-per-url guard.
   */
  initialUrl?: string;
  /** Debounced-change trigger delay (default 600ms). */
  debounceMs?: number;
};

export type UseListingAutofillReturn = {
  /** The `{ coverImageUrl, iconImageUrl, iconDataUri }` suggestions for ListingAssetStep. */
  suggestions: MetaSuggestions;
  /** True while the CURRENT pull's fetch is in flight (drives the loading note + button spinner). */
  loading: boolean;
  /** The settled four-state result of the last pull (null before any pull settles). */
  result: ListingAutofillResult | null;
  /** CREATE Details "we found these details" reveal — sticky once any pull applied something. */
  applied: boolean;
  /**
   * Normalize `raw` and, if it's a valid https URL, fire an auto-pull (once per distinct
   * URL). Returns the normalize error (if any) so the form can surface it. Used on blur,
   * Enter, and step-advance.
   */
  triggerFromUrl: (raw: string) => { error?: string };
  /** Manual re-pull of the CURRENT url — the assets-step "Re-pull from site" button + retries. */
  repull: () => void;
  /** Clear the transient status note (e.g. the user is editing the URL again). */
  clearNote: () => void;
};

export function useListingAutofill(params: UseListingAutofillParams): UseListingAutofillReturn {
  const {
    externalUrl,
    setValues,
    valuesRef,
    nameFallbackRef,
    isSuggestionActionable,
    onBeforeFire,
    initialUrl,
    debounceMs = 600,
  } = params;

  const [metaUrl, setMetaUrl] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<MetaSuggestions>({});
  const [result, setResult] = useState<ListingAutofillResult | null>(null);
  const [applied, setApplied] = useState(false);
  const [pullActive, setPullActive] = useState(false);
  const [autofillTick, setAutofillTick] = useState(0);

  // Once-per-distinct-url guard. Seeded from an EDIT prefill so the existing URL does
  // NOT auto-fire on mount (only a change / explicit repull does).
  const firedUrlRef = useRef<string | null>(
    initialUrl ? normalizeLinkUrl(initialUrl).url || null : null
  );
  // Apply-effect idempotency: reset to null on each fire so the effect re-applies.
  const appliedMetaRef = useRef<string | null>(null);
  // Latest raw URL for repull() (reads current, not the render-captured, value).
  const externalUrlRef = useRef(externalUrl);
  externalUrlRef.current = externalUrl;

  const metaQuery = trpc.appListings.fetchListingMetaFromUrl.useQuery(
    { url: metaUrl ?? '' },
    { enabled: !!metaUrl, retry: false, refetchOnWindowFocus: false, staleTime: Infinity }
  );

  function fire(normalizedUrl: string, opts: { force: boolean }) {
    if (!opts.force && firedUrlRef.current === normalizedUrl) return;
    firedUrlRef.current = normalizedUrl;
    onBeforeFire?.(normalizedUrl);
    setResult(null);
    setPullActive(true);
    // Force the idempotent apply effect to re-run for this fire.
    appliedMetaRef.current = null;
    if (normalizedUrl === metaUrl) {
      // Same url: `setMetaUrl` is a no-op and (staleTime:Infinity + retry:false) the
      // cached success/error won't re-fetch on its own. `refetch()` re-attempts; the
      // tick below re-runs the apply effect once it settles. No loop: `refetch()`
      // flips `isFetching` true synchronously, so the tick-driven run bails on the
      // isFetching guard and only applies once the (re)fetch settles.
      void metaQuery.refetch();
    } else {
      setMetaUrl(normalizedUrl);
    }
    setAutofillTick((t) => t + 1);
  }

  function triggerFromUrl(raw: string): { error?: string } {
    const r = normalizeLinkUrl(raw);
    if (r.error) return { error: r.error };
    fire(r.url, { force: false });
    return {};
  }

  function repull() {
    const r = normalizeLinkUrl(externalUrlRef.current);
    if (r.error) return; // a bad/blank URL never fires (the button is also disabled)
    fire(r.url, { force: true });
  }

  function clearNote() {
    setResult(null);
  }

  // Debounced-change auto-trigger: once the user pauses typing on a valid https URL,
  // fire the pull (once per distinct URL). Invalid/empty URLs never fire.
  const [debouncedUrl] = useDebouncedValue(externalUrl, debounceMs);
  useEffect(() => {
    const r = normalizeLinkUrl(debouncedUrl);
    if (r.error) return;
    fire(r.url, { force: false });
    // Intentionally keyed only on the debounced URL — `fire` is idempotent per URL via
    // `firedUrlRef`, so re-running on unrelated renders is a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedUrl]);

  // Apply the settled pull ONCE per url (fill-if-empty text + suggestions + note).
  useEffect(() => {
    if (!metaUrl || appliedMetaRef.current === metaUrl) return;
    if (metaQuery.isFetching) return;
    const data = metaQuery.data as ListingMetaSuggestion | undefined;
    const settled = !!data || metaQuery.isError;
    if (!settled) return;
    appliedMetaRef.current = metaUrl;
    const errored = metaQuery.isError && !data;

    // Snapshot pre-apply emptiness for the note (the async setValues below hasn't
    // committed yet). Fill-if-empty runs in BOTH the success AND error case: on error
    // there is no `data`, so only the host-derived name fallback (CREATE) can fill an
    // empty Name — so an errored pull never leaves Name blank on create.
    const before = valuesRef.current;
    const fallbackName = nameFallbackRef?.current ?? '';
    const resolvedName = data?.name || fallbackName;

    setValues((v) => ({
      ...v,
      name: v.name.trim().length === 0 && resolvedName ? resolvedName : v.name,
      tagline: v.tagline.trim().length === 0 && data?.tagline ? data.tagline : v.tagline,
      description:
        v.description.trim().length === 0 && data?.description
          ? data.description.slice(0, OFFSITE_SUBMIT_LIMITS.descriptionMax)
          : v.description,
    }));
    // ERROR-settled: drop stale suggestions + surface the error note (after the name
    // fallback fill above).
    setSuggestions(
      errored
        ? {}
        : {
            coverImageUrl: data?.coverImageUrl,
            iconImageUrl: data?.iconImageUrl,
            iconDataUri: data?.iconDataUri,
          }
    );
    if (errored) {
      setResult({ status: 'error' });
      setPullActive(false);
      return;
    }

    // Sticky "we found details" reveal — only what the SITE exposed counts (NOT the
    // host-derived name fallback, which is derived from the URL, not pulled).
    if (
      data &&
      (data.name ||
        data.tagline ||
        data.description ||
        data.coverImageUrl ||
        data.iconImageUrl ||
        data.iconDataUri)
    ) {
      setApplied(true);
    }

    // Four-state note. "filled a text field" counts ONLY the site-exposed value into an
    // empty field; an actionable asset = a suggestion for a currently-empty slot.
    const actionable = (kind: 'icon' | 'cover') => isSuggestionActionable?.(kind) ?? true;
    const filledText =
      (before.name.trim().length === 0 && !!data?.name) ||
      (before.tagline.trim().length === 0 && !!data?.tagline) ||
      (before.description.trim().length === 0 && !!data?.description);
    const iconActionable = (!!data?.iconImageUrl || !!data?.iconDataUri) && actionable('icon');
    const coverActionable = !!data?.coverImageUrl && actionable('cover');
    setResult(
      computeAutofillStatus({
        errored: false,
        data,
        actioned: { filledText, suggestedAsset: iconActionable || coverActionable },
      })
    );
    setPullActive(false);
    // `autofillTick` is a dep so a same-url repull re-runs this effect from cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaUrl, metaQuery.data, metaQuery.isError, metaQuery.isFetching, autofillTick]);

  return {
    suggestions,
    loading: pullActive && metaQuery.isFetching,
    result,
    applied,
    triggerFromUrl,
    repull,
    clearNote,
  };
}
