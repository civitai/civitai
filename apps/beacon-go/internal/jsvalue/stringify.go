package jsvalue

import (
	"math"
)

const hexDigits = "0123456789abcdef"

// AppendString appends JSON.stringify(s) for a WTF-8 string: `"` and `\` escaped, \b \t \n \f \r as
// two-character escapes, every other character below U+0020 and every unpaired surrogate as a
// lowercase \u00XX / \udXXX escape, everything else (U+2028, U+2029, `<`, `>`, `&` included) as is.
func AppendString(b []byte, s string) []byte {
	b = append(b, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' && c != 0xED {
			i++
			continue
		}
		if c == 0xED {
			r, size := DecodeWTF8(s[i:])
			if r < 0xD800 || r > 0xDFFF {
				i += size
				continue
			}
			b = append(b, s[start:i]...)
			b = append(b, '\\', 'u', hexDigits[r>>12&0xF], hexDigits[r>>8&0xF], hexDigits[r>>4&0xF], hexDigits[r&0xF])
			i += size
			start = i
			continue
		}
		b = append(b, s[start:i]...)
		switch c {
		case '"':
			b = append(b, '\\', '"')
		case '\\':
			b = append(b, '\\', '\\')
		case '\b':
			b = append(b, '\\', 'b')
		case '\t':
			b = append(b, '\\', 't')
		case '\n':
			b = append(b, '\\', 'n')
		case '\f':
			b = append(b, '\\', 'f')
		case '\r':
			b = append(b, '\\', 'r')
		default:
			b = append(b, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xF])
		}
		i++
		start = i
	}
	b = append(b, s[start:]...)
	return append(b, '"')
}

// AppendNumber appends JSON.stringify(n): Number::toString for a finite number, `null` otherwise.
func AppendNumber(b []byte, n float64) []byte {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return append(b, "null"...)
	}
	return append(b, FormatNumber(n)...)
}

// Append appends JSON.stringify(v).
func Append(b []byte, v Value) []byte {
	switch v.Kind {
	case Null:
		return append(b, "null"...)
	case Bool:
		if v.B {
			return append(b, "true"...)
		}
		return append(b, "false"...)
	case Number:
		return AppendNumber(b, v.N)
	case String:
		return AppendString(b, v.S)
	case Array:
		b = append(b, '[')
		for i, e := range v.A {
			if i > 0 {
				b = append(b, ',')
			}
			b = Append(b, e)
		}
		return append(b, ']')
	case ObjectKind:
		b = append(b, '{')
		for i, k := range v.O.Keys() {
			if i > 0 {
				b = append(b, ',')
			}
			b = AppendString(b, k)
			b = append(b, ':')
			e, _ := v.O.Get(k)
			b = Append(b, e)
		}
		return append(b, '}')
	}
	return b
}

// Stringify is JSON.stringify(v).
func Stringify(v Value) []byte { return Append(nil, v) }

// CountNodes is the number of values measureJsonLength's walk visits for v: v itself, plus every
// array element and own property below it.
func CountNodes(v Value) int {
	n := 1
	switch v.Kind {
	case Array:
		for _, e := range v.A {
			n += CountNodes(e)
		}
	case ObjectKind:
		for _, k := range v.O.Keys() {
			e, _ := v.O.Get(k)
			n += CountNodes(e)
		}
	}
	return n
}
