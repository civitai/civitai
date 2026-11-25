package sitesearch

import (
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/inputschema"
)

// The request bodies of the three routes, read as their zod schemas read them
// (src/server/schema/site-search.schema.ts): siteSearchParamsSchema (`indexes/:uid/search`), each
// query of siteMultiSearchSchema (`multi-search`: the params plus `indexUid`) and siteFacetSearchSchema
// (`indexes/:uid/facet-search`). zod strips an unknown key; here a key outside the generated schema
// keys (inputschema) falls back (`input-unknown-key`), as on every other port (DESIGN.md §5.1). A value
// zod refuses is Node's 400 and falls back (`search-input-invalid`), and so does one this reader cannot
// prove zod accepts (an integer past 2^53, say): a fallback is never wrong.

// MaxWindow is MAX_WINDOW: limit, offset and page are clamped to it, never refused.
const MaxWindow = 1000

// field is one parsed member: its key and the raw JSON the upstream body carries for it.
type field struct {
	key string
	val []byte
}

// Params is one parsed search: its members in the body's order, as zod's output carries them to the
// upstream request (`{ ...params }`), with the windows clamped. Filter and AttributesToRetrieve are
// read apart because withViewer rewrites them.
type Params struct {
	fields []field
	// Filter is the client's filter: nil when absent, else a string or a list of strings and lists.
	Filter *Filter
	// AttributesToRetrieve, when present (HasAttributes), is the list as sent.
	AttributesToRetrieve []string
	HasAttributes        bool
	// IndexUID is a multi-search query's `indexUid`.
	IndexUID string
	// Query is `q` when it is a string (the profanity check reads it).
	Query    string
	HasQuery bool
}

// Filter is a client filter: a string, or a list whose parts are strings or lists of strings (an OR
// group).
type Filter struct {
	String string
	IsList bool
	Parts  []FilterPart
}

// FilterPart is one element of a list filter.
type FilterPart struct {
	String string
	Group  []string
	// IsGroup: the part is a list (an OR group) rather than a string.
	IsGroup bool
}

func invalid(field, format string, args ...any) error {
	return fallback.NewfSafe("search-input-invalid", field, format, args...)
}

// value kinds the schemas read.
func readString(raw []byte, key string, max int) (string, error) {
	if !isString(raw) {
		return "", invalid(key, "%s: not a string", key)
	}
	s, err := decodeString(raw)
	if err != nil {
		return "", invalid(key, "%s: string", key)
	}
	if utf16Len(s) > max {
		return "", invalid(key, "%s: longer than %d", key, max)
	}
	return s, nil
}

func readStringList(raw []byte, key string, maxItems, maxLen int) ([]string, error) {
	if !isArray(raw) {
		return nil, invalid(key, "%s: not a list", key)
	}
	elems, err := parseArray(raw)
	if err != nil {
		return nil, invalid(key, "%s: list", key)
	}
	if len(elems) > maxItems {
		return nil, invalid(key, "%s: more than %d", key, maxItems)
	}
	out := make([]string, len(elems))
	for i, e := range elems {
		s, err := readString(e, key, maxLen)
		if err != nil {
			return nil, err
		}
		out[i] = s
	}
	return out, nil
}

// readInt is `z.number().int()` with its bounds: a finite integral number in the safe range (zod 4's
// int), then min and max. An integral value past 2^53 falls back whatever zod says of it.
func readInt(raw []byte, key string, min, max int) (int, error) {
	if len(raw) == 0 || !(raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9')) {
		return 0, invalid(key, "%s: not a number", key)
	}
	f, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || math.IsInf(f, 0) || f != math.Trunc(f) || math.Abs(f) > 1<<53-1 {
		return 0, invalid(key, "%s: not an integer", key)
	}
	n := int(f)
	if n < min || n > max {
		return 0, invalid(key, "%s: out of range", key)
	}
	return n, nil
}

func readFilter(raw []byte) (*Filter, error) {
	const maxText, maxItems = 10_000, 100
	if isString(raw) {
		s, err := readString(raw, "filter", maxText)
		if err != nil {
			return nil, err
		}
		return &Filter{String: s}, nil
	}
	if !isArray(raw) {
		return nil, invalid("filter", "filter: not a string or a list")
	}
	elems, err := parseArray(raw)
	if err != nil {
		return nil, invalid("filter", "filter: list")
	}
	if len(elems) > maxItems {
		return nil, invalid("filter", "filter: more than %d parts", maxItems)
	}
	f := &Filter{IsList: true, Parts: make([]FilterPart, len(elems))}
	for i, e := range elems {
		if isArray(e) {
			group, err := readStringList(e, "filter", maxItems, maxText)
			if err != nil {
				return nil, err
			}
			f.Parts[i] = FilterPart{Group: group, IsGroup: true}
			continue
		}
		s, err := readString(e, "filter", maxText)
		if err != nil {
			return nil, err
		}
		f.Parts[i] = FilterPart{String: s}
	}
	return f, nil
}

