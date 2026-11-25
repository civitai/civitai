package store

import (
	"regexp"
	"slices"
	"strings"
)

// MaxTokens bounds how many words of a query are matched.
const MaxTokens = 8

// Query is one search. Results are in relevance order: text rank, best first, then lower-cased
// name in byte order, then URN. Without text every rank is equal, so the order is by name.
type Query struct {
	// Text is matched word by word: every word must be a prefix of a word of the app's name,
	// slug, tagline or creator. Text with no word in it matches nothing.
	Text     string
	Kind     string // "" = any
	Category string // "" = any
	// Mature is the mature ratings the caller asks for (Mature.Admits). Its zero value answers no
	// app rated r, x or xxx.
	Mature Mature
	Limit  int
}

// Mature is which mature content ratings a request may be shown. Its zero value is the SFW
// audience. Admits is the one rating rule of this service: search (Query.Mature) and the listing
// gate (listingread.Admits) both apply it.
type Mature struct {
	R, X, XXX bool
}

// hidden is the lower-cased mature ratings m does not admit. Both search stores filter by it, the
// Postgres one in its query, so the limit counts only admitted rows.
func (m Mature) hidden() []string {
	var out []string
	if !m.R {
		out = append(out, "r")
	}
	if !m.X {
		out = append(out, "x")
	}
	if !m.XXX {
		out = append(out, "xxx")
	}
	return out
}

// Admits reports whether a request allowed m may be shown an app rated rating ("" for none).
//
// Mirrors the site's matureRatingAllowed / listingMatureFilter (app-listing-store-gate.ts), not the
// registry's audienceAdmits, which is stricter for an unknown or missing rating: this service answers
// in the database path's place. Only r, x and xxx are mature.
func (m Mature) Admits(rating string) bool {
	return !slices.Contains(m.hidden(), strings.ToLower(rating))
}

// Result is one app as search returns it.
type Result struct {
	URN      string `json:"urn"`
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	Tagline  string `json:"tagline"`
	Kind     string `json:"kind"`
	Category string `json:"category"`
	Rating   string `json:"rating"`
	IconURL  string `json:"iconUrl"`
	Creator  string `json:"creator"`
}

// Page is the results of one search, at most Query.Limit of them.
type Page struct {
	Results []Result
}

var wordRE = regexp.MustCompile(`[\p{L}\p{N}]+`)

// Tokens is the words of a query, lower-cased, deduplicated, at most MaxTokens. Each is only
// letters and digits, so it can be placed in a tsquery without escaping.
func Tokens(text string) []string {
	seen := map[string]bool{}
	var out []string
	for _, w := range wordRE.FindAllString(strings.ToLower(text), -1) {
		if seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, w)
		if len(out) == MaxTokens {
			break
		}
	}
	return out
}

// prefixTSQuery is the tsquery text matching every token as a prefix.
func prefixTSQuery(tokens []string) string {
	parts := make([]string, len(tokens))
	for i, t := range tokens {
		parts[i] = t + ":*"
	}
	return strings.Join(parts, " & ")
}

// nameKey is the name column the order compares: lower-cased in Go, so both stores order alike.
func nameKey(name string) string { return strings.ToLower(name) }

// limitOf is the query's limit, 20 when unset.
func (q Query) limitOf() int {
	if q.Limit <= 0 {
		return 20
	}
	return q.Limit
}
