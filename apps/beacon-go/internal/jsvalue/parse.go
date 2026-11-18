package jsvalue

import (
	"errors"
	"strconv"
	"unicode/utf8"
)

// ErrSyntax is any input JSON.parse throws a SyntaxError for.
var ErrSyntax = errors.New("jsvalue: JSON syntax error")

// ErrTooDeep is input nested deeper than MaxDepth. JSON.parse accepts it; this parser refuses it, so
// a caller must treat it as "cannot answer", never as a syntax error.
var ErrTooDeep = errors.New("jsvalue: nesting deeper than MaxDepth")

// MaxDepth bounds array/object nesting.
const MaxDepth = 512

// Parse is JSON.parse(text). text is WTF-8 (a JS string).
func Parse(text string) (Value, error) {
	p := parser{s: text}
	p.ws()
	v, err := p.value(0)
	if err != nil {
		return Value{}, err
	}
	p.ws()
	if p.i != len(p.s) {
		return Value{}, ErrSyntax
	}
	return v, nil
}

type parser struct {
	s string
	i int
}

// ws skips JSON whitespace: space, tab, LF, CR (JSON.parse accepts no other).
func (p *parser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) value(depth int) (Value, error) {
	if p.i >= len(p.s) {
		return Value{}, ErrSyntax
	}
	switch c := p.s[p.i]; {
	case c == '{':
		return p.object(depth + 1)
	case c == '[':
		return p.array(depth + 1)
	case c == '"':
		s, err := p.str()
		if err != nil {
			return Value{}, err
		}
		return StringValue(s), nil
	case c == 't':
		return p.lit("true", BoolValue(true))
	case c == 'f':
		return p.lit("false", BoolValue(false))
	case c == 'n':
		return p.lit("null", NullValue())
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return Value{}, ErrSyntax
}

func (p *parser) lit(word string, v Value) (Value, error) {
	if len(p.s)-p.i < len(word) || p.s[p.i:p.i+len(word)] != word {
		return Value{}, ErrSyntax
	}
	p.i += len(word)
	return v, nil
}

func (p *parser) object(depth int) (Value, error) {
	if depth > MaxDepth {
		return Value{}, ErrTooDeep
	}
	p.i++ // {
	o := NewObject()
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return ObjectValue(o), nil
	}
	for {
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return Value{}, ErrSyntax
		}
		k, err := p.str()
		if err != nil {
			return Value{}, err
		}
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return Value{}, ErrSyntax
		}
		p.i++
		p.ws()
		v, err := p.value(depth)
		if err != nil {
			return Value{}, err
		}
		o.Set(k, v)
		p.ws()
		if p.i >= len(p.s) {
			return Value{}, ErrSyntax
		}
		switch p.s[p.i] {
		case ',':
			p.i++
		case '}':
			p.i++
			return ObjectValue(o), nil
		default:
			return Value{}, ErrSyntax
		}
	}
}

