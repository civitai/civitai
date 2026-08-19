import { useMemo } from 'react';
import { buildBenignPhraseRegex, stripBenignPhrasesWith } from '~/shared/utils/benign-phrases';
import { trpc } from '~/utils/trpc';

/**
 * The moderator benign lists, for gates that run in the browser. Search queries Meili
 * from the client, so the POI / minor / profanity checks there have no server hop to
 * strip on — see `getClientBenignLists`. Edge-cached for an hour server-side and held
 * indefinitely per session, so a moderator edit reaches a search box within the hour.
 */
export function useBenignPhrases() {
  const { data, isSuccess } = trpc.system.getBenignPhrases.useQuery(undefined, {
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const promptPattern = useMemo(() => buildBenignPhraseRegex(data?.prompt ?? []), [data?.prompt]);
  const profanityWords = data?.profanityWords;

  return useMemo(
    () => ({
      profanityWords: profanityWords ?? [],
      /**
       * False until the lists arrive, during which `strip` is the identity function and the
       * gates therefore judge the RAW query. That direction is safe — they flag more, not
       * less — but a caller with a side effect (a tracking event, a report) should wait,
       * because firing one for a phrase a moderator has whitelisted is the thing this exists
       * to stop.
       */
      loaded: isSuccess,
      /** Blank whitelisted phrases before a detection check — never for display or query. */
      strip: (text: string | undefined) => stripBenignPhrasesWith(text, promptPattern),
    }),
    [promptPattern, profanityWords, isSuccess]
  );
}
