package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
)

// The serve-side parity replay of `POST /api/search/*` (DESIGN.md §7.2, §18.6). A sampled served
// search is replayed to the Node app the route hands back to (SearchUpstream), POST with the served
// request's path, body and headers (its session cookie, Host and edge headers: what the answer
// depended on). The replay can only compare the two ANSWERS: Node's response carries no search call,
// so the shadow's `{upstream, body}` document is not available; and the two answers come from two
// backend calls at different instants (CompareSearch, classifySearchBodies).

// sampleSearchParity is sampleParity for a served search: the replay also carries the request's body
// (the buffered copy the compute read) and the rate-limit window the request was counted in. Call it
// before c is released. nil when not sampled.
func (s *Server) sampleSearchParity(r *http.Request, c *computed, charge *searchCharge) *parityReplay {
	rep := s.sampleParity(r, EndpointSearch, c, nil)
	if rep == nil {
		return nil
	}
	rep.body, _ = r.Context().Value(searchBodyKey{}).([]byte)
	rep.rateKey = charge.key
	return rep
}

// refundReplayCharge keeps a replayed search counted once. Go counted the request in its rate-limit
// window when it served it (chargeSearch); Node's handler counts the replay again in the same window
// (checkSiteSearchRateLimit: INCR on the same `site-search:rate-limit:<bucket>` key, before it
// answers, a 429 included). So when Node answered the replay itself (a status of its own: not the
// proxy's empty 502 for a Node it could not reach, and not a replay that got no answer before its
// deadline), Go takes back one count (DECR, as refundSearch does for a hand-back). Nothing on the
// replay asks Node to skip its rate limit: the replay header only opts out of the shadow sampler.
//
// The rare edges, each at most one count in that viewer's current window: Node failed open (its
// store errored, so it counted nothing) or refused the replay before its rate limit (the API request
// policy, the wrapper's method check: answers Go would not have served), and the refund under-counts
// by one; a replay that timed out or broke after Node counted it is not refunded, and over-counts by
// one.
func (s *Server) refundReplayCharge(ctx context.Context, rep *parityReplay, outcome string, rec *replayRecorder) {
	if rep.rateKey == "" || !nodeAnsweredReplay(outcome, rec) {
		return
	}
	s.refundSearch(ctx, &searchCharge{key: rep.rateKey})
}

// nodeAnsweredReplay reports whether the Node app itself answered a replay: the upstream returned
// normally (no mid-body abort) with a status, which is not the fallback proxy's own empty 502.
func nodeAnsweredReplay(outcome string, rec *replayRecorder) bool {
	if outcome != "" || rec.status == 0 {
		return false
	}
	return rec.status != http.StatusBadGateway || rec.body.Len() > 0
}

// isSearchDocument reports whether body is a site-search shadow document (`{upstream, body}`,
// searchShadowDocument; the Node sampler's `node`) rather than an answer body: a top-level object
// with an `upstream` member, the exact name. No search answer has one (a search: `hits`, a
// multi-search: `results`, a facet search: `facetHits`, with the backend's own members).
func isSearchDocument(body []byte) bool {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return false
	}
	_, ok := top["upstream"]
	return ok
}

// errSearchForms: one side is a shadow document and the other an answer body (counted bad_request).
var errSearchForms = errors.New("site-search: a shadow document compared with an answer body")

// CompareSearch is site-search's comparator. Two shadow documents (a shadow sample: the search call
// and the answer, both reshaped from the ONE backend response Node recorded) are compared as
// CompareJSON compares them, every member included. Two answer bodies (a serve-side parity replay:
// Go's answer and Node's, from two backend calls) are compared the same way except for what only the
// backend's own instant decides:
//
//   - `processingTimeMs` (a search's, a facet search's, each multi-search result's) is the backend's
//     timing of its own call, passed through untouched by both sides, so it differs on nearly every
//     replay and says nothing about either port: it is not compared.
//   - a `facetDistribution` difference is counted under the `facetDistribution` category itself, its
//     path cut there: below it the keys are facet VALUES (index data), which would make an unbounded
//     metric label and put index values in the log.
//
// One side a document and the other a body is an error (bad_request).
func CompareSearch(goBody, nodeBody []byte) (*shadow.Report, error) {
	goDoc := isSearchDocument(goBody)
	if goDoc != isSearchDocument(nodeBody) {
		return nil, errSearchForms
	}
	r, err := shadow.CompareJSON(goBody, nodeBody)
	if err != nil || goDoc {
		return r, err
	}
	kept := make([]shadow.Diff, 0, len(r.Diffs))
	for _, d := range r.Diffs {
		if searchTimingCategory(d.Category) {
			continue
		}
		if c, p, ok := cutFacetDistribution(d.Category, d.Path); ok {
			if slices.ContainsFunc(kept, func(k shadow.Diff) bool { return k.Path == p && k.Kind == d.Kind }) {
				continue
			}
			d.Category, d.Path = c, p
		}
		kept = append(kept, d)
	}
	r.Diffs = kept
	r.Match = len(kept) == 0 && !r.Truncated
	return r, nil
}

