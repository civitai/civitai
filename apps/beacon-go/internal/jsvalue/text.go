package jsvalue

import (
	"unicode/utf8"
)

// DecodeUTF8 decodes bytes as the WHATWG UTF-8 decoder does (what Node's Buffer#toString('utf8') and
// TextDecoder do): each maximal subpart of an ill-formed sequence becomes one U+FFFD. The result is
// valid UTF-8 (never a surrogate).
func DecodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	out := make([]byte, 0, len(b)+8)
	const replacement = "\uFFFD"
	i := 0
	for i < len(b) {
		c := b[i]
		if c < 0x80 {
			out = append(out, c)
			i++
			continue
		}
		var need int
		lower, upper := byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c >= 0xE0 && c <= 0xEF:
			need = 2
			switch c {
			case 0xE0:
				lower = 0xA0
			case 0xED:
				upper = 0x9F
			}
		case c >= 0xF0 && c <= 0xF4:
			need = 3
			switch c {
			case 0xF0:
				lower = 0x90
			case 0xF4:
				upper = 0x8F
			}
		default:
			out = append(out, replacement...)
			i++
			continue
		}
		j := i + 1
		ok := true
		for k := 0; k < need; k++ {
			if j >= len(b) {
				ok = false
				break
			}
			cc := b[j]
			if cc < lower || cc > upper {
				ok = false
				break
			}
			lower, upper = 0x80, 0xBF
			j++
		}
		if !ok {
			// The maximal subpart b[i:j] is replaced; decoding resumes at the byte that broke it.
			out = append(out, replacement...)
			i = j
			continue
		}
		out = append(out, b[i:j]...)
		i = j
	}
	return string(out)
}

// Latin1 is how Node's HTTP parser turns header bytes into a JS string: each byte one code unit
// (U+0000..U+00FF), here re-encoded as UTF-8.
func Latin1(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return s
	}
	out := make([]byte, 0, len(s)*2)
	for i := 0; i < len(s); i++ {
		out = utf8.AppendRune(out, rune(s[i]))
	}
	return string(out)
}
