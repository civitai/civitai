package shadow

import (
	"sort"
	"strconv"
	"strings"
)

// ComparedHeaders are the response headers whose difference matters for correctness, as the Node
// sampler sends them (lowercased; src/server/trpc/feed-go-shadow.ts FEED_GO_COMPARED_RESPONSE_HEADERS):
//
//   - cache-control: who may store the answer and for how long (buildTrpcCacheHeaders, or the
//     PRIVATE_CACHE_CONTROL default applyApiRequestPolicy sets).
//   - vary: which request headers a cache must key on.
//   - cache-tag: the purge tags an edge-cached answer is filed under.
//   - set-cookie: PRESENCE only (the sampler sends `present`, never a value): responseMeta removes it
//     from an edge-cached answer, so one surviving there is a leak to the next caller.
//   - x-update-required: tells an outdated web client to reload.
//
// Everything else is not compared, by rule: X-Handled-By names the pod, Content-Type/Length and Date
// are transport, and the rate-limit, Retry-After and site-alerts headers are per caller or per moment.
var ComparedHeaders = []string{"cache-control", "vary", "cache-tag", "set-cookie", "x-update-required"}

// CompareResponse compares the ComparedHeaders of the two answers. The status is not compared: Node
// posts only the samples it answered 200, and an answer computed here is a 200, so it cannot differ.
// Noise rules: values are trimmed; Cache-Control and Vary compare as sets of lowercased directives or
// header names (order and case do not matter to a cache); Cache-Tag as a set of tags; Set-Cookie by
// presence. Diffs carry category `header:<name>`, never a value.
func CompareResponse(goHeaders, nodeHeaders map[string]string) []Diff {
	out := make([]Diff, 0, len(ComparedHeaders))
	for _, name := range ComparedHeaders {
		g, gok := lookup(goHeaders, name)
		n, nok := lookup(nodeHeaders, name)
		cat := "header:" + name
		switch {
		case gok && !nok:
			out = append(out, Diff{Path: cat, Category: cat, Kind: "missing-in-node"})
		case !gok && nok:
			out = append(out, Diff{Path: cat, Category: cat, Kind: "missing-in-go"})
		case gok && nok && normalizeHeader(name, g) != normalizeHeader(name, n):
			out = append(out, Diff{Path: cat, Category: cat, Kind: "value"})
		}
	}
	return out
}

// lookup reads a header case-insensitively; an empty value is absent.
func lookup(h map[string]string, name string) (string, bool) {
	for k, v := range h {
		if strings.EqualFold(k, name) {
			v = strings.TrimSpace(v)
			return v, v != ""
		}
	}
	return "", false
}

func normalizeHeader(name, v string) string {
	switch name {
	case "cache-control", "vary":
		return tokenSet(strings.ToLower(v), ",")
	case "cache-tag":
		return tokenSet(v, ",")
	case "set-cookie":
		return "present"
	}
	return v
}

// tokenSet is v split on sep, each part trimmed (and `max-age=060` read as `max-age=60`), sorted and
// rejoined.
func tokenSet(v, sep string) string {
	parts := strings.Split(v, sep)
	out := parts[:0]
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if k, num, ok := strings.Cut(p, "="); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(num)); err == nil {
				p = strings.TrimSpace(k) + "=" + strconv.Itoa(n)
			}
		}
		out = append(out, p)
	}
	sort.Strings(out)
	return strings.Join(out, sep)
}