// paramsKeys are the members each schema reads, and how. The schemas' keys are generated
// (inputschema); TestInputKeyLedger holds this table to them in both directions.
const (
	kindQuery = iota
	kindFilter
	kindAttrList
	kindTag
	kindCropLength
	kindStrategy
	kindWindow
	kindHitsPerPage
	kindIndexUID
	kindFacetName
	kindFacetQuery
)

var paramsKinds = map[string]int{
	"q":                     kindQuery,
	"filter":                kindFilter,
	"sort":                  kindAttrList,
	"facets":                kindAttrList,
	"attributesToRetrieve":  kindAttrList,
	"attributesToHighlight": kindAttrList,
	"attributesToCrop":      kindAttrList,
	"highlightPreTag":       kindTag,
	"highlightPostTag":      kindTag,
	"cropMarker":            kindTag,
	"cropLength":            kindCropLength,
	"matchingStrategy":      kindStrategy,
	"limit":                 kindWindow,
	"offset":                kindWindow,
	"hitsPerPage":           kindHitsPerPage,
	"page":                  kindWindow,
}

var queryKinds = func() map[string]int {
	m := map[string]int{"indexUid": kindIndexUID}
	for k, v := range paramsKinds {
		m[k] = v
	}
	return m
}()

var facetKinds = map[string]int{
	"facetName":        kindFacetName,
	"facetQuery":       kindFacetQuery,
	"q":                kindQuery,
	"filter":           kindFilter,
	"matchingStrategy": kindStrategy,
}

