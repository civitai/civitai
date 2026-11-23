package modelfeed

import (
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

func objectKeys(o superjson.Object) []string {
	out := make([]string, len(o))
	for i, f := range o {
		out[i] = f.Key
	}
	return out
}

// A showcase image on the wire is stripGetAllModelImage's `{...rest}`: the cached record's members in
// their order, the dropped ones left out wherever they sit, the nested objects as cached; the cached
// record is not changed.
func TestImageWireKeepsCachedOrder(t *testing.T) {
	meta := superjson.Object{{Key: "width", Val: int64(5)}, {Key: "hash", Val: "h"}}
	img := superjson.Object{
		{Key: "url", Val: "u"}, {Key: "onSite", Val: true}, {Key: "id", Val: int64(1)},
		{Key: "hasMeta", Val: true}, {Key: "metadata", Val: meta}, {Key: "availability", Val: "Public"},
		{Key: "modelVersionId", Val: int64(10)}, {Key: "tags", Val: []any{}}, {Key: "hasPositivePrompt", Val: false},
	}
	before := append(superjson.Object(nil), img...)
	got := imageWire(img)
	if want := []string{"url", "id", "metadata", "tags"}; !reflect.DeepEqual(objectKeys(got), want) {
		t.Fatalf("image keys %q, want %q", objectKeys(got), want)
	}
	if m, _ := got.Get("metadata"); !reflect.DeepEqual(m, meta) {
		t.Fatalf("metadata %v, want the cached object", m)
	}
	if !reflect.DeepEqual(img, before) {
		t.Fatalf("the cached record changed: %v", img)
	}
}

// The shown version is `{...version, flags: toPublicApiVersionFlags(version.flags)}`: the cached
// members in their order, flags in its own place; the .com face's empty
// description the same. The cached record is not changed; a new member goes last.
func TestVersionWireKeepsCachedOrder(t *testing.T) {
	settings := superjson.Object{{Key: "strength", Val: int64(1)}, {Key: "clip", Val: int64(2)}}
	v := superjson.Object{
		{Key: "name", Val: "v"}, {Key: "flags", Val: int64(32)}, {Key: "id", Val: int64(6001)},
		{Key: "description", Val: "red"}, {Key: "settings", Val: settings},
	}
	before := append(superjson.Object(nil), v...)
	got := versionWire(v)
	if want := []string{"name", "flags", "id", "description", "settings"}; !reflect.DeepEqual(objectKeys(got), want) {
		t.Fatalf("version keys %q, want %q", objectKeys(got), want)
	}
	if f, _ := got.Get("flags"); f != int64(toPublicAPIVersionFlags(32)) {
		t.Fatalf("flags %v, want the public-API flags of 32", f)
	}
	if s, _ := got.Get("settings"); !reflect.DeepEqual(s, settings) {
		t.Fatalf("settings %v, want the cached object", s)
	}
	face := withField(v, "description", "")
	if want := []string{"name", "flags", "id", "description", "settings"}; !reflect.DeepEqual(objectKeys(face), want) {
		t.Fatalf("face keys %q, want %q", objectKeys(face), want)
	}
	if d, _ := face.Get("description"); d != "" {
		t.Fatalf("face description %q", d)
	}
	if !reflect.DeepEqual(v, before) {
		t.Fatalf("the cached record changed: %v", v)
	}
	// A version without flags is copied as is; a member it lacks goes last.
	noFlags := superjson.Object{{Key: "name", Val: "v"}, {Key: "id", Val: int64(6002)}}
	if got := versionWire(noFlags); !reflect.DeepEqual(got, noFlags) {
		t.Fatalf("no flags: %v", got)
	}
	if got := withField(noFlags, "description", ""); !reflect.DeepEqual(objectKeys(got), []string{"name", "id", "description"}) {
		t.Fatalf("a new member: %q", objectKeys(got))
	}
}
