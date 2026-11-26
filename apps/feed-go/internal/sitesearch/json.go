package sitesearch

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// The response is reshaped without decoding it: a body is scanned into raw members, and only the
// members a rule changes are rebuilt. Every other byte is copied as Meilisearch wrote it. Node parses
// the whole body and writes it again with JSON.stringify, so the two agree on every value; the bytes
// can differ only where Meilisearch's spelling of a value is not JSON.stringify's (an integral float
// written `5.0`, an escaped character JSON.stringify writes raw), which a JSON reader cannot tell apart.

// errShape is a body this package does not reshape exactly as Node would: invalid JSON, a duplicate
// key, or a value of a kind the rule it reaches does not read as Node reads it.
var errShape = errors.New("sitesearch: unexpected response shape")

// member is one object member: its decoded key and its raw value.
type member struct {
	key string
	val []byte
}

// object is a JSON object as its members, in their order. JSON.parse keeps the members in this order
// (none is an array index here: every key the rules read or write is a name), so writing them in it
// is JSON.stringify's order.
type object struct {
	members []member
}

func (o *object) index(key string) int {
	for i := range o.members {
		if o.members[i].key == key {
			return i
		}
	}
	return -1
}

// get is the member's raw value, and whether the key is present (`key in obj`).
func (o *object) get(key string) ([]byte, bool) {
	if i := o.index(key); i >= 0 {
		return o.members[i].val, true
	}
	return nil, false
}

func (o *object) has(key string) bool { return o.index(key) >= 0 }

// set is `obj[key] = val`: in place when the key is present, else appended.
func (o *object) set(key string, val []byte) {
	if i := o.index(key); i >= 0 {
		o.members[i].val = val
		return
	}
	o.members = append(o.members, member{key: key, val: val})
}

// del is `delete obj[key]` (a destructuring rest without the key).
func (o *object) del(key string) {
	if i := o.index(key); i >= 0 {
		o.members = append(o.members[:i], o.members[i+1:]...)
	}
}

// clone is `{ ...obj }`: the same members in the same order.
func (o *object) clone() *object {
	return &object{members: append([]member(nil), o.members...)}
}

// appendTo writes the object as JSON.stringify writes it: each key as a JS string literal, each value
// as its raw bytes.
func (o *object) appendTo(dst []byte) []byte {
	dst = append(dst, '{')
	for i, m := range o.members {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = appendJSString(dst, m.key)
		dst = append(dst, ':')
		dst = append(dst, m.val...)
	}
	return append(dst, '}')
}

func (o *object) bytes() []byte { return o.appendTo(nil) }

// appendArray writes raw elements as a JSON array.
func appendArray(dst []byte, elems [][]byte) []byte {
	dst = append(dst, '[')
	for i, e := range elems {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = append(dst, e...)
	}
	return append(dst, ']')
}

var (
	rawNull       = []byte("null")
	rawEmptyArray = []byte("[]")
)

func isWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func skipWS(b []byte, i int) int {
	for i < len(b) && isWS(b[i]) {
		i++
	}
	return i
}

// trim drops the whitespace around a raw value.
func trim(b []byte) []byte {
	s, e := 0, len(b)
	for s < e && isWS(b[s]) {
		s++
	}
	for e > s && isWS(b[e-1]) {
		e--
	}
	return b[s:e]
}

// valueEnd is the index just past the value starting at b[i] (no leading whitespace). It assumes b is
// valid JSON (checked once with json.Valid before any scan).
func valueEnd(b []byte, i int) (int, error) {
	if i >= len(b) {
		return 0, errShape
	}
	switch b[i] {
	case '"':
		return stringEnd(b, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(b); j++ {
			switch b[j] {
			case '"':
				end, err := stringEnd(b, j)
				if err != nil {
					return 0, err
				}
				j = end - 1
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return j + 1, nil
				}
			}
		}
		return 0, errShape
	default:
		j := i
		for j < len(b) && b[j] != ',' && b[j] != '}' && b[j] != ']' && !isWS(b[j]) {
			j++
		}
		if j == i {
			return 0, errShape
		}
		return j, nil
	}
}

// stringEnd is the index just past the string literal opening at b[i].
func stringEnd(b []byte, i int) (int, error) {
	for j := i + 1; j < len(b); j++ {
		switch b[j] {
		case '\\':
			j++
		case '"':
			return j + 1, nil
		}
	}
	return 0, errShape
}

// parseObject scans a raw object into its members. A duplicate key is errShape: JSON.parse keeps the
// last value at the first key's position, which is not reproduced. b must be valid JSON.
func parseObject(b []byte) (*object, error) {
	b = trim(b)
	if len(b) < 2 || b[0] != '{' {
		return nil, errShape
	}
	o := &object{}
	i := skipWS(b, 1)
	if b[i] == '}' {
		return o, nil
	}
	for {
		if b[i] != '"' {
			return nil, errShape
		}
		end, err := stringEnd(b, i)
		if err != nil {
			return nil, err
		}
		key, err := decodeString(b[i:end])
		if err != nil {
			return nil, err
		}
		if o.has(key) {
			return nil, errShape
		}
		i = skipWS(b, end)
		if i >= len(b) || b[i] != ':' {
			return nil, errShape
		}
		i = skipWS(b, i+1)
		vend, err := valueEnd(b, i)
		if err != nil {
			return nil, err
		}
		o.members = append(o.members, member{key: key, val: b[i:vend]})
		i = skipWS(b, vend)
		if i >= len(b) {
			return nil, errShape
		}
		if b[i] == '}' {
			return o, nil
		}
		if b[i] != ',' {
			return nil, errShape
		}
		i = skipWS(b, i+1)
	}
}

