package modelfeed

import (
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// FuzzParse: model.getAll's parser never panics, refuses only with a fallback, and an accepted input
// stays inside what the query builder interpolates or binds: a limit of 0–100, a known sort and
// period, file formats from the constants list (they are written into the SQL text), no unsupported
// key; and the page query it builds either parses its cursor or refuses with the cursor fallback.
// Seed corpus: testdata/fuzz/FuzzParse.
func FuzzParse(f *testing.F) {
	f.Add([]byte(`{"json":{"sort":"Newest","limit":32,"cursor":"2026-06-12 10:00:00.125|5001","baseModels":["Pony","SDXL 1.0"]}}`))
	f.Add([]byte(`{"json":{"sort":"Newest","limit":32,"cursor":"2026-06-12 10:00:00.25|5001"}}`))
	f.Add([]byte(`{"json":{"types":"LORA","fileFormats":["SafeTensor"],"username":"Some User","tagname":"anime","allowCommercialUse":"Sell"}}`))
	f.Add([]byte(`{"json":{"query":"x","collectionId":3}}`))
	f.Add([]byte(`{"json":{"cursor":"|5","sort":"Oldest","earlyAccess":"yes","archived":1}}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		m, err := trpc.DecodeEnvelope(raw)
		if err != nil {
			return
		}
		in, err := Parse(m)
		if err != nil {
			if fallback.Reason(err) == "" {
				t.Fatalf("Parse(%s) refused with a non-fallback error: %v", raw, err)
			}
			return
		}
		if in.Limit < 0 || in.Limit > 100 || !knownSorts[in.Sort] || !knownPeriods[in.Period] {
			t.Fatalf("Parse(%s): limit %d sort %q period %q", raw, in.Limit, in.Sort, in.Period)
		}
		for _, ff := range in.FileFormats {
			if !fileFormats[ff] {
				t.Fatalf("Parse(%s): file format %q reaches the SQL text", raw, ff)
			}
		}
		for _, k := range unsupportedKeys {
			if v, ok := m[k]; ok && !isEmpty(v) {
				t.Fatalf("Parse(%s): accepted unsupported key %s", raw, k)
			}
		}
		lv := 1
		if in.BrowsingLevel != nil {
			lv = *in.BrowsingLevel
		}
		q := PageQuery{Take: in.Limit, Cursor: in.Cursor, Sort: in.Sort, BrowsingLevel: lv, Types: in.Types,
			BaseModels: in.BaseModels, FileFormats: in.FileFormats, CheckpointType: in.CheckpointType}
		if _, err := q.Build(); err != nil && fallback.Reason(err) != "model-cursor" {
			t.Fatalf("Build(%s): %v", raw, err)
		}
	})
}
