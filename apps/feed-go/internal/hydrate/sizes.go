package hydrate

import (
	"errors"
)

// errTruncated is checkSizes' answer for a value whose declared lengths the bytes cannot hold.
var errTruncated = errors.New("msgpack: a declared length exceeds the remaining input")

// checkSizes walks the first msgpack value in b without decoding it and refuses it when any declared
// length cannot be satisfied by the bytes that follow: a str/bin/ext longer than what remains, or an
// array/map with more elements than remaining bytes (every element takes at least one byte). A value
// that passes cannot make the decoder allocate more than a small multiple of len(b). It does not
// allocate; trailing bytes after the first value are ignored, as the decoder ignores them.
func checkSizes[T ~string | ~[]byte](b T) error {
	pending := 1 // values still to read
	i := 0
	for pending > 0 {
		if i >= len(b) {
			return errTruncated
		}
		c := b[i]
		i++
		pending--
		var skip, items int // payload bytes to skip; child values to read
		switch {
		case c <= 0x7f, c >= 0xe0, c == 0xc0, c == 0xc2, c == 0xc3:
			// fixint, nil, bool: no payload
		case c <= 0x8f:
			items = 2 * int(c&0x0f)
		case c <= 0x9f:
			items = int(c & 0x0f)
		case c <= 0xbf:
			skip = int(c & 0x1f)
		default:
			var n int
			var ok bool
			switch c {
			case 0xc4, 0xd9: // bin8, str8
				n, i, ok = length(b, i, 1)
				skip = n
			case 0xc5, 0xda: // bin16, str16
				n, i, ok = length(b, i, 2)
				skip = n
			case 0xc6, 0xdb: // bin32, str32
				n, i, ok = length(b, i, 4)
				skip = n
			case 0xc7: // ext8: length, type, data
				n, i, ok = length(b, i, 1)
				skip = n + 1
			case 0xc8:
				n, i, ok = length(b, i, 2)
				skip = n + 1
			case 0xc9:
				n, i, ok = length(b, i, 4)
				skip = n + 1
			case 0xca, 0xce, 0xd2: // float32, uint32, int32
				skip, ok = 4, true
			case 0xcb, 0xcf, 0xd3: // float64, uint64, int64
				skip, ok = 8, true
			case 0xcc, 0xd0:
				skip, ok = 1, true
			case 0xcd, 0xd1:
				skip, ok = 2, true
			case 0xd4, 0xd5, 0xd6, 0xd7, 0xd8: // fixext 1/2/4/8/16: type, data
				skip, ok = 1+(1<<(c-0xd4)), true
			case 0xdc: // array16
				n, i, ok = length(b, i, 2)
				items = n
			case 0xdd: // array32
				n, i, ok = length(b, i, 4)
				items = n
			case 0xde: // map16
				n, i, ok = length(b, i, 2)
				items = 2 * n
			case 0xdf: // map32
				n, i, ok = length(b, i, 4)
				items = 2 * n
			}
			if !ok {
				return errTruncated // also 0xc1, the one byte msgpack never uses
			}
		}
		if skip > len(b)-i {
			return errTruncated
		}
		i += skip
		pending += items
		if pending > len(b)-i {
			return errTruncated
		}
	}
	return nil
}

// length reads a big-endian length of size bytes at b[i:].
func length[T ~string | ~[]byte](b T, i, size int) (n, next int, ok bool) {
	if size > len(b)-i {
		return 0, i, false
	}
	for k := range size {
		n = n<<8 | int(b[i+k])
	}
	return n, i + size, true
}
