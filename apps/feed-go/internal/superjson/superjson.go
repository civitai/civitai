// Package superjson writes the `{ json, meta }` envelope that the main app's tRPC client decodes
// (superjson 2.x, see src/shared/utils/trpc-union-transformer.ts: every reader is a format-sniffing
// union, and an OBJECT payload is routed to `superjson.deserialize`).
//
// Only the value types this service emits are supported:
//
//   - nil            -> JSON null
//   - Undefined{}    -> null in the JSON (object member, array element or root alike) plus a meta
//     ["undefined"] annotation at its path: superjson's walker maps undefined to null BEFORE
//     JSON.stringify runs (its `undefined` rule, transformer.ts), so Node writes `"key":null`, never
//     an omitted key. Plain (JSON.stringify, no walker) is the one that omits an undefined member.
//   - time.Time      -> ISO-8601 string with millisecond precision, meta ["Date"]
//   - string, bool, every int/uint/float kind
//   - json.RawMessage (passed through verbatim — used for Postgres jsonb columns)
//   - Object         (ordered keys — JS objects keep insertion order)
//   - []any
//
// What is deliberately NOT emitted: `meta.referentialEqualities`. The Node writer adds those when one
// object instance appears at several paths (a creator's `cosmetics` array shared by all their images).
// They change object identity after decode, never the decoded VALUE, so the shadow comparator compares
// decoded values and the client renders the same thing. See DESIGN.md "Wire format".
package superjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Undefined is the JS `undefined` value.
type Undefined struct{}

// Field is one key of an ordered object.
type Field struct {
	Key string
	Val any
}

// Object is a JS object with insertion-ordered keys.
type Object []Field

// Set appends or replaces a key, keeping the original position on replace.
func (o *Object) Set(key string, val any) {
	for i := range *o {
		if (*o)[i].Key == key {
			(*o)[i].Val = val
			return
		}
	}
	*o = append(*o, Field{Key: key, Val: val})
}

// Get returns the value for key.
func (o Object) Get(key string) (any, bool) {
	for _, f := range o {
		if f.Key == key {
			return f.Val, true
		}
	}
	return nil, false
}

type annotation struct {
	path string
	typ  string
}

// segment is one step of the path to the value being written: an object key, or an array index
// (index >= 0). Indexes stay ints so that no string is built unless an annotation needs the path.
type segment struct {
	key   string
	index int
}

// Writers come from two pools, both emptied by every GC cycle, so a get after a cycle allocates a
// fresh writer:
//
//   - pagePool serves SerializeBuffer and PlainBuffer, the served answers (a feed page is a few hundred
//     KiB). Its writers start at pageBufSize, page-sized, so a cold get does not regrow through append
//     (BenchmarkSerializeColdStart reports what a cold get costs).
//   - ownedPool serves Serialize and Plain, whose output is copied out (error bodies, tests). Its
//     writers start at ownedBufSize, so a tiny body's cold get costs 16 KiB, not a page buffer.
//
// A writer whose buffer grew past maxPooledBufSize is put back in neither, so a rare huge page does not
// pin its memory.
const (
	pageBufSize      = 512 << 10
	ownedBufSize     = 16 << 10
	maxPooledBufSize = 1 << 20
)

var (
	pagePool  = &sync.Pool{}
	ownedPool = &sync.Pool{}
)

func init() {
	pagePool.New = func() any { return newWriter(pageBufSize, pagePool) }
	ownedPool.New = func() any { return newWriter(ownedBufSize, ownedPool) }
}

// newWriter is a writer whose buffer starts at size bytes, returned to pool when done (nil: never).
func newWriter(size int, pool *sync.Pool) *writer {
	return &writer{buf: make([]byte, 0, size), path: make([]segment, 0, 8), pool: pool}
}

type writer struct {
	buf []byte
	// path is a stack pushed/popped around every object member and array element. It is only
	// joined into a string by note() and the error paths, which are rare.
	path  []segment
	notes []annotation
	// plain writes JSON.stringify's output (no envelope, no annotations): see Plain.
	plain bool
	// pool is the pool the writer came from and goes back to.
	pool *sync.Pool
}

func getWriter(pool *sync.Pool, plain bool) *writer {
	w, _ := pool.Get().(*writer)
	w.plain = plain
	return w
}

