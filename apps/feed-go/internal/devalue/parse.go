package devalue

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// maxParseDepth bounds the nesting ParseJSON and Parse follow.
const maxParseDepth = 512

var errTooDeep = errors.New("devalue: value nested too deeply")

// ParseJSON is JSON.parse into the superjson value model: an object becomes a superjson.Object in the
// text's key order (a repeated key keeps its first position and takes its last value, as JSON.parse
// assigns it), an array a []any, a number a float64 (a JS number: out of range is ±Infinity or 0).
// Every object and array is a new value with an identity of its own (capacity at least 1), as each
// JSON.parse result is.
func ParseJSON(b []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	v, err := parseJSONValue(dec, 0)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("devalue: trailing data after the JSON value")
	}
	return v, nil
}

func parseJSONValue(dec *json.Decoder, depth int) (any, error) {
	if depth > maxParseDepth {
		return nil, errTooDeep
	}
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := make(superjson.Object, 0, 1)
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("devalue: object key %v", kt)
				}
				v, err := parseJSONValue(dec, depth+1)
				if err != nil {
					return nil, err
				}
				obj.Set(k, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		case '[':
			arr := make([]any, 0, 1)
			for dec.More() {
				v, err := parseJSONValue(dec, depth+1)
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
		return nil, fmt.Errorf("devalue: unexpected %v", t)
	case json.Number:
		return jsNumber(string(t))
	}
	return tok, nil // string, bool, nil
}

// jsNumber is Number(text) for a JSON number: the nearest float64, ±Infinity past the range.
func jsNumber(s string) (float64, error) {
	f, err := strconv.ParseFloat(s, 64)
	var ne *strconv.NumError
	if err != nil && !(errors.As(err, &ne) && errors.Is(ne.Err, strconv.ErrRange)) {
		return 0, err
	}
	return f, nil
}

// Parse is devalue's `parse`: the value a devalue text stands for. Each entry is one value, so an
// index referenced twice is the same Go reference twice (the same superjson.Object, []any, Map or Set,
// the same *time.Time), and writing the result again with Stringify reproduces the text. Objects are
// superjson.Object in the entry's key order, arrays []any, Dates *time.Time, numbers float64. It
// reads what this package writes (no holes, sparse arrays, typed arrays, RegExp, URL or boxed
// primitives) and refuses the rest. The service never reads devalue: this is for tests and tools.
func Parse(text string) (any, error) {
	root, err := ParseJSON([]byte(text))
	if err != nil {
		return nil, err
	}
	if f, ok := root.(float64); ok {
		return special(int(f))
	}
	entries, ok := root.([]any)
	if !ok || len(entries) == 0 {
		return nil, errors.New("devalue: not a devalue text")
	}
	p := &parser{entries: entries, done: make([]bool, len(entries)), vals: make([]any, len(entries))}
	return p.hydrate(0, 0)
}

type parser struct {
	entries []any
	done    []bool
	vals    []any
}

func special(i int) (any, error) {
	switch i {
	case idxUndefined:
		return superjson.Undefined{}, nil
	case idxNaN:
		return math.NaN(), nil
	case idxPosInfinity:
		return math.Inf(1), nil
	case idxNegInfinity:
		return math.Inf(-1), nil
	case idxNegativeZero:
		return math.Copysign(0, -1), nil
	}
	return nil, fmt.Errorf("devalue: invalid index %d", i)
}

func (p *parser) ref(v any, depth int) (any, error) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) {
		return nil, fmt.Errorf("devalue: index %v is not an integer", v)
	}
	return p.hydrate(int(f), depth)
}

func (p *parser) hydrate(i, depth int) (any, error) {
	if i < 0 {
		return special(i)
	}
	if i >= len(p.entries) {
		return nil, fmt.Errorf("devalue: index %d out of range", i)
	}
	if p.done[i] {
		return p.vals[i], nil
	}
	if depth > maxParseDepth {
		return nil, errTooDeep
	}
	set := func(v any) any {
		p.done[i], p.vals[i] = true, v
		return v
	}
	switch t := p.entries[i].(type) {
	case superjson.Object:
		obj := make(superjson.Object, 0, max(len(t), 1))
		set(obj)
		for _, f := range t {
			v, err := p.ref(f.Val, depth+1)
			if err != nil {
				return nil, err
			}
			obj = append(obj, superjson.Field{Key: f.Key, Val: v})
		}
		// The slice header grew; the backing array was sized above, so earlier references (a cycle)
		// see the same array. Record the full header.
		return set(obj), nil
	case []any:
		if len(t) > 0 {
			if tag, ok := t[0].(string); ok {
				return p.tagged(tag, t[1:], depth, set)
			}
		}
		arr := make([]any, len(t), max(len(t), 1))
		set(arr)
		for k, e := range t {
			v, err := p.ref(e, depth+1)
			if err != nil {
				return nil, err
			}
			arr[k] = v
		}
		return arr, nil
	default:
		// A primitive entry: string, number, bool, null.
		return set(t), nil
	}
}

func (p *parser) tagged(tag string, args []any, depth int, set func(any) any) (any, error) {
	if (tag == "Date" || tag == "BigInt") && len(args) != 1 {
		return nil, fmt.Errorf("devalue: %s with %d arguments", tag, len(args))
	}
	switch tag {
	case "Date":
		s, _ := args[0].(string)
		at := new(time.Time)
		if s != "" {
			t, err := time.Parse(time.RFC3339Nano, s)
			if err != nil {
				return nil, fmt.Errorf("devalue: Date %q: %w", s, err)
			}
			*at = t.UTC()
		}
		return set(at), nil
	case "BigInt":
		s, _ := args[0].(string)
		return set(BigInt(s)), nil
	case "Set":
		s := make(Set, len(args), max(len(args), 1))
		set(s)
		for k, a := range args {
			v, err := p.ref(a, depth+1)
			if err != nil {
				return nil, err
			}
			s[k] = v
		}
		return s, nil
	case "Map":
		if len(args)%2 != 0 {
			return nil, errors.New("devalue: Map with an odd entry count")
		}
		m := make(Map, len(args)/2, max(len(args)/2, 1))
		set(m)
		for k := 0; k < len(args); k += 2 {
			key, err := p.ref(args[k], depth+1)
			if err != nil {
				return nil, err
			}
			val, err := p.ref(args[k+1], depth+1)
			if err != nil {
				return nil, err
			}
			m[k/2] = MapEntry{Key: key, Val: val}
		}
		return m, nil
	}
	return nil, fmt.Errorf("devalue: unsupported type %q", tag)
}