// searchTimingCategory: the backend's own timing member of a search, facet search or multi-search
// result.
func searchTimingCategory(category string) bool {
	return category == "processingTimeMs" || category == "results.*.processingTimeMs"
}

// cutFacetDistribution cuts a category and its path at their `facetDistribution` segment (a search's
// or a multi-search result's), keeping the segment. ok false when neither is under one.
func cutFacetDistribution(category, path string) (string, string, bool) {
	cut := func(s string) (string, bool) {
		segs := strings.Split(s, ".")
		for i, seg := range segs {
			if seg == "facetDistribution" && (i == 0 || (i == 2 && segs[0] == "results")) {
				return strings.Join(segs[:i+1], "."), i+1 < len(segs)
			}
		}
		return s, false
	}
	c, below := cut(category)
	if !below {
		return category, path, false
	}
	p, _ := cut(path)
	return c, p, true
}

// searchSetCategories are the members of a search answer that describe the call or the whole matched
// set rather than one hit: the echoed call (`query`, `limit`, `offset`, `page`, `hitsPerPage`,
// `indexUid`, `facetQuery`) and the counts over every match (`estimatedTotalHits`, `totalHits`,
// `totalPages`, `facetDistribution`, `facetStats`; a facet search's `facetHits.*.count`). Each is
// matched at the top level and in each multi-search result.
var searchSetCategories = []string{
	"query", "limit", "offset", "page", "hitsPerPage", "indexUid", "facetQuery",
	"estimatedTotalHits", "totalHits", "totalPages", "facetDistribution", "facetStats", "facetHits.*.count",
}

// searchSetCategory reports whether a diff's category is one of searchSetCategories (or below one),
// at the top level or in a multi-search result.
func searchSetCategory(category string) bool {
	c := strings.TrimPrefix(category, "results.*.")
	for _, s := range searchSetCategories {
		if c == s || strings.HasPrefix(c, s+".") {
			return true
		}
	}
	return false
}

// classifySearchBodies is ClassifySearch for two answer bodies (a serve-side parity replay). The
// answers come from two backend calls, so a document indexed, removed or re-ranked between them is a
// real difference of the two answers that neither port caused; the classification keeps that apart
// from the shaping as far as the bodies allow:
//
//   - `match`: no difference (CompareSearch).
//   - `membership`: the hits differ as a set (keyed by `id`; a facet search's `facetHits` by `value`;
//     a multi-search's per result), or the hits are the same and every difference is in a member
//     that describes the call or the matched set (searchSetCategories: the echoed query, the counts).
//     Index churn between the two calls lands here, as does a call that differs.
//   - `order`: the same hits in another order (a re-rank between the calls, or a different sort).
//   - `fields`: the same hits in the same order, and a hit (or another member) differs: the shaping,
//     or a hit document updated between the two calls (its stats, say), which the bodies cannot tell
//     apart. feed_go_shadow_field_diffs_total's category names which.
func classifySearchBodies(r *shadow.Report, goBody, nodeBody []byte) string {
	if r.Match {
		return "match"
	}
	g, errG := searchHitKeys(goBody)
	n, errN := searchHitKeys(nodeBody)
	if errG != nil || errN != nil {
		return "fields"
	}
	if !slices.Equal(g, n) {
		if slices.Equal(slices.Sorted(slices.Values(g)), slices.Sorted(slices.Values(n))) {
			return "order"
		}
		return "membership"
	}
	if r.Truncated {
		return "fields"
	}
	for _, d := range r.Diffs {
		if !searchSetCategory(d.Category) {
			return "fields"
		}
	}
	return "membership"
}

// searchHitKeys is an answer body's hit sequence: a search's `hits[].id`, a facet search's
// `facetHits[].value`, a multi-search's `results[i].hits[].id` (each prefixed with its result's
// position, so a hit that moves to another result is a different key). A key is the member's JSON
// text.
func searchHitKeys(body []byte) ([]string, error) {
	type hit struct {
		ID json.RawMessage `json:"id"`
	}
	var b struct {
		Hits      []hit `json:"hits"`
		FacetHits []struct {
			Value json.RawMessage `json:"value"`
		} `json:"facetHits"`
		Results []struct {
			Hits []hit `json:"hits"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &b); err != nil {
		return nil, err
	}
	var out []string
	for _, h := range b.Hits {
		out = append(out, "hits:"+string(h.ID))
	}
	for _, f := range b.FacetHits {
		out = append(out, "facetHits:"+string(f.Value))
	}
	for i, res := range b.Results {
		for _, h := range res.Hits {
			out = append(out, "results."+strconv.Itoa(i)+":"+string(h.ID))
		}
	}
	return out, nil
}
