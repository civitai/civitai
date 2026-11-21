// Package devalue writes a tRPC response payload as the main app writes it with
// `TRPC_WRITE_DEVALUE=true`: devalue's `stringify` (the `devalue` package the repo resolves, 5.9.x,
// node_modules/devalue/src/stringify.js), byte for byte.
//
// devalue flattens a value into one JSON array. Every distinct value gets an index in the order the
// walk first reaches it (a parent before its children), and a value reached again is written as the
// index it already has:
//
//   - primitives are the same value when they are equal (devalue keys a JS Map by them): every
//     repeated string, number, boolean and null is written once;
//   - objects, arrays and Dates are the same value only when they are the same INSTANCE. Here that
//     is the same Go reference: one superjson.Object / []any / []int / Map / Set backing array (a
//     slice of capacity 0 has no backing array of its own, so it is always a new value), one
//     *time.Time or *superjson.Object pointer, one json.RawMessage buffer. A time.Time value is
//     always a new Date. The builders put one reference wherever the Node code puts one instance
//     (feed.buildImage's `sortAt`, a creator's `cosmetics`), so the indexes Node assigns are the
//     indexes written here.
//
// Special values have fixed negative indexes and are never entries: undefined -1, NaN -3,
// Infinity -4, -Infinity -5, -0 -6. An object member that is undefined is written (`"k":-1`), unlike
// JSON. A Date is `["Date","<toISOString>"]`.
//
// Strings are written as devalue's stringify_string writes them: `"`, `\`, `<` (as \u003C), \b \f \n
// \r \t, U+2028, U+2029 and the other control characters (\u00xx) escaped, everything else as is.
// Object keys are in JS property order: array-index keys ("0", "17") first in ascending order, then
// the rest in insertion order.
//
// tRPC then puts that string in its envelope with JSON.stringify, so the payload this package
// returns is the devalue text as a JSON string literal (trpc.WriteResult writes
// `{"result":{"data":<payload>}}`). The client tells the formats apart by type: a string `data` is
// devalue, an object is superjson (src/shared/utils/trpc-union-transformer.ts).
//
// Supported values: the superjson value model (nil, superjson.Undefined, bool, string, every int,
// uint and float kind, time.Time, *time.Time, json.RawMessage, superjson.Object, *superjson.Object,
// []any, []int), plus Map, Set and BigInt, which devalue also writes and no feed produces today.
// Anything else is an error: the caller then writes superjson, as the Node writer falls back to
// superjson when devalue refuses a payload (writeSerializeWithFallback).
package devalue

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"
	"unsafe"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The fixed indexes devalue writes for values that are never entries (devalue/src/constants.js).
const (
	idxUndefined    = -1
	idxNaN          = -3
	idxPosInfinity  = -4
	idxNegInfinity  = -5
	idxNegativeZero = -6
)

// Map is a JS Map: entries in insertion order. Written as `["Map",k1,v1,…]`.
type Map []MapEntry

// MapEntry is one Map entry.
type MapEntry struct {
	Key, Val any
}

// Set is a JS Set: values in insertion order. Written as `["Set",v1,…]`.
type Set []any

// BigInt is a JS bigint, as its decimal digits (an optional leading "-"). Written as
// `["BigInt","<digits>"]`; equal BigInts are one value, as for any primitive.
type BigInt string

// refKind tells apart references that share an address but are different JS values (an Object and
// the []any of its first field cannot, but a typed pointer and a slice of its pointee type can).
type refKind uint8

const (
	refObject refKind = iota + 1
	refArray
	refInts
	refDate
	refMap
	refSet
	refRaw
)

// ref is a reference's identity. p is an unsafe.Pointer, not a uintptr, so the map holding it keeps
// the referenced value alive for the walk: a freed address reused by a later allocation (a parsed
// json.RawMessage) can never read as an earlier value.
type ref struct {
	kind refKind
	p    unsafe.Pointer
	n    int
}

// span is one entry's bytes in encoder.arena.
type span struct{ off, n int }

