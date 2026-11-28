package profanity

import (
	"errors"
	"regexp"
	"strings"
)

// ErrUnproven is a text this port has not proven it judges as Node does: one with a byte outside
// ASCII. obscenity iterates code points, maps Unicode confusables, indexes UTF-16 code units, and
// JavaScript's toLowerCase, trim and `\s` are Unicode-aware; none of that is ported, so such a text is
// never called clean (the caller hands it back).
var ErrUnproven = errors.New("profanity: text outside what the port has proven (non-ASCII)")

// chain is one of the matcher's transformer chains over ASCII: the simple per-character maps folded
// into one table (resolveConfusables, the custom leetspeak, toAsciiLowerCase: on ASCII input each
// yields ASCII and none drops a character), then collapseDuplicates' per-character thresholds
// (-1: unlimited, JavaScript's Infinity). Both tables are data.json's, held to the real matcher's
// transformers by the Node parity test.
type chain struct {
	char      [128]byte
	threshold [128]int
}

// apply is RegExpMatcher.applyTransformers on ASCII text: the transformed text and, for each of its
// bytes, the index of the input byte it came from.
func (c *chain) apply(text string) (string, []int) {
	out := make([]byte, 0, len(text))
	idx := make([]int, 0, len(text))
	last := -1
	remaining := 0
	unlimited := false
	for i := 0; i < len(text); i++ {
		ch := c.char[text[i]]
		if int(ch) == last {
			// CollapseDuplicatesTransformer: `this.remaining-- > 0 ? char : undefined`.
			keep := unlimited || remaining > 0
			remaining--
			if keep {
				out = append(out, ch)
				idx = append(idx, i)
			}
			continue
		}
		th := c.threshold[ch]
		last = int(ch)
		unlimited = th < 0
		remaining = th - 1
		if unlimited || th > 0 {
			out = append(out, ch)
			idx = append(idx, i)
		}
	}
	return string(out), idx
}

// Filter is SimpleProfanityFilter's `analyze(text).isProfane`, built from one block list and one
// allow list.
type Filter struct {
	terms        []*regexp.Regexp
	whitelisted  []string // every phrase's whitelisted terms (the matcher's flat list)
	whitelistSet map[string]struct{}
	blacklist    *chain
	whitelist    *chain
}

// Build is `new SimpleProfanityFilter({ moderatorBlocklist: blocked, moderatorWhitelist: allowed })`.
// A nil list is the shipped one, and only the shipped block list adds obscenity's English dataset.
// An error is a list the obscenity parser refuses, or one this port cannot read as Node does (a
// non-ASCII block entry): the caller hands back. A non-ASCII ALLOW entry is dropped instead: an allow
// entry only ever excuses a match, so dropping one can only refuse more.
func Build(d *Data, blocked, allowed []string) (*Filter, error) {
	shipped := blocked == nil
	if shipped {
		blocked = d.BlockedWords
	}
	for _, e := range blocked {
		if !isASCII(e) {
			return nil, ErrUnproven
		}
	}
	if allowed == nil {
		allowed = d.WhitelistWords
	}
	var whitelist []string
	for _, w := range allowed {
		if isASCII(w) {
			whitelist = append(whitelist, w)
		}
	}
	words := nsfwWords(blocked)

	f := &Filter{whitelistSet: map[string]struct{}{}, blacklist: &d.blacklist, whitelist: &d.whitelist}
	add := func(raw string) error {
		pt, err := parsePattern(raw)
		if err != nil {
			return err
		}
		re, err := compilePattern(pt)
		if err != nil {
			return err
		}
		f.terms = append(f.terms, re)
		return nil
	}
	if shipped {
		for _, ph := range d.English {
			for _, raw := range ph.Patterns {
				if err := add(raw); err != nil {
					return nil, err
				}
			}
			f.whitelisted = append(f.whitelisted, ph.WhitelistedTerms...)
		}
	}
	// extendWithCustomDataset: each word of at least three characters (pipes included) is a pattern,
	// with createWhitelistMappings' terms: the allow entries that contain it and are not it.
	for _, w := range words {
		if len(w) < d.MinDatasetWordLength {
			continue
		}
		if err := add(w); err != nil {
			return nil, err
		}
		lw := asciiLower(w)
		for _, a := range whitelist {
			la := asciiLower(a)
			if strings.Contains(la, lw) && la != lw {
				f.whitelisted = append(f.whitelisted, a)
			}
		}
	}
	// whitelistSet: the allow entries and LIBRARY_OVERMATCH_TOKENS, lower-cased, minus every word.
	profane := make(map[string]struct{}, len(words))
	for _, w := range words {
		profane[asciiLower(w)] = struct{}{}
	}
	for _, list := range [][]string{whitelist, d.OvermatchTokens} {
		for _, a := range list {
			la := asciiLower(a)
			if _, ok := profane[la]; !ok {
				f.whitelistSet[la] = struct{}{}
			}
		}
	}
	for _, t := range f.whitelisted {
		if t == "" {
			return nil, errPattern // RegExpMatcher refuses an empty whitelisted term
		}
	}
	return f, nil
}

// Profane is `analyze(text).isProfane`: some match of some term that no whitelisted term's interval
// contains and whose surrounding word is not on the allow set. ErrUnproven for non-ASCII text.
func (f *Filter) Profane(text string) (bool, error) {
	if !isASCII(text) {
		return false, ErrUnproven
	}
	type interval struct{ lo, hi int }
	var intervals []interval
	wt, wmap := f.whitelist.apply(text)
	for _, term := range f.whitelisted {
		// getWhitelistedIntervals: indexOf from the end of the previous occurrence (non-overlapping).
		for lastEnd := 0; lastEnd <= len(wt); {
			i := strings.Index(wt[lastEnd:], term)
			if i < 0 {
				break
			}
			start := lastEnd + i
			intervals = append(intervals, interval{wmap[start], wmap[start+len(term)-1]})
			lastEnd = start + len(term)
		}
	}
	bt, bmap := f.blacklist.apply(text)
	for _, re := range f.terms {
		for _, m := range re.FindAllStringIndex(bt, -1) {
			start, end := bmap[m[0]], bmap[m[1]-1]
			covered := false
			for _, iv := range intervals {
				if iv.lo <= start && end <= iv.hi {
					covered = true
					break
				}
			}
			if covered {
				continue
			}
			word := extractFullWord(text, start, end+1)
			if _, ok := f.whitelistSet[asciiLower(jsTrim(word))]; ok {
				continue
			}
			return true, nil
		}
	}
	return false, nil
}

// extractFullWord widens [start, end) to the word around it: up to the characters `/[\s\W]/` matches,
// which on ASCII is every character but [A-Za-z0-9_].
func extractFullWord(text string, start, end int) string {
	for start > 0 && isWordChar(text[start-1]) {
		start--
	}
	for end < len(text) && isWordChar(text[end]) {
		end++
	}
	return text[start:end]
}

func isWordChar(c byte) bool {
	return ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z') || ('0' <= c && c <= '9') || c == '_'
}
