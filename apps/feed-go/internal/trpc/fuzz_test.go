package trpc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"
)

// FuzzDecodeEnvelope: DecodeEnvelope never panics; an accepted envelope yields a non-nil map with
// every ["undefined"]-annotated top-level key removed; and ParseInput, reading the same bytes from
// the `input` query parameter, gives the same answer. Seed corpus: testdata/fuzz/FuzzDecodeEnvelope.
func FuzzDecodeEnvelope(f *testing.F) {
	f.Add([]byte(`{"json":{"modelId":7,"cursor":null},"meta":{"values":{"cursor":["undefined"]},"v":1}}`))
	f.Add([]byte(`{"json":null}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		out, err := DecodeEnvelope(raw)
		if err == nil {
			if out == nil {
				t.Fatalf("DecodeEnvelope(%q) = nil map, nil error", raw)
			}
			var env struct {
				Meta *struct {
					Values map[string]json.RawMessage `json:"values"`
				} `json:"meta"`
			}
			if json.Unmarshal(raw, &env) == nil && env.Meta != nil {
				for path, ann := range env.Meta.Values {
					var typ []any
					if json.Unmarshal(ann, &typ) == nil && len(typ) > 0 && typ[0] == "undefined" {
						if _, ok := out[path]; ok {
							t.Fatalf("DecodeEnvelope(%q) kept %q, annotated undefined", raw, path)
						}
					}
				}
			}
		}
		if len(raw) == 0 {
			return // an absent `input` is the empty input, not an empty envelope
		}
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/image.getImagesAsPostsInfinite?input="+url.QueryEscape(string(raw)), nil)
		got, gerr := ParseInput(r)
		if (err == nil) != (gerr == nil) || !reflect.DeepEqual(out, got) {
			t.Fatalf("ParseInput = %v, %v; DecodeEnvelope = %v, %v (raw %q)", got, gerr, out, err, raw)
		}
	})
}
