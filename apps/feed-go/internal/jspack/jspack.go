// Package jspack holds JS values as the Node app holds them, so this service can write a cache entry
// byte for byte as the Node app's cache writer does: an object keeps its members in JS property
// order, numbers are JS numbers, and Pack encodes with msgpackr's module-level `pack`.
//
// Three producers of such values: FromJSON (a Postgres json/jsonb column as Prisma hands it to the
// Node code, JSON.parse order), Decode (a cached msgpack value as msgpackr's unpack reads it), and
// code building a record member by member (O).
package jspack

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/jskeys"
)

// Obj is a JS object: its members in property order, as msgpackr walks them (for…in).
type Obj []KV

// KV is one object member.
type KV struct {
	K string
	V any
}

// O builds an Obj from alternating keys and values: O("id", 1, "name", "x"). Keys are kept in the
// order given; use Order to apply JS property order (integer-like keys first).
func O(kv ...any) Obj {
	if len(kv)%2 != 0 {
		panic("jspack.O: odd number of arguments")
	}
	o := make(Obj, 0, len(kv)/2)
	for i := 0; i < len(kv); i += 2 {
		o = append(o, KV{K: kv[i].(string), V: kv[i+1]}) //nolint:gosec // G602: len(kv) is even (checked above), so i+1 < len(kv)
	}
	return o
}

// Get returns the member k.
func (o Obj) Get(k string) (any, bool) {
	for _, kv := range o {
		if kv.K == k {
			return kv.V, true
		}
	}
	return nil, false
}

// Undefined is the JS `undefined` value.
type Undefined struct{}

// Order returns o in JS property order: integer-like keys ascending, then the rest in insertion order
// (jskeys.Order).
func Order(o Obj) Obj {
	return jskeys.Order(o, func(kv KV) string { return kv.K })
}

// set assigns o[k] = v as JS does: an existing member keeps its position.
func (o Obj) set(k string, v any) Obj {
	for i := range o {
		if o[i].K == k {
			o[i].V = v
			return o
		}
	}
	return append(o, KV{K: k, V: v})
}

// Pack encodes v as msgpackr's module-level `pack` does (msgpackr 1.11, `new Packr({useRecords:
// false})`, no other option), byte for byte (node_modules/msgpackr/pack.js):
//   - an object is ALWAYS a map16 (0xde), whatever its size: without `variableMapSize` msgpackr
//     preallocates the 16-bit length and never writes a fixmap;
//   - a number that is a uint32 is a positive fixint below 0x80 (useRecords false), else uint8/16/32;
//     a negative int32 is a negative fixint / int8/16/32; every other number (fractional, or beyond
//     32 bits) is a float64;
//   - a string is fixstr / str8 / str16 / str32 by its UTF-8 length; an array fixarray / array16 /
//     array32;
//   - a Date is the timestamp extension -1: 32-bit when it has no milliseconds and 0 <= seconds <
//     2^32, else 64-bit when 0 < seconds < 2^32, else 96-bit;
//   - `undefined` is fixext1 type 0 with a 0 byte (d4 00 00).
//
// The goldens in jspack_test.go were written by msgpackr itself. Pack panics on a value it does not
// model (a programming error: every caller builds its values from the types above).
func Pack(v any) []byte { return appendValue(nil, v) }

func appendValue(b []byte, v any) []byte {
	switch t := v.(type) {
	case nil:
		return append(b, 0xc0)
	case Undefined:
		return append(b, 0xd4, 0x00, 0x00)
	case bool:
		if t {
			return append(b, 0xc3)
		}
		return append(b, 0xc2)
	case int:
		return appendNumber(b, float64(t))
	case int32:
		return appendNumber(b, float64(t))
	case int64:
		return appendNumber(b, float64(t))
	case float64:
		return appendNumber(b, t)
	case string:
		return appendString(b, t)
	case []any:
		n := len(t)
		switch {
		case n < 0x10:
			b = append(b, 0x90|byte(n))
		case n < 0x10000:
			b = append(b, 0xdc, byte(n>>8), byte(n))
		default:
			b = append(b, 0xdd)
			b = binary.BigEndian.AppendUint32(b, uint32(n))
		}
		for _, e := range t {
			b = appendValue(b, e)
		}
		return b
	case Obj:
		if len(t) > 0xffff {
			panic("jspack.Pack: msgpackr refuses an object of more than 65535 keys")
		}
		b = append(b, 0xde, byte(len(t)>>8), byte(len(t)))
		for _, kv := range t {
			b = appendString(b, kv.K)
			b = appendValue(b, kv.V)
		}
		return b
	case time.Time:
		return appendDate(b, t)
	}
	panic(fmt.Sprintf("jspack.Pack: unsupported %T", v))
}