// Encoder pool, as superjson's: a page answer is a few hundred KiB, and an encoder whose output grew
// past maxPooled is left to the collector.
const (
	initialOut = 256 << 10
	maxPooled  = 2 << 20
)

var pool = sync.Pool{New: func() any {
	return &encoder{
		arena: make([]byte, 0, initialOut),
		out:   make([]byte, 0, initialOut),
		strs:  map[string]int{},
		nums:  map[float64]int{},
		bigs:  map[string]int{},
		refs:  map[ref]int{},
		raws:  map[ref]any{},
	}
}}

type encoder struct {
	// arena holds every finished entry; spans[i] is entry i's place in it.
	arena []byte
	spans []span
	// scratch[d] is the buffer of the entry being built at nesting depth d: a parent's entry is
	// finished after its children's, which are built one level deeper.
	scratch [][]byte
	depth   int

	strs map[string]int
	nums map[float64]int
	bigs map[string]int
	refs map[ref]int
	// raws holds each json.RawMessage parsed once, so the same buffer is the same value.
	raws map[ref]any
	// The index of null / false / true, plus one (0 = not written yet).
	null, falseIdx, trueIdx int
	// bare: the root is a special value, so the text is its index alone, not an array.
	bare bool

	out []byte
}

func (e *encoder) reset() {
	e.arena, e.spans, e.out = e.arena[:0], e.spans[:0], e.out[:0]
	for i := range e.scratch {
		e.scratch[i] = e.scratch[i][:0]
	}
	e.depth = 0
	clear(e.strs)
	clear(e.nums)
	clear(e.bigs)
	clear(e.refs)
	clear(e.raws)
	e.null, e.falseIdx, e.trueIdx = 0, 0, 0
	e.bare = false
}

// Buffer is an encoded payload held in a pooled buffer, owned as superjson.Buffer is: one owner
// calls Release once nothing reads Bytes any more. Release is idempotent; after it Bytes is nil.
type Buffer struct {
	e *encoder
}

// Bytes is the payload: the devalue text as a JSON string literal. Valid until Release.
func (b *Buffer) Bytes() []byte {
	if b == nil || b.e == nil {
		return nil
	}
	return b.e.out
}

// Release hands the buffer back to the pool. Safe on a nil Buffer and when called twice.
func (b *Buffer) Release() {
	if b == nil || b.e == nil {
		return
	}
	e := b.e
	b.e = nil
	put(e)
}

func get() *encoder {
	e, _ := pool.Get().(*encoder)
	e.reset()
	return e
}

func put(e *encoder) {
	if cap(e.out) > maxPooled || cap(e.arena) > maxPooled {
		return
	}
	e.reset()
	pool.Put(e)
}

// PayloadBuffer returns v as the tRPC payload Node writes with devalue: `devalue.stringify(v)` as a
// JSON string literal, in a pooled Buffer the caller must Release. A value devalue cannot write
// returns an error and no Buffer.
func PayloadBuffer(v any) (*Buffer, error) {
	e := get()
	if err := e.encode(v); err != nil {
		put(e)
		return nil, err
	}
	e.out = appendJSONStringOf(e.out, e)
	return &Buffer{e: e}, nil
}

// Payload is PayloadBuffer into a slice the caller owns.
func Payload(v any) ([]byte, error) {
	b, err := PayloadBuffer(v)
	if err != nil {
		return nil, err
	}
	out := bytes.Clone(b.Bytes())
	b.Release()
	return out, nil
}

// Stringify returns `devalue.stringify(v)`: the devalue text itself, not JSON-quoted.
func Stringify(v any) (string, error) {
	e := get()
	defer put(e)
	if err := e.encode(v); err != nil {
		return "", err
	}
	e.out = e.appendText(e.out)
	return string(e.out), nil
}

// encode flattens v into the entries. A special root (undefined, NaN, ±Infinity, -0) has no entry:
// stringify then returns that index alone, as text ("-1").
func (e *encoder) encode(v any) error {
	root, err := e.flatten(v)
	if err != nil {
		return err
	}
	if root < 0 {
		e.bare = true
		e.arena = strconv.AppendInt(e.arena[:0], int64(root), 10)
	}
	return nil
}

