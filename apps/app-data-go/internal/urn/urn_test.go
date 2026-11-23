package urn

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type vector struct {
	Slug       string  `json:"slug"`
	Collection string  `json:"collection"`
	Major      int     `json:"major"`
	URN        *string `json:"urn"`
}

// Every vector the TypeScript adapter answered (testdata/golden/gen.ts): the same URN, or a refusal.
func TestCollectionSchemaAgreesWithTheAdapter(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "golden", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Vectors []vector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	// Positive control: an empty or truncated file must not pass as agreement.
	accepted := 0
	for _, v := range file.Vectors {
		got, err := CollectionSchema(v.Slug, v.Collection, v.Major)
		switch {
		case v.URN == nil:
			if !errors.Is(err, ErrInvalid) {
				t.Errorf("%q/%q@%d: adapter refuses, got %q, %v", v.Slug, v.Collection, v.Major, got, err)
			}
		case err != nil || got != *v.URN:
			t.Errorf("%q/%q@%d: adapter names %q, got %q, %v", v.Slug, v.Collection, v.Major, *v.URN, got, err)
		default:
			accepted++
		}
	}
	if len(file.Vectors) < 20 || accepted != 4 {
		t.Fatalf("vectors: %d, accepted: %d; want at least 20 vectors and exactly 4 accepted", len(file.Vectors), accepted)
	}
}

func TestTheSegmentGrammars(t *testing.T) {
	for s, want := range map[string]bool{"model-benchmarking": true, "a": true, "-x": false, "x-": false, "Ab": false, "": false} {
		if ValidSlug(s) != want {
			t.Errorf("ValidSlug(%q) = %v, want %v", s, !want, want)
		}
	}
	for c, want := range map[string]bool{"kv": true, "records_2": true, "2kv": false, "kv.viewer": false, "Kv": false, "": false} {
		if ValidCollection(c) != want {
			t.Errorf("ValidCollection(%q) = %v, want %v", c, !want, want)
		}
	}
}

// A document URN is the adapter's private-feed form, and anything it would refuse to name is refused.
// Fails on origin/main: there is no Document (the test does not compile).
func TestDocumentIsTheAdaptersRecordURN(t *testing.T) {
	got, err := Document("model-benchmarking", "kv", "0b7e3c1a-55d2-4f0e-9c41-7d2a9e1f6b30")
	if err != nil || got != "urn:apps.civitai.com:model-benchmarking/kv/0b7e3c1a-55d2-4f0e-9c41-7d2a9e1f6b30" {
		t.Fatalf("%q, %v", got, err)
	}
	for _, c := range [][3]string{{"Bad", "kv", "r1"}, {"app", "2kv", "r1"}, {"app", "kv", ""}, {"app", "kv", "a/b"}} {
		if got, err := Document(c[0], c[1], c[2]); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q: %q, %v; want ErrInvalid", c, got, err)
		}
	}
}
