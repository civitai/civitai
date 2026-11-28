package profanity

import "strings"

// The word rules of @civitai/mod-utils/profanity/word-rules (cleanWord, isValidWord,
// isUsableBlockedEntry, managedProfanityEntries), for ASCII entries only: every caller has already
// refused a non-ASCII entry (JavaScript's trim, toLowerCase and `\s` differ from these past ASCII).

// jsSpace is JavaScript's `\s` and String.prototype.trim's set, restricted to ASCII. Not Go's `\s`
// (which lacks `\v`) nor strings.TrimSpace (which also trims U+0085 and U+00A0).
const jsSpace = "\t\n\v\f\r "

func isJSSpace(c byte) bool { return strings.IndexByte(jsSpace, c) >= 0 }

// jsTrim is String.prototype.trim over ASCII text.
func jsTrim(s string) string { return strings.Trim(s, jsSpace) }

// asciiLower is String.prototype.toLowerCase over ASCII text.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// cleanWord: strip `\w*`, `?`, brackets, `*` and `+`, trim, lower-case; the `|` markers stay.
func cleanWord(word string) string {
	word = strings.ReplaceAll(word, `\w*`, "")
	word = strings.Map(func(r rune) rune {
		switch r {
		case '?', '[', ']', '(', ')', '{', '}', '*', '+':
			return -1
		}
		return r
	}, word)
	return asciiLower(jsTrim(word))
}

// isValidWord: whether the filter keeps an entry when it builds its word list.
func isValidWord(word string) bool {
	cleaned := cleanWord(word)
	content := strings.ReplaceAll(cleaned, "|", "")
	minLength := 2
	if strings.Contains(cleaned, "|") {
		minLength = 1
	}
	if len(content) < minLength || strings.Contains(cleaned, `\`) || cleaned == "" {
		return false
	}
	// /^[a-z\s\-'|]+$/i
	for i := 0; i < len(cleaned); i++ {
		c := cleaned[i]
		if ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z') || isJSSpace(c) || c == '-' || c == '\'' || c == '|' {
			continue
		}
		return false
	}
	return true
}

// rules holds what word-rules reads from the shipped list (isShippedEntry) and its constants.
type rules struct {
	shipped              map[string]struct{}
	minDatasetWordLength int
	minUnboundedLetters  int
	minManagedEntries    int
}

func newRules(d *Data) *rules {
	shipped := make(map[string]struct{}, len(d.BlockedWords))
	for _, w := range d.BlockedWords {
		shipped[cleanWord(w)] = struct{}{}
	}
	return &rules{shipped: shipped, minDatasetWordLength: d.MinDatasetWordLength,
		minUnboundedLetters: d.MinUnboundedLetters, minManagedEntries: d.MinManagedEntries}
}

// usable is isUsableBlockedEntry.
func (r *rules) usable(entry string) bool {
	cleaned := cleanWord(entry)
	if !isValidWord(entry) {
		return false
	}
	inner := ""
	if len(cleaned) >= 2 {
		inner = cleaned[1 : len(cleaned)-1]
	}
	if strings.Contains(inner, "|") || len(cleaned) < r.minDatasetWordLength {
		return false
	}
	letters := 0
	for i := 0; i < len(cleaned); i++ {
		if 'a' <= cleaned[i] && cleaned[i] <= 'z' {
			letters++
		}
	}
	need := r.minUnboundedLetters
	_, isShipped := r.shipped[cleaned]
	if strings.HasPrefix(cleaned, "|") || strings.HasSuffix(cleaned, "|") || isShipped {
		need = r.minDatasetWordLength
	}
	return letters >= need
}

// managed is managedProfanityEntries: the usable entries, and whether enough distinct ones (by
// cleanWord) remain for the list to be enforced.
func (r *rules) managed(entries []string) (usable []string, enforced bool) {
	distinct := map[string]struct{}{}
	for _, e := range entries {
		if r.usable(e) {
			usable = append(usable, e)
			distinct[cleanWord(e)] = struct{}{}
		}
	}
	return usable, len(distinct) >= r.minManagedEntries
}

// nsfwWords is processNsfwWords: the valid entries, cleaned, without duplicates (the order only
// decides obscenity's term ids, which no verdict reads).
func nsfwWords(entries []string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, e := range entries {
		if !isValidWord(e) {
			continue
		}
		c := cleanWord(e)
		if _, ok := seen[c]; ok {
			continue
		}
		seen[c] = struct{}{}
		out = append(out, c)
	}
	return out
}
