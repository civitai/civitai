// Package sitesearch ports `POST /api/search/[...path]` (src/pages/api/search/[...path].ts and
// src/server/services/site-search.service.ts): the site's search UI speaks the Meilisearch protocol to
// this route, which validates the body, holds every query to the viewer's clauses, forwards it to the
// search backend and reshapes the hits the viewer may not receive as sent. DESIGN.md §18.
//
// This package is the part that depends on no server: the body's schema (input.go), the viewer and
// its clauses (viewer.go), the hit shaping (shape.go) and the backend call (upstream.go). The session,
// the host and the rate limit are read by internal/server.
package sitesearch

import (
	"context"
	"slices"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// UpstreamCall is the search call a request makes: the backend path and the JSON body.
type UpstreamCall struct {
	Path string
	Body []byte
}

// Answer is a computed answer: the body Node would write with a 200, and the call it was computed
// from (the shadow compares the call too).
type Answer struct {
	Body []byte
	Call UpstreamCall
}

// withViewerClauses is withViewerClauses: with no clause the client's filter as sent (absent stays
// absent); otherwise a list of the client's parts (a string is one part, an empty string part is
// dropped) followed by the clauses. The list form is what keeps a client string from closing a
// parenthesis around them: Meilisearch parses each element on its own.
func withViewerClauses(f *Filter, raw []byte, clauses []string) ([]byte, bool) {
	if len(clauses) == 0 {
		return raw, f != nil
	}
	out := []byte{'['}
	n := 0
	add := func(b []byte) {
		if n > 0 {
			out = append(out, ',')
		}
		out = append(out, b...)
		n++
	}
	if f != nil {
		if !f.IsList {
			if f.String != "" {
				add(appendJSString(nil, f.String))
			}
		} else {
			for _, p := range f.Parts {
				if !p.IsGroup {
					if p.String != "" {
						add(appendJSString(nil, p.String))
					}
					continue
				}
				g := []byte{'['}
				for i, s := range p.Group {
					if i > 0 {
						g = append(g, ',')
					}
					g = appendJSString(g, s)
				}
				add(append(g, ']'))
			}
		}
	}
	for _, c := range clauses {
		add(appendJSString(nil, c))
	}
	return append(out, ']'), true
}

// attributesToFetch is attributesToFetch: a models query that lists its attributes also fetches
// `sfwName` (unless it lists it or `*`), which shapeModelHit removes again.
func attributesToFetch(uid string, attrs []string) []string {
	if uid != ModelsIndex || slices.Contains(attrs, "sfwName") || slices.Contains(attrs, "*") {
		return attrs
	}
	return append(slices.Clone(attrs), "sfwName")
}

// body is withViewer(uid, params, viewer) as JSON: the params in their order, `filter` rewritten
// (appended when the client sent none and a clause applies), `attributesToRetrieve` extended.
func (p *Params) body(uid string, v Viewer) []byte {
	o := &object{}
	for _, f := range p.fields {
		o.members = append(o.members, member(f))
	}
	raw, _ := o.get("filter")
	if filter, ok := withViewerClauses(p.Filter, raw, Clauses(uid, v)); ok {
		o.set("filter", filter)
	}
	if p.HasAttributes {
		attrs := attributesToFetch(uid, p.AttributesToRetrieve)
		b := []byte{'['}
		for i, a := range attrs {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendJSString(b, a)
		}
		o.set("attributesToRetrieve", append(b, ']'))
	}
	return o.bytes()
}

// Call is the search call Node makes for the request and viewer.
func (r *Request) Call(v Viewer) UpstreamCall {
	switch r.Route {
	case RouteMulti:
		out := []byte(`{"queries":[`)
		for i, q := range r.Queries {
			if i > 0 {
				out = append(out, ',')
			}
			out = append(out, q.body(q.IndexUID, v)...)
		}
		return UpstreamCall{Path: "/multi-search", Body: append(out, "]}"...)}
	case RouteSearch:
		return UpstreamCall{Path: "/indexes/" + r.Index + "/search", Body: r.Params.body(r.Index, v)}
	default:
		return UpstreamCall{Path: "/indexes/" + r.Index + "/facet-search", Body: r.Params.body(r.Index, v)}
	}
}

var errUpstreamShape = fallback.New("search-upstream-shape")

// Compute answers a parsed request for a viewer from up: the call, then the hits shaped as Node shapes
// them. A backend that does not answer 200 with a JSON body falls back (Node answers its own 4xx/5xx):
// `search-upstream-unavailable` (no answer), `search-upstream-status`, `search-upstream-shape`.
func Compute(ctx context.Context, up Upstream, req *Request, v Viewer) (*Answer, error) {
	if err := req.CheckIndexes(); err != nil {
		return nil, err
	}
	call := req.Call(v)
	res, err := up.Post(ctx, call.Path, call.Body)
	if err != nil {
		return nil, fallback.Wrap("search-upstream-unavailable", err)
	}
	if res.Status != 200 {
		return nil, fallback.Safef("search-upstream-status", "%d", res.Status)
	}
	if !validBody(res.Body) {
		return nil, errUpstreamShape
	}
	body := trim(res.Body)
	var out []byte
	switch req.Route {
	case RouteFacet:
		// Facet values carry no hits: nothing is shaped.
		out = body
	case RouteSearch:
		out, err = shapeSearch(body, req.Index, v)
	case RouteMulti:
		out, err = shapeMulti(body, req.Queries, v)
	}
	if err != nil {
		return nil, errUpstreamShape
	}
	return &Answer{Body: out, Call: call}, nil
}

// shapeSearch is siteIndexSearch's `{ ...body, hits: shapeHits(uid, body.hits, viewer) }`.
func shapeSearch(body []byte, uid string, v Viewer) ([]byte, error) {
	if !isObject(body) {
		return nil, errShape
	}
	if !HitsNeedShaping(uid, v) {
		return body, nil
	}
	o, err := parseObject(body)
	if err != nil {
		return nil, err
	}
	if err := shapeResult(o, uid, v); err != nil {
		return nil, err
	}
	return o.appendTo(make([]byte, 0, len(body))), nil
}

// shapeResult reshapes one result object's `hits` in place: an absent result stays absent (JSON.stringify
// drops `hits: undefined`), a capped absent list becomes [] at the end.
func shapeResult(o *object, uid string, v Viewer) error {
	hits, present := o.get("hits")
	shaped, keep, err := ShapeHits(uid, hits, present, v)
	if err != nil {
		return err
	}
	if !keep {
		o.del("hits")
		return nil
	}
	o.set("hits", shaped)
	return nil
}

// shapeMulti is siteMultiSearch's `{ ...body, results: body.results?.map(...) }`: each result shaped by
// its own indexUid, else the query's at its position.
func shapeMulti(body []byte, queries []*Params, v Viewer) ([]byte, error) {
	if !isObject(body) {
		return nil, errShape
	}
	o, err := parseObject(body)
	if err != nil {
		return nil, err
	}
	resultsRaw, ok := o.get("results")
	if !ok {
		return body, nil
	}
	// `null?.map` drops the member and anything else but a list throws: neither is reproduced.
	if !isArray(resultsRaw) {
		return nil, errShape
	}
	results, err := parseArray(resultsRaw)
	if err != nil {
		return nil, err
	}
	changed := false
	for i, r := range results {
		if !isObject(r) {
			return nil, errShape
		}
		ro, err := parseObject(r)
		if err != nil {
			return nil, err
		}
		uid := ""
		if raw, ok := ro.get("indexUid"); ok && !isNull(raw) {
			if !isString(raw) {
				return nil, errShape
			}
			if uid, err = decodeString(raw); err != nil {
				return nil, err
			}
		} else if i < len(queries) {
			uid = queries[i].IndexUID
		}
		if !HitsNeedShaping(uid, v) {
			continue
		}
		if err := shapeResult(ro, uid, v); err != nil {
			return nil, err
		}
		results[i] = ro.bytes()
		changed = true
	}
	if !changed {
		return body, nil
	}
	o.set("results", appendArray(make([]byte, 0, len(resultsRaw)), results))
	return o.appendTo(make([]byte, 0, len(body))), nil
}
