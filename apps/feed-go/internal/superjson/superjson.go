// Package superjson writes the `{ json, meta }` envelope that the main app's tRPC client decodes
// (superjson 2.x, see src/shared/utils/trpc-union-transformer.ts: every reader is a format-sniffing
// union, and an OBJECT payload is routed to `superjson.deserialize`).
//
// Only the value types this service emits are supported:
//
//   - nil            -> JSON null
//   - Undefined{}    -> key/element present in meta as ["undefined"]; omitted from an object's JSON,
//     written as null inside an array (what JSON.stringify does with undefined)
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
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
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

type writer struct {
	buf   bytes.Buffer
	notes []annotation
}

// Serialize returns the superjson envelope for v as JSON bytes: `{"json":…}` or
// `{"json":…,"meta":{"values":{…},"v":1}}`.
func Serialize(v any) ([]byte, error) {
	w := &writer{}
	if err := w.value(v, nil, false); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	out.WriteString(`{"json":`)
	if _, isUndef := v.(Undefined); isUndef {
		// JSON.stringify drops an undefined top-level json; superjson then reads `json` as undefined.
		out.Truncate(0)
		out.WriteString(`{`)
	} else {
		out.Write(w.buf.Bytes())
	}
	if len(w.notes) > 0 {
		if out.Len() > 1 {
			out.WriteString(`,`)
		}
		out.WriteString(`"meta":{"values":`)
		if len(w.notes) == 1 && w.notes[0].path == "" {
			// A transformed ROOT value is annotated as a bare array (`["Date"]`), not a path map.
			out.WriteString(`[`)
			writeString(&out, w.notes[0].typ)
			out.WriteString(`]`)
		} else {
			out.WriteString(`{`)
			for i, n := range w.notes {
				if i > 0 {
					out.WriteString(`,`)
				}
				writeString(&out, n.path)
				out.WriteString(`:[`)
				writeString(&out, n.typ)
				out.WriteString(`]`)
			}
			out.WriteString(`}`)
		}
		out.WriteString(`,"v":1}`)
	}
	out.WriteString(`}`)
	return out.Bytes(), nil
}

// EscapeKey mirrors superjson's pathstringifier.escapeKey.
func EscapeKey(k string) string {
	k = strings.ReplaceAll(k, `\`, `\\`)
	return strings.ReplaceAll(k, `.`, `\.`)
}

func joinPath(path []string) string {
	parts := make([]string, len(path))
	for i, p := range path {
		parts[i] = EscapeKey(p)
	}
	return strings.Join(parts, ".")
}

func (w *writer) note(path []string, typ string) {
	w.notes = append(w.notes, annotation{path: joinPath(path), typ: typ})
}

// value writes v. inArray says whether an Undefined must be written as null (array element) — object
// members that are Undefined are skipped by the caller before reaching here.
func (w *writer) value(v any, path []string, inArray bool) error {
	switch t := v.(type) {
	case nil:
		w.buf.WriteString("null")
	case Undefined:
		w.note(path, "undefined")
		if inArray {
			w.buf.WriteString("null")
		}
	case time.Time:
		w.note(path, "Date")
		writeString(&w.buf, FormatDate(t))
	case *time.Time:
		if t == nil {
			w.buf.WriteString("null")
			return nil
		}
		return w.value(*t, path, inArray)
	case string:
		writeString(&w.buf, t)
	case bool:
		if t {
			w.buf.WriteString("true")
		} else {
			w.buf.WriteString("false")
		}
	case int:
		w.buf.WriteString(strconv.FormatInt(int64(t), 10))
	case int32:
		w.buf.WriteString(strconv.FormatInt(int64(t), 10))
	case int64:
		w.buf.WriteString(strconv.FormatInt(t, 10))
	case uint32:
		w.buf.WriteString(strconv.FormatUint(uint64(t), 10))
	case uint64:
		w.buf.WriteString(strconv.FormatUint(t, 10))
	case float32:
		return w.float(float64(t), path)
	case float64:
		return w.float(t, path)
	case json.RawMessage:
		if len(t) == 0 {
			w.buf.WriteString("null")
		} else {
			w.buf.Write(t)
		}
	case Object:
		w.buf.WriteByte('{')
		first := true
		for _, f := range t {
			child := append(append([]string(nil), path...), f.Key)
			if _, undef := f.Val.(Undefined); undef {
				w.note(child, "undefined")
				continue
			}
			if !first {
				w.buf.WriteByte(',')
			}
			first = false
			writeString(&w.buf, f.Key)
			w.buf.WriteByte(':')
			if err := w.value(f.Val, child, false); err != nil {
				return err
			}
		}
		w.buf.WriteByte('}')
	case *Object:
		if t == nil {
			w.buf.WriteString("null")
			return nil
		}
		return w.value(*t, path, inArray)
	case []any:
		w.buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				w.buf.WriteByte(',')
			}
			if err := w.value(e, append(append([]string(nil), path...), strconv.Itoa(i)), true); err != nil {
				return err
			}
		}
		w.buf.WriteByte(']')
	case []int:
		w.buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				w.buf.WriteByte(',')
			}
			w.buf.WriteString(strconv.Itoa(e))
		}
		w.buf.WriteByte(']')
	default:
		return fmt.Errorf("superjson: unsupported type %T at %q", v, joinPath(path))
	}
	return nil
}

func (w *writer) float(f float64, path []string) error {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		// superjson annotates these as ["number"] with a string value; nothing here produces them.
		return fmt.Errorf("superjson: non-finite number at %q", joinPath(path))
	}
	w.buf.WriteString(FormatNumber(f))
	return nil
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

// FormatDate is Date#toISOString: UTC, millisecond precision, `Z` suffix.
func FormatDate(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// writeString writes s as a JSON string. It differs from JSON.stringify only in escaping U+2028/U+2029
// (Go writes  ) and replacing invalid UTF-8 — both decode to the same string on the client.
func writeString(buf *bytes.Buffer, s string) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	out := b.Bytes()
	buf.Write(out[:len(out)-1]) // drop Encoder's trailing newline
}