// appendText appends the devalue text: `[e0,e1,…]`, or the bare special index.
func (e *encoder) appendText(dst []byte) []byte {
	if e.bare {
		return append(dst, e.arena...)
	}
	dst = append(dst, '[')
	for i, s := range e.spans {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = append(dst, e.arena[s.off:s.off+s.n]...)
	}
	return append(dst, ']')
}

// appendJSONStringOf appends the devalue text as JSON.stringify writes it as a string, without
// building the text first.
func appendJSONStringOf(dst []byte, e *encoder) []byte {
	dst = append(dst, '"')
	if e.bare {
		dst = appendJSONEscaped(dst, e.arena)
		return append(dst, '"')
	}
	dst = append(dst, '[')
	for i, s := range e.spans {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = appendJSONEscaped(dst, e.arena[s.off:s.off+s.n])
	}
	return append(dst, ']', '"')
}

// next allocates the next index; close (or setEntry) stores its bytes once the value is written.
func (e *encoder) next() int {
	e.spans = append(e.spans, span{})
	return len(e.spans) - 1
}

func (e *encoder) setEntry(i int, b []byte) {
	e.spans[i] = span{off: len(e.arena), n: len(b)}
	e.arena = append(e.arena, b...)
}

// open returns the scratch buffer for an entry built at the next depth.
func (e *encoder) open() []byte {
	if e.depth == len(e.scratch) {
		e.scratch = append(e.scratch, make([]byte, 0, 256))
	}
	b := e.scratch[e.depth][:0]
	e.depth++
	return b
}

// close stores entry i from b (the buffer open returned) and hands the buffer back.
func (e *encoder) close(i int, b []byte) {
	e.depth--
	e.setEntry(i, b)
	e.scratch[e.depth] = b[:0]
}

func appendIndex(dst []byte, i int) []byte { return strconv.AppendInt(dst, int64(i), 10) }

// seen returns r's index when the walk has already reached it; otherwise it allocates and records one.
func (e *encoder) seen(r ref) (int, bool) {
	if i, ok := e.refs[r]; ok {
		return i, true
	}
	i := e.next()
	e.refs[r] = i
	return i, false
}

// sliceRef is the identity of a slice: its backing array and length. A slice without capacity has
// no backing array of its own (every empty literal shares one address), so it has no identity: ok is
// false and it is always a new value.
func sliceRef[T any](kind refKind, s []T) (ref, bool) {
	if cap(s) == 0 {
		return ref{}, false
	}
	return ref{kind: kind, p: unsafe.Pointer(unsafe.SliceData(s)), n: len(s)}, true
}

func (e *encoder) flatten(v any) (int, error) {
	switch t := v.(type) {
	case superjson.Undefined:
		return idxUndefined, nil
	case nil:
		return e.primitive(&e.null, "null"), nil
	case bool:
		if t {
			return e.primitive(&e.trueIdx, "true"), nil
		}
		return e.primitive(&e.falseIdx, "false"), nil
	case string:
		if i, ok := e.strs[t]; ok {
			return i, nil
		}
		i := e.next()
		e.strs[t] = i
		b := e.open()
		b = appendDevalueString(b, t)
		e.close(i, b)
		return i, nil
	case int:
		return e.number(float64(t)), nil
	case int8:
		return e.number(float64(t)), nil
	case int16:
		return e.number(float64(t)), nil
	case int32:
		return e.number(float64(t)), nil
	case int64:
		return e.number(float64(t)), nil
	case uint:
		return e.number(float64(t)), nil
	case uint8:
		return e.number(float64(t)), nil
	case uint16:
		return e.number(float64(t)), nil
	case uint32:
		return e.number(float64(t)), nil
	case uint64:
		return e.number(float64(t)), nil
	case float32:
		return e.number(float64(t)), nil
	case float64:
		return e.number(t), nil
	case BigInt:
		if i, ok := e.bigs[string(t)]; ok {
			return i, nil
		}
		if !validBigInt(string(t)) {
			return 0, fmt.Errorf("devalue: %q is not a bigint", string(t))
		}
		i := e.next()
		e.bigs[string(t)] = i
		b := e.open()
		b = append(b, `["BigInt","`...)
		b = append(b, string(t)...)
		b = append(b, `"]`...)
		e.close(i, b)
		return i, nil
	case time.Time:
		return e.date(t, e.next()), nil
	case *time.Time:
		if t == nil {
			return e.primitive(&e.null, "null"), nil
		}
		i, ok := e.seen(ref{kind: refDate, p: unsafe.Pointer(t)})
		if ok {
			return i, nil
		}
		return e.date(*t, i), nil
	case superjson.Object:
		return e.object(t)
	case *superjson.Object:
		if t == nil {
			return e.primitive(&e.null, "null"), nil
		}
		return e.object(*t)
	case []any:
		return e.array(t)
	case []int:
		r, has := sliceRef(refInts, t)
		var i int
		if has {
			var ok bool
			if i, ok = e.seen(r); ok {
				return i, nil
			}
		} else {
			i = e.next()
		}
		b := e.open()
		b = append(b, '[')
		for k, n := range t {
			if k > 0 {
				b = append(b, ',')
			}
			b = appendIndex(b, e.number(float64(n)))
		}
		b = append(b, ']')
		e.close(i, b)
		return i, nil
	case json.RawMessage:
		return e.raw(t)
	case Map:
		return e.mapValue(t)
	case Set:
		return e.set(t)
	}
	return 0, fmt.Errorf("devalue: unsupported type %T", v)
}

