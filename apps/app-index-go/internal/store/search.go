package store

import (
	"regexp"
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
	Limit    int
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
