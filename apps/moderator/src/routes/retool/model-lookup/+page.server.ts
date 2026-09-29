import type { PageServerLoad } from './$types';
import { lookupQuerySchema, parseQuery } from '$lib/server/query';
import { getModelLookup, resolveModelRefLive } from '$lib/server/model-lookup.service';

// Read-only: model actions live on the main-app model page and Bulk Image Manager, and a copy here
// would be a second write path per action.
export const load: PageServerLoad = async ({ url }) => {
  const { q } = parseQuery(url, lookupQuerySchema);

  // `?mv=` is the UNAMBIGUOUS version entry point, and it exists because `q` cannot be: a bare number is
  // a valid model id AND a valid version id across most of the range, so a link that means "this
  // version" has to say so out of band. Expressed as the term shape the resolver already recognises
  // rather than as a second resolution path that could disagree with it.
  const mv = url.searchParams.get('mv')?.trim() ?? '';
  const term = /^\d+$/.test(mv) ? `/model-versions/${mv}` : q;

  if (!term)
    return {
      q,
      mv,
      result: null,
      highlightVersionId: null,
      resolvedFromVersion: null,
      alsoAVersion: null,
      notFound: false,
    };

  const ref = await resolveModelRefLive(term);
  const result = ref ? await getModelLookup(ref.modelId) : null;

  return {
    // NOT the `?mv=` id. `LookupSearch` replaces the whole query string on submit, so echoing it here
    // would turn `?mv=5` into `?q=5` — which resolves model-first and can land on a different row.
    q: mv ? '' : q,
    mv,
    result,
    highlightVersionId: ref?.versionId ?? null,
    resolvedFromVersion: ref?.resolvedFromVersion ?? null,
    alsoAVersion: ref?.alsoAVersion ?? null,
    notFound: !result,
  };
};
