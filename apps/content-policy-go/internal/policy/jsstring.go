package policy

import (
	"strings"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// jsTrim is String.prototype.trim: it strips the ECMAScript WhiteSpace and LineTerminator code
// points from both ends. Not strings.TrimSpace, whose set differs both ways: it strips U+0085 (NEL),
// which JS keeps, and keeps U+FEFF (BOM), which JS strips. The vectors pin both.
func jsTrim(s string) string { return strings.TrimFunc(s, isJSWhitespace) }

func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// jsUpper is String.prototype.toUpperCase: the locale-independent full case mapping, so `ß` becomes
// `SS` and `ſ` becomes `S` (strings.ToUpper uses the simple mapping and leaves `ß` as it is). ASCII,
// every value the edge sends, takes the fast path.
func jsUpper(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return strings.ToUpper(s)
	}
	// A Caser keeps state, so it is never shared between goroutines.
	return cases.Upper(language.Und).String(s)
}