// primitive writes null / true / false once and returns its index (*slot holds it plus one).
func (e *encoder) primitive(slot *int, text string) int {
	if *slot > 0 {
		return *slot - 1
	}
	i := e.next()
	*slot = i + 1
	b := e.open()
	b = append(b, text...)
	e.close(i, b)
	return i
}

// number is a JS number: the special indexes first (NaN, ±Infinity, -0), then one entry per value,
// written as String(n).
func (e *encoder) number(f float64) int {
	switch {
	case math.IsNaN(f):
		return idxNaN
	case math.IsInf(f, 1):
		return idxPosInfinity
	case math.IsInf(f, -1):
		return idxNegInfinity
	case f == 0 && math.Signbit(f):
		return idxNegativeZero
	}
	if i, ok := e.nums[f]; ok {
		return i
	}
	i := e.next()
	e.nums[f] = i
	b := e.open()
	b = append(b, superjson.FormatNumber(f)...)
	e.close(i, b)
	return i
}

// date writes entry i as a Date.
func (e *encoder) date(t time.Time, i int) int {
	b := e.open()
	b = append(b, `["Date","`...)
	b = AppendISODate(b, t)
	b = append(b, `"]`...)
	e.close(i, b)
	return i
}

// maxDateMillis is the largest |time value| a JS Date holds (ECMA-262 TimeClip); past it the Date is
// invalid and devalue writes its ISO string as "".
const maxDateMillis = 8.64e15

// AppendISODate appends Date#toISOString for t: UTC, millisecond precision (truncated, as the
// superjson writer formats it), a four-digit year in 0000–9999 and the expanded ±YYYYYY form
// outside it. A t past a JS Date's range appends nothing (devalue writes an invalid Date as "").
func AppendISODate(dst []byte, t time.Time) []byte {
	u := t.UTC()
	sec := u.Unix()
	if sec > maxDateMillis/1000+1 || sec < -maxDateMillis/1000-1 {
		return dst
	}
	if ms := sec*1000 + int64(u.Nanosecond()/1e6); ms > maxDateMillis || ms < -maxDateMillis {
		return dst
	}
	y := u.Year()
	if y >= 0 && y <= 9999 {
		return u.AppendFormat(dst, "2006-01-02T15:04:05.000Z")
	}
	if y < 0 {
		dst = append(dst, '-')
		y = -y
	} else {
		dst = append(dst, '+')
	}
	ys := strconv.Itoa(y)
	for k := len(ys); k < 6; k++ {
		dst = append(dst, '0')
	}
	dst = append(dst, ys...)
	return u.AppendFormat(dst, "-01-02T15:04:05.000Z")
}