// readParams reads an object against one schema: kinds (what each key is), schema (the generated key
// list) and required (keys zod requires).
func readParams(raw []byte, kinds map[string]int, schema *inputschema.Schema, required ...string) (*Params, error) {
	if !isObject(raw) {
		return nil, invalid("body", "not an object")
	}
	o, err := parseObject(raw)
	if err != nil {
		// A duplicate key: JSON.parse keeps the last value at the first key's place; not reproduced.
		return nil, fallback.New("search-input-duplicate")
	}
	p := &Params{}
	var unknown []string
	for _, m := range o.members {
		kind, known := kinds[m.key]
		if !known || !schema.Has(m.key) {
			unknown = append(unknown, m.key)
			continue
		}
		val := trim(m.val)
		out := val
		switch kind {
		case kindQuery:
			if !isNull(val) {
				s, err := readString(val, m.key, 1000)
				if err != nil {
					return nil, err
				}
				p.Query, p.HasQuery = s, true
			}
		case kindFacetQuery:
			if !isNull(val) {
				if _, err := readString(val, m.key, 1000); err != nil {
					return nil, err
				}
			}
		case kindFilter:
			f, err := readFilter(val)
			if err != nil {
				return nil, err
			}
			p.Filter = f
		case kindAttrList:
			list, err := readStringList(val, m.key, 100, 100)
			if err != nil {
				return nil, err
			}
			if m.key == "attributesToRetrieve" {
				p.AttributesToRetrieve, p.HasAttributes = list, true
			}
		case kindTag, kindFacetName:
			if _, err := readString(val, m.key, 100); err != nil {
				return nil, err
			}
		case kindIndexUID:
			s, err := readString(val, m.key, 100)
			if err != nil {
				return nil, err
			}
			p.IndexUID = s
		case kindCropLength, kindHitsPerPage, kindWindow:
			// A number is written as JSON.stringify writes the parsed value (`1e2` is 100).
			max := 1000
			switch kind {
			case kindHitsPerPage:
				max = 100
			case kindWindow:
				max = math.MaxInt
			}
			n, err := readInt(val, m.key, 0, max)
			if err != nil {
				return nil, err
			}
			if kind == kindWindow {
				n = min(n, MaxWindow)
			}
			out = []byte(strconv.Itoa(n))
		case kindStrategy:
			s, err := readString(val, m.key, 100)
			if err != nil {
				return nil, err
			}
			if s != "last" && s != "all" && s != "frequency" {
				return nil, invalid(m.key, "%s: not an option", m.key)
			}
		}
		// A string or a list is the client's own value, carried to the upstream request as parsed;
		// `filter` and `attributesToRetrieve` keep their place and are rewritten by withViewer.
		p.fields = append(p.fields, field{key: m.key, val: out})
	}
	for _, k := range required {
		if _, ok := o.get(k); !ok {
			return nil, invalid(k, "%s: required", k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, fallback.NewfSafe("input-unknown-key", fallback.Token(unknown[0]), "unknown key %q", unknown[0])
	}
	return p, nil
}

// Route is one of the three routes `[...path]` answers.
type Route int

const (
	RouteMulti Route = iota + 1
	RouteSearch
	RouteFacet
)

// Request is a parsed site-search request.
type Request struct {
	Route Route
	// Index is the route's index uid (`indexes/:uid/...`).
	Index string
	// Queries are the multi-search's queries; Params the index route's.
	Queries []*Params
	Params  *Params
}

// ParsePath reads the route from the request path's segments after `/api/search/` (Next's catch-all
// `path`): `multi-search`, `indexes/:uid/search` or `indexes/:uid/facet-search`. Anything else is
// Node's 404 (`search-path`).
func ParsePath(rest string) (Route, string, error) {
	segs := strings.Split(rest, "/")
	switch {
	case len(segs) == 1 && segs[0] == "multi-search":
		return RouteMulti, "", nil
	case len(segs) == 3 && segs[0] == "indexes" && segs[2] == "search":
		return RouteSearch, segs[1], nil
	case len(segs) == 3 && segs[0] == "indexes" && segs[2] == "facet-search":
		return RouteFacet, segs[1], nil
	}
	return 0, "", fallback.New("search-path")
}

// ParseBody reads body (the request's JSON) for route against its schema. It does not check the
// indexes (CheckIndexes).
func ParseBody(route Route, index string, body []byte) (*Request, error) {
	if !validBody(body) {
		return nil, fallback.New("search-input")
	}
	req := &Request{Route: route, Index: index}
	switch route {
	case RouteMulti:
		raw := trim(body)
		if !isObject(raw) {
			return nil, invalid("body", "not an object")
		}
		o, err := parseObject(raw)
		if err != nil {
			return nil, fallback.New("search-input-duplicate")
		}
		schema := inputschema.Get(inputschema.SiteMultiSearch)
		var unknown []string
		for _, m := range o.members {
			if m.key != "queries" || !schema.Has(m.key) {
				unknown = append(unknown, m.key)
			}
		}
		queriesRaw, ok := o.get("queries")
		if !ok {
			return nil, invalid("queries", "queries: required")
		}
		queriesRaw = trim(queriesRaw)
		if !isArray(queriesRaw) {
			return nil, invalid("queries", "queries: not a list")
		}
		elems, err := parseArray(queriesRaw)
		if err != nil {
			return nil, invalid("queries", "queries: list")
		}
		if len(elems) < 1 || len(elems) > 20 {
			return nil, invalid("queries", "queries: %d", len(elems))
		}
		qschema := inputschema.Get(inputschema.SiteMultiSearchQuery)
		for _, e := range elems {
			p, err := readParams(trim(e), queryKinds, qschema, "indexUid")
			if err != nil {
				return nil, err
			}
			req.Queries = append(req.Queries, p)
		}
		if len(unknown) > 0 {
			sort.Strings(unknown)
			return nil, fallback.NewfSafe("input-unknown-key", fallback.Token(unknown[0]), "unknown key %q", unknown[0])
		}
	case RouteSearch:
		p, err := readParams(trim(body), paramsKinds, inputschema.Get(inputschema.SiteSearchParams))
		if err != nil {
			return nil, err
		}
		req.Params = p
	case RouteFacet:
		p, err := readParams(trim(body), facetKinds, inputschema.Get(inputschema.SiteFacetSearch), "facetName")
		if err != nil {
			return nil, err
		}
		req.Params = p
	default:
		return nil, fallback.New("search-path")
	}
	return req, nil
}

// CheckIndexes is assertSiteSearchIndex over every index the request names: one Node refuses (403
// index_not_accessible) falls back (`search-index`).
func (r *Request) CheckIndexes() error {
	if r.Route == RouteMulti {
		for _, q := range r.Queries {
			if !IsSearchable(q.IndexUID) {
				return fallback.New("search-index")
			}
		}
		return nil
	}
	if !IsSearchable(r.Index) {
		return fallback.New("search-index")
	}
	return nil
}

// QueryTexts is siteSearchQueries over the parsed request: each search's `q` when it is a string.
func (r *Request) QueryTexts() []string {
	var out []string
	add := func(p *Params) {
		if p != nil && p.HasQuery {
			out = append(out, p.Query)
		}
	}
	for _, q := range r.Queries {
		add(q)
	}
	add(r.Params)
	return out
}
