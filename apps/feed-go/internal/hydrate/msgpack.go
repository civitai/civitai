package hydrate

import (
	"errors"
	"math"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The msgpack reader behind Unpack and UnpackOrdered: one pass over the bytes, no reflection, every
// value built in its final Go type as it is read. It returns exactly the values the generic decoder
// it replaces returned (vmihailenco/msgpack's loose interface decoding plus a normalize pass, kept in
// the tests as the oracle: msgpack_oracle_test.go), so no caller changes:
//
//   - positive and negative fixints and int8..int64 are int64; uint8..uint64 are uint64 (a uint8 200
//     is uint64(200), as before); float32 is widened to float64, float64 keeps its bits (-0, NaN);
//   - str and bin are strings, the bytes as they are (invalid UTF-8 included);
//   - the timestamp extension (-1) is a time.Time from time.Unix (the zero instant in UTC), and in
//     UnpackOrdered in UTC; msgpackr's `undefined` (extension 0) is dropped from a map and nil in an
//     array; any other extension is an error;
//   - a map is a map[string]any (Unpack: str, bin or nil keys only, a repeated key keeps its last
//     value) or a superjson.Object in JS own-key order (UnpackOrdered: any key, as its JS property
//     name); an array is a []any; empty containers are empty, never nil.
//
// Strings are not copied: each is a substring of the input, which a decode reads as a string (the
// Redis reply itself for a cache read, so the reply's bytes are the only copy), and the entry keeps
// the reply alive for as long as it holds one of them. Common enum values (internedValues) are
// shared, already boxed, values.

// jsUndef is the decoded `undefined` (extension 0), before a map drops it or an array makes it nil.
var jsUndef any = &jsUndefined{}

var (
	errMsgpackCode = errors.New("hydrate: msgpack code not valid here")
	errMsgpackKey  = errors.New("hydrate: msgpack map key is not a string")
	errMsgpackExt  = errors.New("hydrate: unknown msgpack extension")
	errMsgpackTime = errors.New("hydrate: msgpack timestamp of an invalid length")
)

// mpReader reads one msgpack value from s. checkSizes has already accepted s, so every declared
// length fits; the reads still check their bounds (errTruncated), so a reader can never index past
// the input whatever it is handed.
type mpReader struct {
	s string
	i int
}

func (r *mpReader) byte1() (byte, error) {
	if r.i >= len(r.s) {
		return 0, errTruncated
	}
	c := r.s[r.i]
	r.i++
	return c, nil
}

func (r *mpReader) take(n int) (string, error) {
	if n < 0 || n > len(r.s)-r.i {
		return "", errTruncated
	}
	v := r.s[r.i : r.i+n]
	r.i += n
	return v, nil
}

// uintN reads an n-byte big-endian unsigned integer (n is 1, 2, 4 or 8).
func (r *mpReader) uintN(n int) (uint64, error) {
	if n > len(r.s)-r.i {
		return 0, errTruncated
	}
	var v uint64
	for _, c := range []byte(r.s[r.i : r.i+n]) {
		v = v<<8 | uint64(c)
	}
	r.i += n
	return v, nil
}

// lenN is a length of n bytes, as an int.
func (r *mpReader) lenN(n int) (int, error) {
	v, err := r.uintN(n)
	return int(v), err //nolint:gosec // G115: at most 4 bytes, so at most 2^32-1, which an int holds
}

// strLen is the payload length of a str or bin code; ok false for any other code.
func (r *mpReader) strLen(c byte) (n int, ok bool, err error) {
	switch {
	case c >= 0xa0 && c <= 0xbf:
		return int(c & 0x1f), true, nil
	case c == 0xd9 || c == 0xc4:
		n, err = r.lenN(1)
	case c == 0xda || c == 0xc5:
		n, err = r.lenN(2)
	case c == 0xdb || c == 0xc6:
		n, err = r.lenN(4)
	default:
		return 0, false, nil
	}
	return n, true, err
}

// containerLen is the element count of a map or array code: isMap reports which; ok false for any
// other code.
func (r *mpReader) containerLen(c byte) (n int, isMap, ok bool, err error) {
	switch {
	case c >= 0x80 && c <= 0x8f:
		return int(c & 0x0f), true, true, nil
	case c >= 0x90 && c <= 0x9f:
		return int(c & 0x0f), false, true, nil
	case c == 0xdc:
		n, err = r.lenN(2)
	case c == 0xdd:
		n, err = r.lenN(4)
	case c == 0xde:
		n, err = r.lenN(2)
		isMap = true
	case c == 0xdf:
		n, err = r.lenN(4)
		isMap = true
	default:
		return 0, false, false, nil
	}
	return n, isMap, true, err
}

// scalar reads a value whose code c (already read) is not a map or an array.
func (r *mpReader) scalar(c byte, utc bool) (any, error) {
	if c <= 0x7f || c >= 0xe0 {
		return int64(int8(c)), nil //nolint:gosec // G115: the fixint encoding is the byte's int8 value
	}
	if n, ok, err := r.strLen(c); ok {
		if err != nil {
			return nil, err
		}
		s, err := r.take(n)
		if err != nil {
			return nil, err
		}
		return boxString(s), nil
	}
	switch c {
	case 0xc0:
		return nil, nil
	case 0xc2:
		return false, nil
	case 0xc3:
		return true, nil
	case 0xca:
		v, err := r.uintN(4)
		return float64(math.Float32frombits(uint32(v))), err //nolint:gosec // G115: 4 bytes
	case 0xcb:
		v, err := r.uintN(8)
		return math.Float64frombits(v), err
	case 0xcc:
		v, err := r.uintN(1)
		return v, err
	case 0xcd:
		v, err := r.uintN(2)
		return v, err
	case 0xce:
		v, err := r.uintN(4)
		return v, err
	case 0xcf:
		v, err := r.uintN(8)
		return v, err
	case 0xd0:
		v, err := r.uintN(1)
		return int64(int8(v)), err //nolint:gosec // G115: sign extension of the one byte read
	case 0xd1:
		v, err := r.uintN(2)
		return int64(int16(v)), err //nolint:gosec // G115: sign extension of the two bytes read
	case 0xd2:
		v, err := r.uintN(4)
		return int64(int32(v)), err //nolint:gosec // G115: sign extension of the four bytes read
	case 0xd3:
		v, err := r.uintN(8)
		return int64(v), err //nolint:gosec // G115: the two's-complement int64 read
	case 0xd4, 0xd5, 0xd6, 0xd7, 0xd8:
		return r.ext(1<<(c-0xd4), utc)
	case 0xc7:
		n, err := r.lenN(1)
		if err != nil {
			return nil, err
		}
		return r.ext(n, utc)
	case 0xc8:
		n, err := r.lenN(2)
		if err != nil {
			return nil, err
		}
		return r.ext(n, utc)
	case 0xc9:
		n, err := r.lenN(4)
		if err != nil {
			return nil, err
		}
		return r.ext(n, utc)
	}
	return nil, errMsgpackCode // 0xc1, never used
}

// ext reads an extension's type byte and its n data bytes.
func (r *mpReader) ext(n int, utc bool) (any, error) {
	t, err := r.byte1()
	if err != nil {
		return nil, err
	}
	switch int8(t) { //nolint:gosec // G115: the extension type is a signed byte
	case 0:
		if _, err := r.take(n); err != nil {
			return nil, err
		}
		return jsUndef, nil
	case -1:
		b, err := r.take(n)
		if err != nil {
			return nil, err
		}
		tm, err := timestamp(b)
		if err != nil {
			return nil, err
		}
		if utc {
			tm = tm.UTC()
		}
		return tm, nil
	}
	return nil, errMsgpackExt
}

// timestamp is the msgpack timestamp extension's data (4, 8 or 12 bytes) as the decoder this replaces
// built it: time.Unix, local, except the zero instant, which is UTC.
func timestamp(b string) (time.Time, error) {
	be := func(s string) uint64 {
		var v uint64
		for _, c := range []byte(s) {
			v = v<<8 | uint64(c)
		}
		return v
	}
	var tm time.Time
	switch len(b) {
	case 4:
		tm = time.Unix(int64(be(b)), 0) //nolint:gosec // G115: 4 bytes
	case 8:
		v := be(b)
		tm = time.Unix(int64(v&0x00000003ffffffff), int64(v>>34)) //nolint:gosec // G115: 34 and 30 bits
	case 12:
		tm = time.Unix(int64(be(b[4:])), int64(be(b[:4]))) //nolint:gosec // G115: as the decoder read them
	default:
		return time.Time{}, errMsgpackTime
	}
	if tm.IsZero() {
		tm = tm.UTC()
	}
	return tm, nil
}

// plain is Unpack's value.
func (r *mpReader) plain() (any, error) {
	c, err := r.byte1()
	if err != nil {
		return nil, err
	}
	n, isMap, ok, err := r.containerLen(c)
	if !ok {
		return r.scalar(c, false)
	}
	if err != nil {
		return nil, err
	}
	if isMap {
		return r.plainMap(n, "")
	}
	return r.plainArray(n)
}

func (r *mpReader) plainArray(n int) (any, error) {
	arr := make([]any, n)
	for i := range arr {
		v, err := r.plain()
		if err != nil {
			return nil, err
		}
		if v != jsUndef {
			arr[i] = v
		}
	}
	return arr, nil
}

// plainMap reads n members into a map; intList names the member whose integer array is read as a
// []int (top level only).
func (r *mpReader) plainMap(n int, intList string) (any, error) {
	m := make(map[string]any, n)
	for range n {
		k, err := r.plainKey()
		if err != nil {
			return nil, err
		}
		var v any
		if intList != "" && k == intList {
			if ints, ok := r.ints(); ok {
				m[k] = ints
				continue
			}
		}
		if v, err = r.plain(); err != nil {
			return nil, err
		}
		if v == jsUndef {
			delete(m, k)
			continue
		}
		m[k] = v
	}
	return m, nil
}

// plainKey is an Unpack map key: a str or bin, or nil as "" (the decoder this replaces read a key as
// a string, and refused any other code).
func (r *mpReader) plainKey() (string, error) {
	c, err := r.byte1()
	if err != nil {
		return "", err
	}
	if c == 0xc0 {
		return "", nil
	}
	n, ok, err := r.strLen(c)
	if !ok {
		return "", errMsgpackKey
	}
	if err != nil {
		return "", err
	}
	return r.take(n)
}

// ints reads a non-empty array whose every element is a msgpack integer that fits an int as a []int.
// ok false (the reader left where it was) for anything else: the caller then reads the value as any
// other, so a list with a float, a string, an out-of-range uint64 or no element is the []any it
// always was.
func (r *mpReader) ints() ([]int, bool) {
	start := r.i
	c, err := r.byte1()
	if err != nil {
		r.i = start
		return nil, false
	}
	n, isMap, ok, err := r.containerLen(c)
	if !ok || isMap || err != nil || n == 0 || n > len(r.s)-r.i {
		r.i = start
		return nil, false
	}
	out := make([]int, n)
	for i := range out {
		v, ok := r.int1()
		if !ok {
			r.i = start
			return nil, false
		}
		out[i] = v
	}
	return out, true
}

// int1 reads one msgpack integer that fits an int; ok false for any other value (the reader is then
// somewhere inside it: ints rewinds).
func (r *mpReader) int1() (int, bool) {
	c, err := r.byte1()
	if err != nil {
		return 0, false
	}
	switch {
	case c <= 0x7f || c >= 0xe0:
		return int(int8(c)), true //nolint:gosec // G115: the fixint encoding is the byte's int8 value
	case c >= 0xcc && c <= 0xcf:
		v, err := r.uintN(1 << (c - 0xcc))
		if err != nil || v > math.MaxInt {
			return 0, false
		}
		return int(v), true //nolint:gosec // G115: checked against MaxInt
	case c >= 0xd0 && c <= 0xd3:
		size := 1 << (c - 0xd0)
		v, err := r.uintN(size)
		if err != nil {
			return 0, false
		}
		switch size {
		case 1:
			return int(int8(v)), true //nolint:gosec // G115: sign extension
		case 2:
			return int(int16(v)), true //nolint:gosec // G115: sign extension
		case 4:
			return int(int32(v)), true //nolint:gosec // G115: sign extension
		}
		if int64(v) < math.MinInt || int64(v) > math.MaxInt { //nolint:gosec // G115: two's complement
			return 0, false
		}
		return int(int64(v)), true //nolint:gosec // G115: checked against the int range
	}
	return 0, false
}

// ordered is UnpackOrdered's value at nesting depth.
func (r *mpReader) ordered(depth int) (any, error) {
	if depth > maxOrderedDepth {
		return nil, errTooDeep
	}
	c, err := r.byte1()
	if err != nil {
		return nil, err
	}
	n, isMap, ok, err := r.containerLen(c)
	if !ok {
		return r.scalar(c, true)
	}
	if err != nil {
		return nil, err
	}
	if !isMap {
		arr := make([]any, n)
		for i := range arr {
			v, err := r.ordered(depth + 1)
			if err != nil {
				return nil, err
			}
			if v != jsUndef {
				arr[i] = v
			}
		}
		return arr, nil
	}
	obj := make(superjson.Object, 0, n)
	// seen is a 64-bit filter of the keys read so far: a key whose bit is clear cannot be a repeat, so
	// it is appended without the scan obj.Set makes (a JS object has no repeated keys, so nearly every
	// key takes this path). A set bit only means "maybe": the scan then decides, as Set would.
	var seen uint64
	for range n {
		key, err := r.orderedKey()
		if err != nil {
			return nil, err
		}
		v, err := r.ordered(depth + 1)
		if err != nil {
			return nil, err
		}
		bit := keyBit(key)
		if v == jsUndef {
			// A repeated key's undefined still deletes it, as the JS assignment would leave it
			// undefined; JSON.stringify then omits it either way.
			if seen&bit != 0 {
				obj = dropKey(obj, key)
			}
			continue
		}
		if seen&bit != 0 {
			obj.Set(key, v)
		} else {
			obj = append(obj, superjson.Field{Key: key, Val: v})
		}
		seen |= bit
	}
	return jsKeyOrder(obj), nil
}

// keyBit is key's bit in an ordered map's seen filter.
func keyBit(key string) uint64 {
	h := uint(len(key))
	if len(key) > 0 {
		h = h*31 + uint(key[0])*7 + uint(key[len(key)-1])
	}
	return 1 << (h & 63)
}

// orderedKey is an UnpackOrdered map key as its JS property name: a str as it is; any other value read
// as Unpack reads it, then toKey (a number in decimal; anything else "").
func (r *mpReader) orderedKey() (string, error) {
	if r.i < len(r.s) && isStrCode(r.s[r.i]) {
		r.i++
		n, _, err := r.strLen(r.s[r.i-1])
		if err != nil {
			return "", err
		}
		return r.take(n)
	}
	k, err := r.plain()
	if err != nil {
		return "", err
	}
	return toKey(k), nil
}

// isStrCode reports a str code (fixstr, str8, str16, str32; not bin).
func isStrCode(c byte) bool {
	return (c >= 0xa0 && c <= 0xbf) || c == 0xd9 || c == 0xda || c == 0xdb
}

// unpackString is Unpack over a string. intList names the top-level member read as a []int
// (mpReader.ints); "" for none, which is Unpack itself.
func unpackString(s string, intList string) (any, error) {
	if err := checkSizes(s); err != nil {
		return nil, err
	}
	r := mpReader{s: s}
	c, err := r.byte1()
	if err != nil {
		return nil, err
	}
	n, isMap, ok, err := r.containerLen(c)
	var v any
	switch {
	case !ok:
		v, err = r.topScalar(c)
	case err != nil:
	case isMap:
		v, err = r.plainMap(n, intList)
	default:
		v, err = r.plainArray(n)
	}
	if err != nil {
		return nil, err
	}
	if v == jsUndef {
		return nil, nil
	}
	return v, nil
}

// topScalar is a top-level scalar as Unpack returned it: the decoder it replaced read the top-level
// value with its typed (not loose) interface decoding, so a number there keeps its encoded width
// (int8 for a fixint, uint8 .. uint64, int8 .. int64, float32) and a bin is a []byte. Nested values
// are always the loose types (scalar). No cache record is a scalar; this only keeps Unpack's answer
// for one the same.
func (r *mpReader) topScalar(c byte) (any, error) {
	switch {
	case c <= 0x7f || c >= 0xe0:
		return int8(c), nil //nolint:gosec // G115: the fixint encoding is the byte's int8 value
	case c >= 0xc4 && c <= 0xc6:
		n, _, err := r.strLen(c)
		if err != nil {
			return nil, err
		}
		s, err := r.take(n)
		if err != nil {
			return nil, err
		}
		b := make([]byte, len(s))
		copy(b, s)
		return b, nil
	}
	switch c {
	case 0xca:
		v, err := r.uintN(4)
		return math.Float32frombits(uint32(v)), err //nolint:gosec // G115: 4 bytes
	case 0xcc:
		v, err := r.uintN(1)
		return uint8(v), err //nolint:gosec // G115: 1 byte
	case 0xcd:
		v, err := r.uintN(2)
		return uint16(v), err //nolint:gosec // G115: 2 bytes
	case 0xce:
		v, err := r.uintN(4)
		return uint32(v), err //nolint:gosec // G115: 4 bytes
	case 0xd0:
		v, err := r.uintN(1)
		return int8(v), err //nolint:gosec // G115: sign of the one byte read
	case 0xd1:
		v, err := r.uintN(2)
		return int16(v), err //nolint:gosec // G115: sign of the two bytes read
	case 0xd2:
		v, err := r.uintN(4)
		return int32(v), err //nolint:gosec // G115: sign of the four bytes read
	}
	return r.scalar(c, false) // uint64, int64, float64, str, nil, bool, extensions: as nested
}

// unpackOrderedString is UnpackOrdered over a string.
func unpackOrderedString(s string) (any, error) {
	if err := checkSizes(s); err != nil {
		return nil, err
	}
	r := mpReader{s: s}
	return r.ordered(0)
}

// boxString is s as an any: a shared, already boxed value for a common enum string, else s boxed.
func boxString(s string) any {
	if len(s) <= maxInternedValue {
		if v, ok := internedValues[s]; ok {
			return v
		}
	}
	return s
}

// maxInternedValue is the longest internedValues string.
const maxInternedValue = 24

// internedValues are the enum strings cache records repeat on every entry (availability, media
// types, scan and ingestion states, model and file types, cosmetic kinds), each boxed once: a decoded
// value is an any, and boxing a string allocates its header, so every repeat of one of these would
// otherwise cost an allocation. Strings are immutable, so sharing one is safe.
var internedValues = func() map[string]any {
	words := []string{
		"", "Public", "Private", "Unsearchable", "EarlyAccess",
		"image", "video", "audio",
		"Pending", "Scanned", "Error", "Blocked", "NotFound", "PendingManualAssignment",
		"Success", "Danger",
		"Draft", "Training", "Published", "Scheduled", "Unpublished", "UnpublishedViolation", "GatherInterest", "Deleted",
		"Checkpoint", "TextualInversion", "Hypernetwork", "AestheticGradient", "LORA", "LoCon", "DoRA", "Controlnet",
		"Upscaler", "MotionModule", "VAE", "Poses", "Wildcards", "Workflows", "Detection", "Other",
		"AutoV1", "AutoV2", "AutoV3", "SHA256", "CRC32", "BLAKE3",
		"Badge", "NamePlate", "ProfileDecoration", "ContentDecoration", "ProfileBackground",
		"Trophy", "Purchase", "Event", "Membership", "Claim",
		"UserGenerated", "Label", "Moderation", "System",
		"Model", "Training Data", "Archive", "Config", "Pruned Model", "Negative",
		"SafeTensor", "PickleTensor", "GGUF", "Diffusers", "Core ML", "ONNX",
		"full", "pruned", "fp16", "fp32", "bf16", "fp8", "nf4",
		"No Pickle imports", "Standard", "Inpainting", "Refiner", "Pix2Pix", "Created", "Trained",
		"Model3D", "character", "style", "concept", "clothing", "poses", "background", "tool", "vehicle", "buildings",
		"objects", "assets", "animal", "action",
	}
	m := make(map[string]any, len(words))
	for _, w := range words {
		if len(w) > maxInternedValue {
			panic("hydrate: interned value longer than maxInternedValue: " + w)
		}
		m[w] = w
	}
	return m
}()
