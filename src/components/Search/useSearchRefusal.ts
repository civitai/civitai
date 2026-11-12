import { useEffect, useMemo } from 'react';
import { getSearchRefusal } from '~/components/Search/search-refusal';
import type { SearchRefusal } from '~/components/Search/search-refusal';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { useBenignPhrases } from '~/hooks/useBenignPhrases';
import { useCheckProfanity } from '~/hooks/useCheckProfanity';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';

/**
 * Why a search text that did not come through the search bar (a link, a bookmark, a redirect) must
 * not be searched, with the same checks and tracking the search pages apply.
 */
export function useSearchRefusal(
  text: string | undefined,
  index?: string
): { refusal?: SearchRefusal; profanityMatches: string[] } {
  const benignPhrases = useBenignPhrases();
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const domainColor = useDomainColor();
  const { trackAction } = useTrackEvent();

  const checked = useMemo(
    () =>
      text
        ? getSearchRefusal({
            text,
            auditedText: benignPhrases.strip(text),
            disablePoi: !!browsingSettingsAddons.settings.disablePoi,
          })
        : undefined,
    [text, benignPhrases, browsingSettingsAddons.settings.disablePoi]
  );
  const profanity = useCheckProfanity(text ?? '', {
    enabled: domainColor === 'green' && !!text && checked !== 'illegal',
  });
  const refusal = checked === 'illegal' ? checked : profanity.hasProfanity ? 'profanity' : checked;

  useEffect(() => {
    // Not before the benign phrases arrive: until then a whitelisted query still reads as illegal.
    if (!text || refusal !== 'illegal' || !benignPhrases.settled) return;
    trackAction({ type: 'CSAM_Help_Triggered', details: { query: text, index } }).catch(
      () => undefined
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, refusal, benignPhrases.settled]);

  useEffect(() => {
    if (!text || refusal !== 'profanity') return;
    trackAction({
      type: 'ProfanitySearch',
      details: { query: text, index, matches: profanity.matches },
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, refusal]);

  return { refusal, profanityMatches: profanity.matches };
}
