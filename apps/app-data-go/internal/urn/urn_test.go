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

func TestParseCollectionSchemaIsTheInverse(t *testing.T) {
	slug, coll, major, err := ParseCollectionSchema("urn:schema:apps.civitai.com:model-benchmarking/records@v12")
	if err != nil || slug != "model-benchmarking" || coll != "records" || major != 12 {
		t.Fatalf("got %q %q %d %v", slug, coll, major, err)
	}
	for _, bad := range []string{
		"urn:schema:other.example:model-benchmarking/records@v1", // another namespace
		"urn:schema:apps.civitai.com:model-benchmarking/records", // no major
		"urn:schema:apps.civitai.com:model-benchmarking/records@v0",
		"urn:schema:apps.civitai.com:model-benchmarking/records@v01",
		"urn:schema:apps.civitai.com:model-benchmarking/records@v1000000000",
		"urn:schema:apps.civitai.com:model-benchmarking/records.viewer@v1", // the per-viewer schema
		"urn:schema:apps.civitai.com:model-benchmarking@v1",                // no collection
		"urn:schema:apps.civitai.com:Model/records@v1",                     // a bad slug
		"urn:schema:apps.civitai.com:a/b/c@v1",                             // a bad collection
	} {
		if _, _, _, err := ParseCollectionSchema(bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q: %v, want ErrInvalid", bad, err)
		}
	}
}
