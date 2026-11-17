// Package jsvalue reproduces the parts of JavaScript's value model the beacon handlers' output depends
// on, so that the bytes this service writes are the bytes `JSON.stringify` writes in the Node app:
//
//   - JSON.parse (Parse): strict RFC 8259, `__proto__` an ordinary own key, a repeated key keeps its
//     first position and its last value, numbers as IEEE doubles (overflow is ±Infinity);
//   - object key order (Object): array-index keys ascending first, then the others in insertion order;
//   - JSON.stringify (Stringify): well-formed (a lone surrogate is written as a `\udXXX` escape),
//     non-finite numbers as `null`, no HTML escaping, U+2028/U+2029 written raw;
//   - Number(string) (StringToNumber) and Number::toString (FormatNumber);
//   - String.prototype.trim (Trim).
//
// Strings are Go strings holding WTF-8: UTF-8, plus the 3-byte encoding of an unpaired surrogate
// (ED A0..BF xx), which is how a JS string holding one survives here.
package jsvalue

import (
	"strconv"
)

// Kind is a JSON value's type.
type Kind uint8

// The JSON value kinds.
const (
	Null Kind = iota
	Bool
	Number
	String
	Array
	ObjectKind
)

// Value is one JSON value. Only the field for its Kind is meaningful.
type Value struct {
	Kind Kind
	B    bool
	N    float64
	S    string
	A    []Value
	O    *Object
}

// NullValue is JSON null.
func NullValue() Value { return Value{Kind: Null} }

// BoolValue is a JSON boolean.
func BoolValue(b bool) Value { return Value{Kind: Bool, B: b} }

// NumberValue is a JSON number.
func NumberValue(n float64) Value { return Value{Kind: Number, N: n} }

// StringValue is a JSON string (WTF-8).
func StringValue(s string) Value { return Value{Kind: String, S: s} }

// ArrayValue is a JSON array.
func ArrayValue(a []Value) Value { return Value{Kind: Array, A: a} }

// ObjectValue is a JSON object.
func ObjectValue(o *Object) Value { return Value{Kind: ObjectKind, O: o} }

// IsPlainObject is zod's isObject: an object that is neither null nor an array.
func (v Value) IsPlainObject() bool { return v.Kind == ObjectKind }

// Object is a JS ordinary object's own enumerable string-keyed properties, in JS property order:
// integer-index keys (canonical numeric strings below 2^32-1) ascending, then every other key in the
// order it was first defined.
type Object struct {
	index   []string // array-index keys, kept sorted by numeric value
	named   []string // other keys, insertion order
	values  map[string]Value
	indexOf map[string]uint32
}

// NewObject returns an empty object.
func NewObject() *Object {
	return &Object{values: map[string]Value{}, indexOf: map[string]uint32{}}
}

// arrayIndex reports whether k is an array index: the canonical decimal string of an integer in
// [0, 2^32-2] ("0", or no leading zero).
func arrayIndex(k string) (uint32, bool) {
	if k == "" || len(k) > 10 {
		return 0, false
	}
	if len(k) > 1 && k[0] == '0' {
		return 0, false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n >= 1<<32-1 {
		return 0, false
	}
	return uint32(n), true //nolint:gosec // G115: n < 2^32-1, checked above
}

// Set defines or overwrites a property. An existing key keeps its position.
func (o *Object) Set(k string, v Value) {
	if _, ok := o.values[k]; ok {
		o.values[k] = v
		return
	}
	o.values[k] = v
	if n, ok := arrayIndex(k); ok {
		o.indexOf[k] = n
		// Insert keeping numeric order (objects here are small; a linear scan is fine).
		i := len(o.index)
		for i > 0 && o.indexOf[o.index[i-1]] > n {
			i--
		}
		o.index = append(o.index, "")
		copy(o.index[i+1:], o.index[i:])
		o.index[i] = k
		return
	}
	o.named = append(o.named, k)
}

// Get returns a property.
func (o *Object) Get(k string) (Value, bool) {
	v, ok := o.values[k]
	return v, ok
}

// Has reports whether the property exists (JS `k in o` for an own property).
func (o *Object) Has(k string) bool {
	_, ok := o.values[k]
	return ok
}

// Len is the number of properties.
func (o *Object) Len() int { return len(o.values) }

// Keys returns the keys in JS property order (`for...in` / `Object.keys` / JSON.stringify order).
func (o *Object) Keys() []string {
	out := make([]string, 0, len(o.index)+len(o.named))
	out = append(out, o.index...)
	return append(out, o.named...)
}
