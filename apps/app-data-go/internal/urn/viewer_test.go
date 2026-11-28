package urn

import (
	"errors"
	"testing"
)

// A viewer's stream of a shared collection major is the collection's schema URN with `.viewer` before
// the major (WRITES-DESIGN.md, "Feed routing"); every input the collection schema refuses, it refuses.
func TestViewerSchema(t *testing.T) {
	got, err := ViewerSchema("model-benchmarking", "records", 3)
	if err != nil || got != "urn:schema:apps.civitai.com:model-benchmarking/records.viewer@v3" {
		t.Fatalf("%q %v", got, err)
	}
	for _, c := range []struct {
		slug, coll string
		major      int
	}{{"Bad", "records", 1}, {"app", "Records", 1}, {"app", "records", 0}} {
		if _, err := ViewerSchema(c.slug, c.coll, c.major); !errors.Is(err, ErrInvalid) {
			t.Errorf("%+v: %v", c, err)
		}
	}
}