func appendNumber(b []byte, f float64) []byte {
	if f >= 0 && f <= math.MaxUint32 && f == math.Trunc(f) && !(f == 0 && math.Signbit(f)) {
		u := uint32(f)
		switch {
		case u < 0x80:
			return append(b, byte(u))
		case u < 0x100:
			return append(b, 0xcc, byte(u))
		case u < 0x10000:
			return append(b, 0xcd, byte(u>>8), byte(u))
		default:
			return binary.BigEndian.AppendUint32(append(b, 0xce), u)
		}
	}
	if f < 0 && f >= math.MinInt32 && f == math.Trunc(f) {
		n := int32(f)
		switch {
		case n >= -0x20:
			return append(b, byte(n))
		case n >= -0x80:
			return append(b, 0xd0, byte(n))
		case n >= -0x8000:
			return append(b, 0xd1, byte(uint16(n)>>8), byte(n))
		default:
			return binary.BigEndian.AppendUint32(append(b, 0xd2), uint32(n))
		}
	}
	return binary.BigEndian.AppendUint64(append(b, 0xcb), math.Float64bits(f))
}

func appendString(b []byte, s string) []byte {
	n := len(s)
	switch {
	case n < 0x20:
		b = append(b, 0xa0|byte(n))
	case n < 0x100:
		b = append(b, 0xd9, byte(n))
	case n < 0x10000:
		b = append(b, 0xda, byte(n>>8), byte(n))
	default:
		b = binary.BigEndian.AppendUint32(append(b, 0xdb), uint32(n))
	}
	return append(b, s...)
}

func appendDate(b []byte, t time.Time) []byte {
	ms := t.UnixMilli()
	seconds := float64(ms) / 1000
	millis := uint32(((ms % 1000) + 1000) % 1000) // Date#getMilliseconds is never negative
	if millis == 0 && seconds >= 0 && seconds < 0x100000000 {
		return binary.BigEndian.AppendUint32(append(b, 0xd6, 0xff), uint32(seconds))
	}
	if seconds > 0 && seconds < 0x100000000 {
		b = append(b, 0xd7, 0xff)
		b = binary.BigEndian.AppendUint32(b, millis*4000000)
		return binary.BigEndian.AppendUint32(b, uint32(seconds))
	}
	b = append(b, 0xc7, 12, 0xff)
	b = binary.BigEndian.AppendUint32(b, millis*1000000)
	return binary.BigEndian.AppendUint64(b, uint64(int64(math.Floor(seconds))))
}

// FromJSON is JSON.parse of text: objects as Obj in JS property order (a repeated key keeps its
// first position and its last value), numbers as float64, plus string, bool, nil and []any. It is
// how a json/jsonb column reaches the Node code: Prisma parses the column's text, and Postgres
// writes a jsonb's members in its own storage order, which this keeps.
func FromJSON(text string) (any, error) {
	dec := json.NewDecoder(bytes.NewReader([]byte(text)))
	dec.UseNumber()
	v, err := jsonValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("jspack: trailing data after the JSON value")
	}
	return v, nil
}

func jsonValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := Obj{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, errors.New("jspack: object key is not a string")
				}
				v, err := jsonValue(dec)
				if err != nil {
					return nil, err
				}
				o = o.set(k, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return Order(o), nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := jsonValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("jspack: unexpected %v", t)
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return nil, err
		}
		return f, nil // JSON.parse: out of range is ±Infinity (ParseFloat answers that with ErrRange)
	case string, bool, nil:
		return t, nil
	}
	return nil, fmt.Errorf("jspack: unexpected token %T", tok)
}

// Decode reads one msgpack value as msgpackr's unpack does into JS (maps as Obj in JS property
// order, every number as float64, the timestamp extension as time.Time, fixext1 type 0 as
// Undefined). Declared lengths are checked against the bytes left before anything is allocated.
func Decode(b []byte) (any, error) {
	d := &decoder{b: b}
	v, err := d.value(0)
	if err != nil {
		return nil, err
	}
	if d.i != len(d.b) {
		return nil, errors.New("jspack: trailing bytes after the msgpack value")
	}
	return v, nil
}

type decoder struct {
	b []byte
	i int
}

var errShort = errors.New("jspack: msgpack value truncated")

const maxDepth = 512

func (d *decoder) take(n int) ([]byte, error) {
	if n < 0 || d.i+n > len(d.b) {
		return nil, errShort
	}
	s := d.b[d.i : d.i+n]
	d.i += n
	return s, nil
}

func (d *decoder) uint(n int) (uint64, error) {
	s, err := d.take(n)
	if err != nil {
		return 0, err
	}
	var u uint64
	for _, c := range s {
		u = u<<8 | uint64(c)
	}
	return u, nil
}

