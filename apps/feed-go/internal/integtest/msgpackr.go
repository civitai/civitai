//go:build integration

package integtest

import (
	"encoding/binary"
	"fmt"
	"math"
	"time"
)

// Obj is a JS object: its keys in insertion order, as msgpackr walks them.
type Obj []KV

// KV is one object member.
type KV struct {
	K string
	V any
}

// O builds an Obj from alternating keys and values: O("id", 1, "name", "x").
func O(kv ...any) Obj {
	if len(kv)%2 != 0 {
		panic("integtest.O: odd number of arguments")
	}
	o := make(Obj, 0, len(kv)/2)
	for i := 0; i < len(kv); i += 2 {
		o = append(o, KV{K: kv[i].(string), V: kv[i+1]})
	}
	return o
}

// Undefined is the JS `undefined` value.
type Undefined struct{}

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
// The goldens in hydrate's TestIntegrationPackMatchesMsgpackr were written by msgpackr itself.
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
			panic("integtest.Pack: msgpackr refuses an object of more than 65535 keys")
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
	panic(fmt.Sprintf("integtest.Pack: unsupported %T", v))
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
