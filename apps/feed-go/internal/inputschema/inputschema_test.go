package inputschema

import (
	"strings"
	"testing"
)

func TestEmbeddedSchemas(t *testing.T) {
	s := Get(InfiniteImages)
	for _, k := range []string{"limit", "cursor", "include", "withMeta"} {
		if !s.Has(k) {
			t.Errorf("getInfiniteImagesSchema has no %q", k)
		}
	}
	if s.Has("authed") || s.Has("direction") {
		t.Error("a tRPC client key is listed as a schema key")
	}
	if got := s.DefaultInt("limit"); got != 100 {
		t.Errorf("limit default = %d, want 100", got)
	}
	if got := Get(AllModels).DefaultString("sort"); got != "Highest Rated" {
		t.Errorf("model sort default = %q", got)
	}
	if !Get(AllModels).Has("page") {
		t.Error("model.getAll's router-added `page` is missing")
	}
	if got := Get(ImagesEndpoint).DefaultString("period"); got != "AllTime" {
		t.Errorf("v1 period default = %q", got)
	}
}

func TestUnknown(t *testing.T) {
	s := &Schema{name: "x", keys: map[string]bool{"a": true, "b": true}}
	if k, ok := s.Unknown([]string{"b", "a"}, nil); ok {
		t.Errorf("schema keys only: unknown %q", k)
	}
	if k, ok := s.Unknown([]string{"z", "a", "c", "t"}, map[string]bool{"t": true}); !ok || k != "c" {
		t.Errorf("Unknown = %q %v, want the first unknown in sorted order (c), the extra key allowed", k, ok)
	}
	if _, ok := s.Unknown(nil, nil); ok {
		t.Error("no keys: unknown")
	}
}

func TestMissingDefaultPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("a missing default did not panic")
		}
	}()
	Get(ImagesEndpoint).DefaultInt("limit") // numericString's preprocess hides it from the projection
}

// A default of another type panics too (decoding it into the asked type fails), so a regenerated file
// whose default changed type stops the service at startup instead of serving a zero value.
func TestWrongTypeDefaultPanics(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("a string default read as an int did not panic")
		}
		if msg, _ := r.(string); !strings.Contains(msg, `default for "sort": json:`) {
			t.Fatalf("panic %v, want the decode failure for sort", r)
		}
	}()
	Get(AllModels).DefaultInt("sort")
}

func TestUnknownSchemaPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("an unknown schema name did not panic")
		}
	}()
	Get("noSuchSchema")
}
