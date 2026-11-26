package evalcorpus

import (
	"fmt"
	"regexp"
	"slices"
)

// Masks are, per endpoint, the paths of an answer known to differ between two correct answers to the
// same request (a timestamp taken at answer time, a random order, a count that moves under live
// traffic): a replay compares the two answers with these paths removed from both. Empty to start:
// a path is added only with the evidence that it is nondeterministic in Node itself (two Node answers
// to one request differ there), never because feed-go differs there.
//
// Format: a JSONPath subset, `$` then `.<name>` members and `[*]` for every element of an array,
// e.g. `$.json.items[*].stats.viewCountAllTime` (a tRPC answer is the superjson envelope, `json`
// then `meta`; a REST answer is the body itself). A name is letters, digits and `_`.
var Masks = map[string][]string{
	EndpointAsPosts:     {},
	EndpointInfinite:    {},
	EndpointModelGetAll: {},
	EndpointV1ModelsID:  {},
}

var maskPathRE = regexp.MustCompile(`^\$(\.[A-Za-z0-9_]+|\[\*\])+$`)

// ValidMaskPath reports whether p is in the Masks format.
func ValidMaskPath(p string) bool { return maskPathRE.MatchString(p) }

// MasksFor is the endpoint's mask paths (a copy); an endpoint with no entry is an error, so a new
// endpoint cannot replay without deciding its masks.
func MasksFor(endpoint string) ([]string, error) {
	m, ok := Masks[endpoint]
	if !ok {
		return nil, fmt.Errorf("evalcorpus: no masks entry for %q", endpoint)
	}
	return slices.Clone(m), nil
}
