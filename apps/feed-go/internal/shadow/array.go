package shadow

import "encoding/json"

// arrayItemIDs returns the `json[].id` sequence of a superjson envelope whose value is an array of
// objects keyed by their own `id` (model.getAssociatedResourcesCardData's cards).
func arrayItemIDs(env []byte) ([]string, error) {
	var e struct {
		JSON []struct {
			ID json.Number `json:"id"`
		} `json:"json"`
	}
	if err := json.Unmarshal(env, &e); err != nil {
		return nil, err
	}
	out := make([]string, len(e.JSON))
	for i, it := range e.JSON {
		out[i] = it.ID.String()
	}
	return out, nil
}

// ClassifyArray is ClassifyFlat for an envelope whose value is the array itself (no `items`):
// match, order (same ids, different order), membership (different ids), fields (same ids in the same
// order, field differences). Categories are Compare's over the array (`*.<field>`).
func ClassifyArray(r *Report, goEnv, nodeEnv []byte) string {
	if r.Match {
		return "match"
	}
	g, errG := arrayItemIDs(goEnv)
	n, errN := arrayItemIDs(nodeEnv)
	if errG != nil || errN != nil {
		return "fields"
	}
	return classifyOrder(g, n)
}