// putWriter resets w and returns it to its pool, unless its buffer outgrew maxPooledBufSize (then it
// is left to the collector) or it has no pool. It reports whether w was pooled. The caller must hold
// no reference to w.buf afterwards: the next writer taken from the pool writes over it.
func putWriter(w *writer) bool {
	if w.pool == nil || cap(w.buf) > maxPooledBufSize {
		return false
	}
	clear(w.notes) // the annotations' path strings are not kept alive by the pool
	w.buf, w.path, w.notes, w.plain = w.buf[:0], w.path[:0], w.notes[:0], false
	w.pool.Put(w)
	return true
}

// Buffer is serialized output held in a pooled buffer. It has one owner, who calls Release once
// nothing reads Bytes any more (the response is written, the comparison is done); until then the
// bytes are the owner's alone. Release is idempotent; after it Bytes is nil.
type Buffer struct {
	w *writer
}

// Bytes is the output. It is valid until Release; do not keep it (or a sub-slice) past that.
func (b *Buffer) Bytes() []byte {
	if b == nil || b.w == nil {
		return nil
	}
	return b.w.buf
}

// Release hands the buffer back to the pool. Safe on a nil Buffer and when called twice.
func (b *Buffer) Release() {
	if b == nil || b.w == nil {
		return
	}
	w := b.w
	b.w = nil
	putWriter(w)
}

// Plain returns v as JSON.stringify writes it, for a plain-JSON response (the public REST endpoints
// answer with `res.json`, not superjson): Dates as their ISO string, undefined object members omitted,
// undefined array elements as null. No envelope and no annotations. The result is a copy the caller
// owns; PlainBuffer avoids the copy.
func Plain(v any) ([]byte, error) {
	return owned(plainInto(ownedPool, v))
}

// PlainBuffer is Plain into a pooled Buffer the caller must Release.
func PlainBuffer(v any) (*Buffer, error) {
	return plainInto(pagePool, v)
}

func plainInto(pool *sync.Pool, v any) (*Buffer, error) {
	if _, isUndef := v.(Undefined); isUndef {
		return nil, errors.New("superjson: undefined has no JSON form")
	}
	w := getWriter(pool, true)
	if err := w.value(v); err != nil {
		putWriter(w)
		return nil, err
	}
	return &Buffer{w: w}, nil
}

// Serialize returns the superjson envelope for v as JSON bytes: `{"json":…}` or
// `{"json":…,"meta":{"values":{…},"v":1}}`. The result is a copy the caller owns; SerializeBuffer
// avoids the copy.
func Serialize(v any) ([]byte, error) {
	return owned(serializeInto(ownedPool, v))
}

// owned copies a Buffer's output out of the pool and releases it.
func owned(b *Buffer, err error) ([]byte, error) {
	if err != nil {
		return nil, err
	}
	out := bytes.Clone(b.Bytes())
	b.Release()
	return out, nil
}

// SerializeBuffer is Serialize into a pooled Buffer the caller must Release. A failed serialization
// returns no Buffer (its writer is already back in the pool).
func SerializeBuffer(v any) (*Buffer, error) {
	return serializeInto(pagePool, v)
}

func serializeInto(pool *sync.Pool, v any) (*Buffer, error) {
	w := getWriter(pool, false)
	if err := w.envelope(v); err != nil {
		putWriter(w)
		return nil, err
	}
	return &Buffer{w: w}, nil
}

// envelope writes the superjson envelope for v.
func (w *writer) envelope(v any) error {
	// A root undefined is `{"json":null,"meta":{"values":["undefined"],"v":1}}` too: the walker
	// turns it into null before JSON.stringify sees it.
	w.buf = append(w.buf, `{"json":`...)
	if err := w.value(v); err != nil {
		return err
	}
	if len(w.notes) > 0 {
		w.buf = append(w.buf, ',')
		w.buf = append(w.buf, `"meta":{"values":`...)
		if len(w.notes) == 1 && w.notes[0].path == "" {
			// A transformed ROOT value is annotated as a bare array (`["Date"]`), not a path map.
			w.buf = append(w.buf, '[')
			w.buf = appendString(w.buf, w.notes[0].typ)
			w.buf = append(w.buf, ']')
		} else {
			w.buf = append(w.buf, '{')
			for i, n := range w.notes {
				if i > 0 {
					w.buf = append(w.buf, ',')
				}
				w.buf = appendString(w.buf, n.path)
				w.buf = append(w.buf, `:[`...)
				w.buf = appendString(w.buf, n.typ)
				w.buf = append(w.buf, ']')
			}
			w.buf = append(w.buf, '}')
		}
		w.buf = append(w.buf, `,"v":1}`...)
	}
	w.buf = append(w.buf, '}')
	return nil
}

