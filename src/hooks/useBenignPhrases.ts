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
  // Finite staleTime, deliberately. The reason a moderator DELETES a benign phrase is that it
  // stripped too much — under `staleTime: Infinity` that deletion never reaches an open tab,
  // so a revocation had no propagation bound at all while an addition was capped at the
  // edge's hour.
  const { data, isFetched } = trpc.system.getBenignPhrases.useQuery(undefined, {
    staleTime: 60 * 60 * 1000,
    gcTime: Infinity,
  });

  const promptPattern = useMemo(() => buildBenignPhraseRegex(data?.prompt ?? []), [data?.prompt]);
  const profanityWords = data?.profanityWords;

  return useMemo(
    () => ({
      profanityWords: profanityWords ?? [],
      /**
       * Whether the fetch has SETTLED — not whether it succeeded. Until it settles, `strip` is
       * the identity function and the gates judge the RAW query; that direction is safe (they
       * flag more, not less), but a caller with a side effect — a tracking event, a report —
       * should wait, since firing one for a phrase a moderator whitelisted is the thing this
       * exists to stop.
       *
       * On `isSuccess` this would stay false forever after a failed fetch, silently
       * suppressing that side effect for the life of the session. A failed fetch means there
       * IS no whitelist, which is exactly when there is no reason to withhold.
       */
      settled: isFetched,
      /** Blank whitelisted phrases before a detection check — never for display or query. */
      strip: (text: string | undefined) => stripBenignPhrasesWith(text, promptPattern),
    }),
    [promptPattern, profanityWords, isFetched]
  );
}