func (d *decoder) value(depth int) (any, error) {
	if depth > maxDepth {
		return nil, errors.New("jspack: msgpack value nested too deep")
	}
	s, err := d.take(1)
	if err != nil {
		return nil, err
	}
	c := s[0]
	switch {
	case c <= 0x7f:
		return float64(c), nil
	case c >= 0xe0:
		return float64(int8(c)), nil
	case c&0xf0 == 0x80:
		return d.obj(int(c&0x0f), depth)
	case c&0xf0 == 0x90:
		return d.arr(int(c&0x0f), depth)
	case c&0xe0 == 0xa0:
		return d.str(int(c & 0x1f))
	}
	switch c {
	case 0xc0:
		return nil, nil
	case 0xc2:
		return false, nil
	case 0xc3:
		return true, nil
	case 0xcc, 0xcd, 0xce, 0xcf:
		u, err := d.uint(1 << (c - 0xcc))
		return float64(u), err
	case 0xd0:
		u, err := d.uint(1)
		return float64(int8(u)), err
	case 0xd1:
		u, err := d.uint(2)
		return float64(int16(u)), err
	case 0xd2:
		u, err := d.uint(4)
		return float64(int32(u)), err
	case 0xd3:
		u, err := d.uint(8)
		return float64(int64(u)), err
	case 0xca:
		u, err := d.uint(4)
		return float64(math.Float32frombits(uint32(u))), err
	case 0xcb:
		u, err := d.uint(8)
		return math.Float64frombits(u), err
	case 0xd9, 0xda, 0xdb:
		n, err := d.uint(1 << (c - 0xd9))
		if err != nil {
			return nil, err
		}
		return d.str(int(n))
	case 0xc4, 0xc5, 0xc6:
		n, err := d.uint(1 << (c - 0xc4))
		if err != nil {
			return nil, err
		}
		raw, err := d.take(int(n))
		return append([]byte(nil), raw...), err
	case 0xdc, 0xdd:
		n, err := d.uint(2 << (c - 0xdc))
		if err != nil {
			return nil, err
		}
		return d.arr(int(n), depth)
	case 0xde, 0xdf:
		n, err := d.uint(2 << (c - 0xde))
		if err != nil {
			return nil, err
		}
		return d.obj(int(n), depth)
	case 0xd4, 0xd5, 0xd6, 0xd7, 0xd8:
		return d.ext(1<<(c-0xd4), true)
	case 0xc7, 0xc8, 0xc9:
		n, err := d.uint(1 << (c - 0xc7))
		if err != nil {
			return nil, err
		}
		return d.ext(int(n), false)
	}
	return nil, fmt.Errorf("jspack: msgpack type 0x%02x not modelled", c)
}

func (d *decoder) str(n int) (any, error) {
	s, err := d.take(n)
	if err != nil {
		return nil, err
	}
	return string(s), nil
}

func (d *decoder) arr(n, depth int) (any, error) {
	if n > len(d.b)-d.i { // every element is at least one byte
		return nil, errShort
	}
	out := make([]any, n)
	for i := range out {
		v, err := d.value(depth + 1)
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

func (d *decoder) obj(n, depth int) (any, error) {
	if 2*n > len(d.b)-d.i {
		return nil, errShort
	}
	o := make(Obj, 0, n)
	for i := 0; i < n; i++ {
		k, err := d.value(depth + 1)
		if err != nil {
			return nil, err
		}
		v, err := d.value(depth + 1)
		if err != nil {
			return nil, err
		}
		o = o.set(jsKey(k), v)
	}
	return Order(o), nil
}

// jsKey is the property key a decoded map key becomes in JS (String(key)).
func jsKey(k any) string {
	switch t := k.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	case nil:
		return "null"
	}
	return fmt.Sprint(k)
}

func (d *decoder) ext(n int, fixed bool) (any, error) {
	ts, err := d.take(1)
	if err != nil {
		return nil, err
	}
	data, err := d.take(n)
	if err != nil {
		return nil, err
	}
	switch int8(ts[0]) {
	case 0:
		if fixed && n == 1 {
			return Undefined{}, nil
		}
	case -1:
		switch n {
		case 4:
			return time.Unix(int64(binary.BigEndian.Uint32(data)), 0).UTC(), nil
		case 8:
			hi, lo := binary.BigEndian.Uint32(data), binary.BigEndian.Uint32(data[4:])
			sec := int64(hi&0x3)<<32 | int64(lo)
			return time.Unix(sec, int64(hi>>2)).UTC(), nil
		case 12:
			nsec := binary.BigEndian.Uint32(data)
			sec := int64(binary.BigEndian.Uint64(data[4:]))
			return time.Unix(sec, int64(nsec)).UTC(), nil
		}
	}
	return nil, fmt.Errorf("jspack: msgpack extension %d (%d bytes) not modelled", int8(ts[0]), n)
}
