package hydrate

import (
	"bytes"
	"time"

	"github.com/vmihailenco/msgpack/v5"
	"github.com/vmihailenco/msgpack/v5/msgpcode"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The oracle: Unpack and UnpackOrdered exactly as they were before the single-pass reader
// (msgpack.go) replaced them, on vmihailenco/msgpack's generic decoder (its loose interface decoding,
// then a normalize pass). Test code only: the differential tests (msgpack_diff_test.go) decode every
// golden value, a generated corpus and the fuzzer's inputs through both and require the same answer.

func (*jsUndefined) UnmarshalMsgpack([]byte) error  { return nil }
func (jsUndefined) MarshalMsgpack() ([]byte, error) { return nil, nil }

func init() {
	msgpack.RegisterExt(0, (*jsUndefined)(nil))
}

func oracleUnpack(b []byte) (any, error) {
	if err := checkSizes(b); err != nil {
		return nil, err
	}
	dec := msgpack.NewDecoder(bytes.NewReader(b))
	dec.UseLooseInterfaceDecoding(true)
	v, err := dec.DecodeInterface()
	if err != nil {
		return nil, err
	}
	return oracleNormalize(v), nil
}

func oracleNormalize(v any) any {
	switch t := v.(type) {
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if oracleIsUndef(val) {
				continue
			}
			out[toKey(k)] = oracleNormalize(val)
		}
		return out
	case map[string]any:
		for k, val := range t {
			if oracleIsUndef(val) {
				delete(t, k)
				continue
			}
			t[k] = oracleNormalize(val)
		}
		return t
	case []any:
		for i := range t {
			if oracleIsUndef(t[i]) {
				t[i] = nil
				continue
			}
			t[i] = oracleNormalize(t[i])
		}
		return t
	case *jsUndefined, jsUndefined:
		return nil
	}
	return v
}

func oracleIsUndef(v any) bool {
	switch v.(type) {
	case *jsUndefined, jsUndefined:
		return true
	}
	return false
}

func oracleUnpackOrdered(b []byte) (any, error) {
	if err := checkSizes(b); err != nil {
		return nil, err
	}
	dec := msgpack.NewDecoder(bytes.NewReader(b))
	dec.UseLooseInterfaceDecoding(true)
	return oracleDecodeOrdered(dec, 0)
}

func oracleDecodeOrdered(dec *msgpack.Decoder, depth int) (any, error) {
	if depth > maxOrderedDepth {
		return nil, errTooDeep
	}
	c, err := dec.PeekCode()
	if err != nil {
		return nil, err
	}
	switch {
	case msgpcode.IsFixedMap(c) || c == msgpcode.Map16 || c == msgpcode.Map32:
		n, err := dec.DecodeMapLen()
		if err != nil {
			return nil, err
		}
		obj := make(superjson.Object, 0, max(n, 0))
		for i := 0; i < n; i++ {
			key, err := oracleDecodeOrderedKey(dec)
			if err != nil {
				return nil, err
			}
			v, err := oracleDecodeOrdered(dec, depth+1)
			if err != nil {
				return nil, err
			}
			if oracleIsUndef(v) {
				obj = dropKey(obj, key)
				continue
			}
			obj.Set(key, v)
		}
		return jsKeyOrder(obj), nil
	case msgpcode.IsFixedArray(c) || c == msgpcode.Array16 || c == msgpcode.Array32:
		n, err := dec.DecodeArrayLen()
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		arr := make([]any, n)
		for i := range arr {
			v, err := oracleDecodeOrdered(dec, depth+1)
			if err != nil {
				return nil, err
			}
			if oracleIsUndef(v) {
				v = nil
			}
			arr[i] = v
		}
		return arr, nil
	}
	v, err := dec.DecodeInterfaceLoose()
	if err != nil {
		return nil, err
	}
	switch t := v.(type) {
	case int8, int16, int32, int, uint8, uint16, uint32, uint:
		return Wire(t), nil
	case time.Time:
		return t.UTC(), nil
	}
	return v, nil
}

func oracleDecodeOrderedKey(dec *msgpack.Decoder) (string, error) {
	c, err := dec.PeekCode()
	if err != nil {
		return "", err
	}
	if msgpcode.IsString(c) {
		return dec.DecodeString()
	}
	k, err := dec.DecodeInterfaceLoose()
	if err != nil {
		return "", err
	}
	return toKey(k), nil
}