func (e *encoder) object(o superjson.Object) (int, error) {
	r, has := sliceRef(refObject, o)
	var i int
	if has {
		var ok bool
		if i, ok = e.seen(r); ok {
			return i, nil
		}
	} else {
		i = e.next()
	}
	b := e.open()
	b = append(b, '{')
	first := true
	err := forEachInJSOrder(o, func(f superjson.Field) error {
		if !first {
			b = append(b, ',')
		}
		first = false
		if f.Key == "__proto__" {
			return errors.New("devalue: cannot stringify objects with __proto__ keys")
		}
		b = appendDevalueString(b, f.Key)
		b = append(b, ':')
		ci, err := e.flatten(f.Val)
		if err != nil {
			return err
		}
		b = appendIndex(b, ci)
		return nil
	})
	if err != nil {
		return 0, err
	}
	b = append(b, '}')
	e.close(i, b)
	return i, nil
}

func (e *encoder) array(a []any) (int, error) {
	r, has := sliceRef(refArray, a)
	var i int
	if has {
		var ok bool
		if i, ok = e.seen(r); ok {
			return i, nil
		}
	} else {
		i = e.next()
	}
	b := e.open()
	b = append(b, '[')
	for k, v := range a {
		if k > 0 {
			b = append(b, ',')
		}
		ci, err := e.flatten(v)
		if err != nil {
			return 0, err
		}
		b = appendIndex(b, ci)
	}
	b = append(b, ']')
	e.close(i, b)
	return i, nil
}

func (e *encoder) mapValue(m Map) (int, error) {
	r, has := sliceRef(refMap, m)
	var i int
	if has {
		var ok bool
		if i, ok = e.seen(r); ok {
			return i, nil
		}
	} else {
		i = e.next()
	}
	b := e.open()
	b = append(b, `["Map"`...)
	for _, kv := range m {
		ki, err := e.flatten(kv.Key)
		if err != nil {
			return 0, err
		}
		vi, err := e.flatten(kv.Val)
		if err != nil {
			return 0, err
		}
		b = append(b, ',')
		b = appendIndex(b, ki)
		b = append(b, ',')
		b = appendIndex(b, vi)
	}
	b = append(b, ']')
	e.close(i, b)
	return i, nil
}

func (e *encoder) set(s Set) (int, error) {
	r, has := sliceRef(refSet, s)
	var i int
	if has {
		var ok bool
		if i, ok = e.seen(r); ok {
			return i, nil
		}
	} else {
		i = e.next()
	}
	b := e.open()
	b = append(b, `["Set"`...)
	for _, v := range s {
		vi, err := e.flatten(v)
		if err != nil {
			return 0, err
		}
		b = append(b, ',')
		b = appendIndex(b, vi)
	}
	b = append(b, ']')
	e.close(i, b)
	return i, nil
}

// raw writes a json.RawMessage (a Postgres json/jsonb column passed through) as the value
// JSON.parse makes of it, which is what the Node code holds: objects and arrays are new values, in
// the text's key order. The same buffer is the same value.
func (e *encoder) raw(m json.RawMessage) (int, error) {
	if len(m) == 0 {
		// The superjson writer writes an empty RawMessage as null.
		return e.primitive(&e.null, "null"), nil
	}
	r, has := sliceRef(refRaw, m)
	if has {
		if v, ok := e.raws[r]; ok {
			return e.flatten(v)
		}
	}
	v, err := ParseJSON(m)
	if err != nil {
		return 0, fmt.Errorf("devalue: json.RawMessage: %w", err)
	}
	if has {
		e.raws[r] = v
	}
	return e.flatten(v)
}

// isArrayIndex reports whether k is a canonical array index ("0", "17", never "01" or "-1", below
// 2^32-1): the keys a JS object lists first, ascending (OrdinaryOwnPropertyKeys).
func isArrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n >= math.MaxUint32 {
		return 0, false
	}
	return n, true
}