func (p *parser) array(depth int) (Value, error) {
	if depth > MaxDepth {
		return Value{}, ErrTooDeep
	}
	p.i++ // [
	a := []Value{}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return ArrayValue(a), nil
	}
	for {
		p.ws()
		v, err := p.value(depth)
		if err != nil {
			return Value{}, err
		}
		a = append(a, v)
		p.ws()
		if p.i >= len(p.s) {
			return Value{}, ErrSyntax
		}
		switch p.s[p.i] {
		case ',':
			p.i++
		case ']':
			p.i++
			return ArrayValue(a), nil
		default:
			return Value{}, ErrSyntax
		}
	}
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// number scans -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)? and converts it as V8 does (correctly
// rounded; out of range is ±Infinity, below the smallest subnormal is ±0).
func (p *parser) number() (Value, error) {
	start := p.i
	if p.s[p.i] == '-' {
		p.i++
	}
	if p.i >= len(p.s) {
		return Value{}, ErrSyntax
	}
	switch {
	case p.s[p.i] == '0':
		p.i++
	case isDigit(p.s[p.i]):
		for p.i < len(p.s) && isDigit(p.s[p.i]) {
			p.i++
		}
	default:
		return Value{}, ErrSyntax
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if p.i >= len(p.s) || !isDigit(p.s[p.i]) {
			return Value{}, ErrSyntax
		}
		for p.i < len(p.s) && isDigit(p.s[p.i]) {
			p.i++
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if p.i >= len(p.s) || !isDigit(p.s[p.i]) {
			return Value{}, ErrSyntax
		}
		for p.i < len(p.s) && isDigit(p.s[p.i]) {
			p.i++
		}
	}
	// The grammar above is a subset of what ParseFloat accepts; a range error still carries the
	// correctly rounded result (±Inf on overflow, ±0 on underflow), which is what V8 produces.
	f, err := strconv.ParseFloat(p.s[start:p.i], 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return Value{}, ErrSyntax
	}
	return NumberValue(f), nil
}

func hexVal(c byte) (uint16, bool) {
	switch {
	case c >= '0' && c <= '9':
		return uint16(c - '0'), true
	case c >= 'a' && c <= 'f':
		return uint16(c-'a') + 10, true
	case c >= 'A' && c <= 'F':
		return uint16(c-'A') + 10, true
	}
	return 0, false
}

// str scans a string token. JSON.parse refuses a raw character below U+0020; everything else is
// copied, and the result is the JS string's code units re-encoded as WTF-8 (so an escaped high
// surrogate followed by an escaped low one is one character, as in JS).
func (p *parser) str() (string, error) {
	p.i++ // opening quote
	start := p.i
	// Fast path: no escapes and no surrogate bytes, so the token's bytes are the string.
	for p.i < len(p.s) {
		c := p.s[p.i]
		if c == '"' {
			out := p.s[start:p.i]
			p.i++
			return out, nil
		}
		if c < 0x20 {
			return "", ErrSyntax
		}
		if c == '\\' || c == 0xED {
			break
		}
		p.i++
	}
	if p.i >= len(p.s) {
		return "", ErrSyntax
	}
	units := make([]uint16, 0, (p.i-start)+16)
	units = appendUnits(units, p.s[start:p.i])
	for p.i < len(p.s) {
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return EncodeUnits(units), nil
		case c < 0x20:
			return "", ErrSyntax
		case c == '\\':
			if p.i+1 >= len(p.s) {
				return "", ErrSyntax
			}
			e := p.s[p.i+1]
			p.i += 2
			switch e {
			case '"':
				units = append(units, '"')
			case '\\':
				units = append(units, '\\')
			case '/':
				units = append(units, '/')
			case 'b':
				units = append(units, '\b')
			case 'f':
				units = append(units, '\f')
			case 'n':
				units = append(units, '\n')
			case 'r':
				units = append(units, '\r')
			case 't':
				units = append(units, '\t')
			case 'u':
				if p.i+4 > len(p.s) {
					return "", ErrSyntax
				}
				var u uint16
				for k := 0; k < 4; k++ {
					h, ok := hexVal(p.s[p.i+k])
					if !ok {
						return "", ErrSyntax
					}
					u = u<<4 | h
				}
				p.i += 4
				units = append(units, u)
			default:
				return "", ErrSyntax
			}
		default:
			r, size := DecodeWTF8(p.s[p.i:])
			units = appendRune(units, r)
			p.i += size
		}
	}
	return "", ErrSyntax
}

// DecodeWTF8 decodes one code point of WTF-8: UTF-8, plus 3-byte surrogate code points. An invalid
// byte decodes as U+FFFD (size 1); input here is always the output of a decoder or of this package.
func DecodeWTF8(s string) (rune, int) {
	if len(s) >= 3 && s[0] == 0xED && s[1] >= 0xA0 && s[1] <= 0xBF && s[2] >= 0x80 && s[2] <= 0xBF {
		return rune(0xD000) | rune(s[1]&0x3F)<<6 | rune(s[2]&0x3F), 3
	}
	return utf8.DecodeRuneInString(s)
}

func appendRune(units []uint16, r rune) []uint16 {
	if r >= 0x10000 {
		r -= 0x10000
		return append(units, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF))) //nolint:gosec // G115: r < 0x100000 here, both halves fit in 16 bits
	}
	return append(units, uint16(r)) //nolint:gosec // G115: r < 0x10000 here
}

// appendUnits appends the UTF-16 code units of a WTF-8 string.
func appendUnits(units []uint16, s string) []uint16 {
	for i := 0; i < len(s); {
		r, size := DecodeWTF8(s[i:])
		units = appendRune(units, r)
		i += size
	}
	return units
}

// Units returns the UTF-16 code units of a WTF-8 string (a JS string's .charCodeAt sequence).
func Units(s string) []uint16 { return appendUnits(nil, s) }

// EncodeUnits encodes UTF-16 code units as WTF-8: a surrogate pair becomes one 4-byte character, an
// unpaired surrogate its 3-byte encoding.
func EncodeUnits(units []uint16) string {
	b := make([]byte, 0, len(units))
	for i := 0; i < len(units); i++ {
		u := units[i]
		if u >= 0xD800 && u <= 0xDBFF && i+1 < len(units) && units[i+1] >= 0xDC00 && units[i+1] <= 0xDFFF {
			r := 0x10000 + (rune(u)-0xD800)<<10 + (rune(units[i+1]) - 0xDC00)
			b = utf8.AppendRune(b, r)
			i++
			continue
		}
		if u >= 0xD800 && u <= 0xDFFF {
			b = append(b, 0xED, byte(0xA0|(u>>6)&0x1F), byte(0x80|u&0x3F)) //nolint:gosec // G115: masked to 5 and 6 bits
			continue
		}
		b = utf8.AppendRune(b, rune(u))
	}
	return string(b)
}

// UTF16Len is a JS string's .length: its UTF-16 code units.
func UTF16Len(s string) int {
	n := 0
	for i := 0; i < len(s); {
		r, size := DecodeWTF8(s[i:])
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
		i += size
	}
	return n
}
