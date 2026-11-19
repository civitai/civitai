package store

import (
	"regexp"
	"strings"
)

// Sort orders search results.
type Sort string

// The sorts of GET /search.
const (
	// SortRelevance: text rank, best first, then SortName's order. Without query text it is
	// SortName.
	SortRelevance Sort = "relevance"
	// SortNewest: the time this index first saw the app, newest first, then URN descending. app@v1
	// carries no timestamp, so this is the index's own first-seen time, carried across rebuilds.
	SortNewest Sort = "newest"
	// SortName: lower-cased name in byte order, then URN.
	SortName Sort = "name"
)

// MaxTokens bounds how many words of a query are matched.
const MaxTokens = 8

// Query is one search.
type Query struct {
	// Text is matched word by word: every word must be a prefix of a word of the app's name,
	// slug, tagline or creator. Text with no word in it matches nothing.
	Text     string
	Kind     string // "" = any
	Category string // "" = any
	Sort     Sort
	Limit    int
	// After resumes after the result that carried this key (Page.Next).
	After *Key
}

// Key is a result's position in its sort, the keyset a page resumes after.
type Key struct {
	Rank float64 `json:"r,omitempty"`
	Name string  `json:"n,omitempty"`
	Seen int64   `json:"t,omitempty"`
	URN  string  `json:"u"`
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

// Page is one page of results; Next is nil on the last one.
type Page struct {
	Results []Result
	Next    *Key
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

// effectiveSort is the sort a query runs with: relevance without text is name.
func (q Query) effectiveSort() Sort {
	if q.Sort == SortRelevance && strings.TrimSpace(q.Text) == "" {
		return SortName
	}
	if q.Sort == "" {
		if strings.TrimSpace(q.Text) == "" {
			return SortName
		}
		return SortRelevance
	}
	return q.Sort
}

// nameKey is the name column sorts compare: lower-cased in Go, so both stores order alike.
func nameKey(name string) string { return strings.ToLower(name) }
