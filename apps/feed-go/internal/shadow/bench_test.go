package shadow

import (
	"bytes"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

// goldenExpect reads one golden fixture's expected answer (testdata/golden, written by gen.mjs).
func goldenExpect(tb testing.TB, path string) (envelope, body json.RawMessage) {
	tb.Helper()
	raw, err := os.ReadFile(path) //nolint:gosec // G304: a fixed fixture path
	if err != nil {
		tb.Fatal(err)
	}
	var fx struct {
		Expect struct {
			Envelope json.RawMessage `json:"envelope"`
			Body     json.RawMessage `json:"body"`
		} `json:"expect"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		tb.Fatal(err)
	}
	return fx.Expect.Envelope, fx.Expect.Body
}

// page50 widens a golden envelope to 50 items by cycling its items (each copy keeps its fields;
// postId is renumbered so the items stay distinct), with the meta annotations re-pathed to match:
// the size of a full feed page.
func page50(tb testing.TB, env json.RawMessage) []byte {
	tb.Helper()
	var e struct {
		JSON struct {
			Items      []map[string]json.RawMessage `json:"items"`
			NextCursor json.RawMessage              `json:"nextCursor"`
		} `json:"json"`
		Meta struct {
			Values map[string]json.RawMessage `json:"values"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(env, &e); err != nil || len(e.JSON.Items) == 0 {
		tb.Fatalf("golden envelope: %v (%d items)", err, len(e.JSON.Items))
	}
	n := len(e.JSON.Items)
	items := make([]map[string]json.RawMessage, 50)
	values := map[string]json.RawMessage{}
	for i := range items {
		src := e.JSON.Items[i%n]
		it := make(map[string]json.RawMessage, len(src))
		for k, v := range src {
			it[k] = v
		}
		it["postId"] = json.RawMessage(strconv.Itoa(100000 + i))
		items[i] = it
		prefix := "items." + strconv.Itoa(i%n) + "."
		for p, ann := range e.Meta.Values {
			if rest, ok := strings.CutPrefix(p, prefix); ok {
				values["items."+strconv.Itoa(i)+"."+rest] = ann
			}
		}
	}
	out, err := json.Marshal(map[string]any{
		"json": map[string]any{"items": items, "nextCursor": e.JSON.NextCursor},
		"meta": map[string]any{"values": values, "v": 1},
	})
	if err != nil {
		tb.Fatal(err)
	}
	return out
}

// BenchmarkCompare compares a realistic page with an identical copy of itself (the common case: a
// matching shadow sample), on the largest as-posts golden answer and on it widened to 50 items.
func BenchmarkCompare(b *testing.B) {
	env, _ := goldenExpect(b, "../../testdata/golden/as-posts/version-signed-in-blue-newest.json")
	for _, c := range []struct {
		name string
		env  []byte
	}{{"golden", env}, {"page50", page50(b, env)}} {
		b.Run(c.name, func(b *testing.B) {
			other := bytes.Clone(c.env)
			if r, err := Compare(c.env, other); err != nil || !r.Match {
				b.Fatalf("a page does not match its copy: %+v, %v", r, err)
			}
			b.ReportAllocs()
			for b.Loop() {
				if _, err := Compare(c.env, other); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkCompareJSON is the same for the plain-JSON REST comparator on a golden /api/v1/images body.
func BenchmarkCompareJSON(b *testing.B) {
	_, body := goldenExpect(b, "../../testdata/golden/v1-images/model-version-id-filter.json")
	other := bytes.Clone(body)
	if r, err := CompareJSON(body, other); err != nil || !r.Match {
		b.Fatalf("a body does not match its copy: %+v, %v", r, err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := CompareJSON(body, other); err != nil {
			b.Fatal(err)
		}
	}
}
