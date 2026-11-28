package server

import (
	"net/http"
	"slices"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
)

// Selection is how one endpoint's two answers are compared: the body comparator, the classifier that
// turns its report into a result, and which response headers are compared. It is the one choice the
// shadow sample, the serve-side parity replay and the eval harness (internal/evalharness) all make,
// so a request the harness passes is one production would count as a match, and the reverse
// (DESIGN.md §19.8).
type Selection struct {
	// Endpoint is the endpoint label the selection is for.
	Endpoint string
	// Compare compares Go's body with Node's: a superjson envelope (`{json, meta}`, a tRPC answer's
	// `result.data`) or a REST endpoint's plain JSON body.
	Compare func(goBody, nodeBody []byte) (*shadow.Report, error)
	// Classify summarises Compare's report into one result (match, fields, order, membership).
	Classify func(r *shadow.Report, goBody, nodeBody []byte) string
	// REST: a REST port (plain JSON bodies, the REST header list when the sampler marks it).
	REST bool
}

// compareSelectionEndpoints is every endpoint CompareSelection has a rule for: the endpoints the
// shadow compares (TestCompareSelectionLedger pins this list to the pinned selections and to the
// shadowHandler call sites).
var compareSelectionEndpoints = []string{
	EndpointAsPosts, EndpointInfinite, EndpointModelGetAll, EndpointAssociated,
	EndpointV1Images, EndpointV1Models, EndpointV1ModelsID, EndpointSearch,
}

// HasCompareSelection reports whether endpoint is one CompareSelection was decided for, rather than
// one that would fall to its gallery default. A caller that compares on its own (the eval harness)
// refuses an endpoint without one.
func HasCompareSelection(endpoint string) bool {
	return slices.Contains(compareSelectionEndpoints, endpoint)
}

// CompareSelectionEndpoints is every endpoint HasCompareSelection accepts (a copy).
func CompareSelectionEndpoints() []string { return slices.Clone(compareSelectionEndpoints) }

// CompareSelection is the selection of endpoint. An endpoint with no rule of its own is compared as
// the gallery is (shadow.Compare, shadow.Classify).
//
//   - as-posts: Compare, Classify (posts keyed by postId)
//   - infinite, model-getall: Compare, ClassifyFlat (a flat page keyed by item id)
//   - model-associated: Compare, ClassifyArray (an array of cards keyed by id)
//   - v1-images: CompareV1Images (modelVersionIds as a multiset), ClassifyJSON
//   - v1-models: CompareJSON, ClassifyJSON
//   - v1-models-id: CompareJSON, ClassifyV1ModelID
//   - site-search: CompareSearch, ClassifySearch (a shadow sample's call-and-answer documents; a
//     serve-side parity replay's two answer bodies, from two backend calls)
func CompareSelection(endpoint string) Selection {
	sel := Selection{Endpoint: endpoint, Compare: shadow.Compare, Classify: shadow.Classify, REST: isRESTEndpoint(endpoint)}
	switch endpoint {
	case EndpointInfinite, EndpointModelGetAll:
		sel.Classify = shadow.ClassifyFlat
	case EndpointAssociated:
		sel.Classify = shadow.ClassifyArray
	case EndpointV1Images:
		sel.Compare, sel.Classify = shadow.CompareV1Images, shadow.ClassifyJSON
	case EndpointV1Models:
		sel.Compare, sel.Classify = shadow.CompareJSON, shadow.ClassifyJSON
	case EndpointV1ModelsID:
		sel.Compare, sel.Classify = shadow.CompareJSON, ClassifyV1ModelID
	case EndpointSearch:
		sel.Compare, sel.Classify = CompareSearch, ClassifySearch
	}
	return sel
}

// HeaderNames is the response headers compared for a sample whose headers were picked from the list
// headerSet names (ShadowRequest.ResponseHeaderSet): shadow.ComparedHeaders, or on a REST endpoint
// with headerSet ResponseHeaderSetREST the REST list (SearchComparedHeaders for site-search).
func (s Selection) HeaderNames(headerSet string) []string {
	if !s.REST || headerSet != ResponseHeaderSetREST {
		return shadow.ComparedHeaders
	}
	if s.Endpoint == EndpointSearch {
		return SearchComparedHeaders
	}
	return shadow.RESTComparedHeaders
}

// HeaderSet is the header list a sampler of this endpoint picks today: ResponseHeaderSetREST on a
// REST endpoint, "" (shadow.ComparedHeaders) on a tRPC one. The harness, which picks both answers'
// headers itself, uses it.
func (s Selection) HeaderSet() string {
	if s.REST {
		return ResponseHeaderSetREST
	}
	return ""
}

// PickResponseHeaders is what the Node sampler sends as a sample's responseHeaders
// (pickShadowResponseHeaders) over the names list: each named header lowercased, several values
// joined with ", ", each value cut at 1024 characters, an empty one left out, Set-Cookie as the
// literal `present`.
func PickResponseHeaders(h http.Header, names []string) map[string]string {
	out := map[string]string{}
	for _, name := range names {
		v := strings.Join(h.Values(name), ", ")
		if v == "" {
			// An empty value is absent, Set-Cookie included (as the Node sampler reads it).
			continue
		}
		if name == "set-cookie" {
			out[name] = "present"
			continue
		}
		if len(v) > maxComparedHeaderValue {
			v = v[:maxComparedHeaderValue]
		}
		out[name] = v
	}
	return out
}