// forEachInJSOrder calls fn for each field of o in JS property order (Object.keys).
func forEachInJSOrder(o superjson.Object, fn func(superjson.Field) error) error {
	indexed := 0
	for _, f := range o {
		if _, ok := isArrayIndex(f.Key); ok {
			indexed++
		}
	}
	if indexed == 0 {
		for _, f := range o {
			if err := fn(f); err != nil {
				return err
			}
		}
		return nil
	}
	idx := make([]superjson.Field, 0, indexed)
	for _, f := range o {
		if _, ok := isArrayIndex(f.Key); ok {
			idx = append(idx, f)
		}
	}
	// Insertion sort, stable: index keys are few.
	for a := 1; a < len(idx); a++ {
		for b := a; b > 0; b-- {
			x, _ := isArrayIndex(idx[b-1].Key)
			y, _ := isArrayIndex(idx[b].Key)
			if x <= y {
				break
			}
			idx[b-1], idx[b] = idx[b], idx[b-1]
		}
	}
	for _, f := range idx {
		if err := fn(f); err != nil {
			return err
		}
	}
	for _, f := range o {
		if _, ok := isArrayIndex(f.Key); !ok {
			if err := fn(f); err != nil {
				return err
			}
		}
	}
	return nil
}

func validBigInt(s string) bool {
	if s != "" && s[0] == '-' {
		s = s[1:]
	}
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

const hexDigits = "0123456789abcdef"

// appendDevalueString appends s quoted as devalue's stringify_string does (devalue/src/utils.js):
// `"` and `\` backslash-escaped, `<` as \u003C, \b \f \n \r \t short, U+2028 / U+2029 as
// \u2028 / \u2029, every other character below U+0020 as \u00xx (lowercase hex); everything else, 0x7f
// included, as is. An invalid UTF-8 byte is written as U+FFFD, the character the Node app holds for
// it (a JS string is never invalid UTF-16 from a database or cache read).
func appendDevalueString(dst []byte, s string) []byte {
	dst = append(dst, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			if c >= 0x20 && c != '"' && c != '\\' && c != '<' {
				i++
				continue
			}
			dst = append(dst, s[start:i]...)
			switch c {
			case '"':
				dst = append(dst, '\\', '"')
			case '\\':
				dst = append(dst, '\\', '\\')
			case '<':
				dst = append(dst, '\\', 'u', '0', '0', '3', 'C')
			case '\b':
				dst = append(dst, '\\', 'b')
			case '\f':
				dst = append(dst, '\\', 'f')
			case '\n':
				dst = append(dst, '\\', 'n')
			case '\r':
				dst = append(dst, '\\', 'r')
			case '\t':
				dst = append(dst, '\\', 't')
			default:
				dst = append(dst, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xF])
			}
			i++
			start = i
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			dst = append(dst, s[start:i]...)
			dst = append(dst, "\ufffd"...)
			i++
			start = i
		case r == '\u2028' || r == '\u2029':
			dst = append(dst, s[start:i]...)
			dst = append(dst, '\\', 'u', '2', '0', '2', hexDigits[r&0xF])
			i += size
			start = i
		default:
			i += size
		}
	}
	dst = append(dst, s[start:]...)
	return append(dst, '"')
}

// appendJSONEscaped appends b's characters as JSON.stringify escapes them inside a string: `"` and `\`
// backslash-escaped, \b \f \n \r \t short, every other character below U+0020 as \u00xx (lowercase
// hex), everything else (U+2028 / U+2029, `<`, 0x7f included) as is. b is valid UTF-8 (it is devalue
// text this package wrote), so there is no lone surrogate to escape.
func appendJSONEscaped(dst, b []byte) []byte {
	start := 0
	for i := 0; i < len(b); i++ {
		c := b[i]
		if c >= 0x20 && c != '"' && c != '\\' {
			continue
		}
		dst = append(dst, b[start:i]...)
		switch c {
		case '"':
			dst = append(dst, '\\', '"')
		case '\\':
			dst = append(dst, '\\', '\\')
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\f':
			dst = append(dst, '\\', 'f')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\r':
			dst = append(dst, '\\', 'r')
		case '\t':
			dst = append(dst, '\\', 't')
		default:
			dst = append(dst, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xF])
		}
		start = i + 1
	}
	return append(dst, b[start:]...)
}