// parseArray scans a raw array into its raw elements. b must be valid JSON.
func parseArray(b []byte) ([][]byte, error) {
	b = trim(b)
	if len(b) < 2 || b[0] != '[' {
		return nil, errShape
	}
	var out [][]byte
	i := skipWS(b, 1)
	if b[i] == ']' {
		return out, nil
	}
	for {
		end, err := valueEnd(b, i)
		if err != nil {
			return nil, err
		}
		out = append(out, b[i:end])
		i = skipWS(b, end)
		if i >= len(b) {
			return nil, errShape
		}
		if b[i] == ']' {
			return out, nil
		}
		if b[i] != ',' {
			return nil, errShape
		}
		i = skipWS(b, i+1)
	}
}

// decodeString decodes a raw string literal. One without an escape is its bytes.
func decodeString(raw []byte) (string, error) {
	inner := raw[1 : len(raw)-1]
	plain := true
	for _, c := range inner {
		if c == '\\' {
			plain = false
			break
		}
	}
	if plain {
		return string(inner), nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", errShape
	}
	return s, nil
}

func isObject(raw []byte) bool { return len(raw) > 0 && raw[0] == '{' }
func isArray(raw []byte) bool  { return len(raw) > 0 && raw[0] == '[' }
func isString(raw []byte) bool { return len(raw) > 0 && raw[0] == '"' }
func isNull(raw []byte) bool   { return string(raw) == "null" }

// truthy is JavaScript truthiness of a raw JSON value: null, false, 0 and "" are falsy.
func truthy(raw []byte) bool {
	switch {
	case len(raw) == 0, isNull(raw), string(raw) == "false", string(raw) == `""`:
		return false
	case raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9'):
		f, err := strconv.ParseFloat(string(raw), 64)
		return err != nil || f != 0
	}
	return true
}

// jsNumber is `Number(value)` for a raw JSON value, where this package reads one as Node does: a
// number literal, null (0), true (1) and false (0). ok is false for any other kind (a string, an
// array, an object), whose conversion is not reproduced, so the caller falls back. A value that is
// absent reads as NaN in Node; callers handle absence themselves.
func jsNumber(raw []byte) (float64, bool) {
	switch {
	case isNull(raw), string(raw) == "false":
		return 0, true
	case string(raw) == "true":
		return 1, true
	case len(raw) > 0 && (raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9')):
		f, err := strconv.ParseFloat(string(raw), 64)
		if err != nil {
			// Out of float64 range: JSON.parse reads it as ±Infinity, not reproduced.
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// int32Of is ToInt32 for the integers this package reads (a level or a rating). ok is false for a
// non-integer or one past int32 (ToInt32 would wrap it): the caller falls back.
func int32Of(f float64) (int32, bool) {
	if f != math.Trunc(f) || f < math.MinInt32 || f > math.MaxInt32 {
		return 0, false
	}
	return int32(f), true
}

// jsString is `String(value)` for the raw JSON values an image id can be: a string is its text, a
// boolean its name, an integer in the safe range its decimal digits. ok is false for any other kind
// (a fraction, an exponent past 2^53, an array, an object): their text is not reproduced.
func jsString(raw []byte) (string, bool) {
	switch {
	case isString(raw):
		s, err := decodeString(raw)
		return s, err == nil
	case string(raw) == "true", string(raw) == "false":
		return string(raw), true
	case len(raw) > 0 && (raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9')):
		f, err := strconv.ParseFloat(string(raw), 64)
		if err != nil || f != math.Trunc(f) || math.Abs(f) > 1<<53-1 {
			return "", false
		}
		return strconv.FormatInt(int64(f), 10), true
	}
	return "", false
}

// appendJSString writes s as JSON.stringify writes a string: `"` and `\` escaped, the C0 controls as
// \b \t \n \f \r or \u00XX (lowercase hex), everything else raw (U+2028 and U+2029 included).
func appendJSString(dst []byte, s string) []byte {
	const hex = "0123456789abcdef"
	dst = append(dst, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			dst = append(dst, '\\', '"')
		case c == '\\':
			dst = append(dst, '\\', '\\')
		case c == '\b':
			dst = append(dst, '\\', 'b')
		case c == '\t':
			dst = append(dst, '\\', 't')
		case c == '\n':
			dst = append(dst, '\\', 'n')
		case c == '\f':
			dst = append(dst, '\\', 'f')
		case c == '\r':
			dst = append(dst, '\\', 'r')
		case c < 0x20:
			dst = append(dst, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xf])
		default:
			dst = append(dst, c)
		}
	}
	return append(dst, '"')
}

// utf16Len is a string's `.length` in JavaScript: its UTF-16 code units (zod's max length counts them).
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// validBody reports whether raw is valid JSON in valid UTF-8. Node decodes the body with
// TextDecoder, which turns an invalid byte into U+FFFD; that text is not reproduced, so such a body
// falls back.
func validBody(raw []byte) bool {
	return utf8.Valid(raw) && json.Valid(raw)
}