// EscapeKey mirrors superjson's pathstringifier.escapeKey.
func EscapeKey(k string) string {
	k = strings.ReplaceAll(k, `\`, `\\`)
	return strings.ReplaceAll(k, `.`, `\.`)
}

// joinPath renders the current path the way superjson stringifies it: escaped keys and decimal
// indexes joined by ".".
func (w *writer) joinPath() string {
	n := 0
	for _, s := range w.path {
		n += len(s.key) + 8 // separator plus an index's digits, or slack for EscapeKey's backslashes
	}
	var b strings.Builder
	b.Grow(n)
	for i, s := range w.path {
		if i > 0 {
			b.WriteByte('.')
		}
		if s.index >= 0 {
			b.WriteString(strconv.Itoa(s.index))
		} else {
			b.WriteString(EscapeKey(s.key))
		}
	}
	return b.String()
}

func (w *writer) note(typ string) {
	if w.plain {
		return
	}
	w.notes = append(w.notes, annotation{path: w.joinPath(), typ: typ})
}

func (w *writer) push(s segment) { w.path = append(w.path, s) }

func (w *writer) pop() { w.path = w.path[:len(w.path)-1] }

// value writes v at the current path. An Undefined is written as null (and annotated, outside
// plain mode); a plain-mode object member that is Undefined is skipped by the caller before reaching
// here, as JSON.stringify omits it.
func (w *writer) value(v any) error {
	switch t := v.(type) {
	case nil:
		w.buf = append(w.buf, "null"...)
	case Undefined:
		w.note("undefined")
		w.buf = append(w.buf, "null"...)
	case time.Time:
		w.note("Date")
		// FormatDate's output never contains a byte JSON escapes, so it skips appendString.
		w.buf = append(w.buf, '"')
		w.buf = t.UTC().AppendFormat(w.buf, isoLayout)
		w.buf = append(w.buf, '"')
	case *time.Time:
		if t == nil {
			w.buf = append(w.buf, "null"...)
			return nil
		}
		return w.value(*t)
	case string:
		w.buf = appendString(w.buf, t)
	case bool:
		w.buf = strconv.AppendBool(w.buf, t)
	case int:
		w.buf = strconv.AppendInt(w.buf, int64(t), 10)
	case int32:
		w.buf = strconv.AppendInt(w.buf, int64(t), 10)
	case int64:
		w.buf = strconv.AppendInt(w.buf, t, 10)
	case uint32:
		w.buf = strconv.AppendUint(w.buf, uint64(t), 10)
	case uint64:
		w.buf = strconv.AppendUint(w.buf, t, 10)
	case float32:
		return w.float(float64(t))
	case float64:
		return w.float(t)
	case json.RawMessage:
		if len(t) == 0 {
			w.buf = append(w.buf, "null"...)
		} else {
			w.buf = append(w.buf, t...)
		}
	case Object:
		w.buf = append(w.buf, '{')
		first := true
		for _, f := range t {
			w.push(segment{key: f.Key, index: -1})
			if _, undef := f.Val.(Undefined); undef && w.plain {
				// JSON.stringify (Plain) omits an undefined member. The superjson envelope does not:
				// value() writes it as null plus its ["undefined"] annotation, as Node's walker does.
				w.pop()
				continue
			}
			if !first {
				w.buf = append(w.buf, ',')
			}
			first = false
			w.buf = appendString(w.buf, f.Key)
			w.buf = append(w.buf, ':')
			if err := w.value(f.Val); err != nil {
				return err
			}
			w.pop()
		}
		w.buf = append(w.buf, '}')
	case *Object:
		if t == nil {
			w.buf = append(w.buf, "null"...)
			return nil
		}
		return w.value(*t)
	case []any:
		w.buf = append(w.buf, '[')
		for i, e := range t {
			if i > 0 {
				w.buf = append(w.buf, ',')
			}
			w.push(segment{index: i})
			if err := w.value(e); err != nil {
				return err
			}
			w.pop()
		}
		w.buf = append(w.buf, ']')
	case []int:
		w.buf = append(w.buf, '[')
		for i, e := range t {
			if i > 0 {
				w.buf = append(w.buf, ',')
			}
			w.buf = strconv.AppendInt(w.buf, int64(e), 10)
		}
		w.buf = append(w.buf, ']')
	default:
		return fmt.Errorf("superjson: unsupported type %T at %q", v, w.joinPath())
	}
	return nil
}

func (w *writer) float(f float64) error {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		// superjson annotates these as ["number"] with a string value; nothing here produces them.
		return fmt.Errorf("superjson: non-finite number at %q", w.joinPath())
	}
	w.buf = appendNumber(w.buf, f)
	return nil
}

// appendNumber appends FormatNumber(f). The common case (a plain decimal) is formatted straight into
// dst; zero and the exponent forms go through FormatNumber, which stays the one definition.
func appendNumber(dst []byte, f float64) []byte {
	if abs := math.Abs(f); f != 0 && abs < 1e21 && abs >= 1e-6 {
		return strconv.AppendFloat(dst, f, 'f', -1, 64)
	}
	return append(dst, FormatNumber(f)...)
}

// FormatNumber renders a float the way JS Number#toString does for the finite values this service
// produces: integers without a fraction, otherwise the shortest round-trip form; exponent form only
// at the JS thresholds (>= 1e21 or < 1e-6).
func FormatNumber(f float64) string {
	if f == 0 {
		return "0"
	}
	abs := math.Abs(f)
	if abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		// Go: 1e+21, JS: 1e+21 — same; Go: 1e-07, JS: 1e-7.
		s = strings.Replace(s, "e-0", "e-", 1)
		s = strings.Replace(s, "e+0", "e+", 1)
		return s
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

const isoLayout = "2006-01-02T15:04:05.000Z"

// FormatDate is Date#toISOString: UTC, millisecond precision, `Z` suffix.
func FormatDate(t time.Time) string {
	return t.UTC().Format(isoLayout)
}

const hexDigits = "0123456789abcdef"

// appendString appends s as a quoted JSON string, byte-for-byte what encoding/json writes with
// SetEscapeHTML(false) (it mirrors appendString in encoding/json/encode.go): `"` and `\` are
// backslash-escaped, \b \f \n \r \t get their short escapes, other bytes < 0x20 become \u00XX in
// lowercase hex, U+2028/U+2029 become \u2028/\u2029, and each invalid UTF-8 byte becomes \ufffd.
// <, > and & are left alone. It differs from JSON.stringify only in the U+2028/U+2029 escapes and the
// invalid-UTF-8 replacement — both decode to the same string on the client.
//
// Runs of bytes that need no escaping are copied with a single append, so a plain string costs one
// comparison per byte and one copy.
func appendString(dst []byte, s string) []byte {
	dst = append(dst, '"')
	start := 0
	for i := 0; i < len(s); {
		if b := s[i]; b < utf8.RuneSelf {
			if b >= 0x20 && b != '"' && b != '\\' {
				i++
				continue
			}
			dst = append(dst, s[start:i]...)
			switch b {
			case '\\', '"':
				dst = append(dst, '\\', b)
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
				dst = append(dst, '\\', 'u', '0', '0', hexDigits[b>>4], hexDigits[b&0xF])
			}
			i++
			start = i
			continue
		}
		c, size := utf8.DecodeRuneInString(s[i:])
		if c == utf8.RuneError && size == 1 {
			dst = append(dst, s[start:i]...)
			dst = append(dst, `\ufffd`...)
			i++
			start = i
			continue
		}
		if c == '\u2028' || c == '\u2029' {
			dst = append(dst, s[start:i]...)
			dst = append(dst, '\\', 'u', '2', '0', '2', hexDigits[c&0xF])
			i += size
			start = i
			continue
		}
		i += size
	}
	dst = append(dst, s[start:]...)
	return append(dst, '"')
}
