// Package profanity is civitai.com's site-search profanity check (src/server/services/
// profanity-list.service.ts `profaneSearchCheck`, over src/libs/profanity-simple and obscenity 0.4.5),
// ported for ASCII text and answering only what it has proven: clean, profane, or "unproven", which
// the caller hands back to Node. DESIGN.md §18.3.
//
// data.json carries everything Node reads that is not code: the shipped block and allow lists
// (@civitai/mod-utils/profanity/lists), obscenity's English dataset, LIBRARY_OVERMATCH_TOKENS, the
// word-rules constants, and the matcher's two transformer chains as tables. It is a copy, and
// src/server/__tests__/feed-go-site-search-profanity.test.ts holds every field of it to the live Node
// values (the lists, the dataset parsed by obscenity's own parser, each transformer chain probed on
// every ASCII character), so a list edit or an obscenity bump without this file fails CI.
package profanity

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed data.json
var dataJSON []byte

// Phrase is one of obscenity's English dataset phrases: its patterns, raw, and its whitelisted terms.
type Phrase struct {
	Word             string   `json:"word"`
	Patterns         []string `json:"patterns"`
	WhitelistedTerms []string `json:"whitelistedTerms"`
}

// ChainTable is one transformer chain over ASCII: Map[c] is the character the chain's per-character
// transformers turn c into; Collapse is collapseDuplicates' thresholds by (transformed) character,
// Default for the others, where -1 is unlimited.
type ChainTable struct {
	Map      []int          `json:"map"`
	Collapse map[string]int `json:"collapse"`
	Default  int            `json:"default"`
}

// Data is data.json.
type Data struct {
	BlockedWords         []string   `json:"blockedWords"`
	WhitelistWords       []string   `json:"whitelistWords"`
	OvermatchTokens      []string   `json:"overmatchTokens"`
	MinManagedEntries    int        `json:"minManagedEntries"`
	MinDatasetWordLength int        `json:"minDatasetWordLength"`
	MinUnboundedLetters  int        `json:"minUnboundedLetters"`
	English              []Phrase   `json:"english"`
	Blacklist            ChainTable `json:"blacklist"`
	Whitelist            ChainTable `json:"whitelist"`

	blacklist, whitelist chain
	rules                *rules
}

// Shipped is the embedded data.json.
func Shipped() (*Data, error) { return ParseData(dataJSON) }

// ParseData reads a data.json.
func ParseData(raw []byte) (*Data, error) {
	var d Data
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, fmt.Errorf("profanity data: %w", err)
	}
	if len(d.BlockedWords) == 0 || len(d.WhitelistWords) == 0 || len(d.English) == 0 ||
		d.MinManagedEntries <= 0 || d.MinDatasetWordLength <= 0 || d.MinUnboundedLetters <= 0 {
		return nil, fmt.Errorf("profanity data: incomplete")
	}
	for _, t := range []struct {
		in  ChainTable
		out *chain
	}{{d.Blacklist, &d.blacklist}, {d.Whitelist, &d.whitelist}} {
		if len(t.in.Map) != 128 {
			return nil, fmt.Errorf("profanity data: a chain map of %d characters, want 128", len(t.in.Map))
		}
		for c, m := range t.in.Map {
			if m < 0 || m > 127 {
				return nil, fmt.Errorf("profanity data: %d maps outside ASCII", c)
			}
			t.out.char[c] = byte(m)
			t.out.threshold[c] = t.in.Default
		}
		for k, v := range t.in.Collapse {
			if len(k) != 1 || k[0] > 127 || v < -1 {
				return nil, fmt.Errorf("profanity data: collapse threshold %q", k)
			}
			t.out.threshold[k[0]] = v
		}
	}
	d.rules = newRules(&d)
	return &d, nil
}
