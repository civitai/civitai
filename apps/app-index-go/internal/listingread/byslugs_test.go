package listingread

import (
	"slices"
	"strings"
	"testing"
)

// BySlugs mirrors listStoreListingsBySlugs: the given order, each listing once (first mention
// wins), only what the viewer could find in the grid with the same kind and category.
func TestBySlugs(t *testing.T) {
	ks := catalog()
	ks[2].Category = "tools"
	slugsOf := func(p Page) []string {
		out := make([]string, 0, len(p.URNs))
		for _, u := range p.URNs {
			out = append(out, strings.TrimPrefix(u, "urn:apps.civitai.com:store-listing/"))
		}
		return out
	}
	redX := Viewer{RedCapable: true, BrowsingLevel: 15, Scope: ScopeFull}
	for _, c := range []struct {
		name           string
		slugs          []string
		kind, category string
		v              Viewer
		want           []string
	}{
		{"given order, once each", []string{"echo", "alpha", "gone", "echo", "charlie"}, "", "", full, []string{"echo", "alpha", "charlie"}},
		{"mature hidden on the SFW host", []string{"delta", "golf", "alpha"}, "", "", full, []string{"alpha"}},
		{"and shown to a red X viewer", []string{"delta", "golf", "alpha"}, "", "", redX, []string{"delta", "golf", "alpha"}},
		{"public-external", []string{"alpha", "charlie"}, "", "", Viewer{Scope: ScopePublicExternal}, []string{"charlie"}},
		{"scope none", []string{"alpha"}, "", "", Viewer{Scope: ScopeNone}, []string{}},
		{"kind", []string{"alpha", "charlie"}, "offsite", "", full, []string{"charlie"}},
		{"category", []string{"alpha", "charlie"}, "", "tools", full, []string{"charlie"}},
		{"none asked", nil, "", "", full, []string{}},
	} {
		p := BySlugs(ks, c.slugs, c.kind, c.category, c.v)
		if got := slugsOf(p); !slices.Equal(got, c.want) || p.NextCursor != "" {
			t.Errorf("%s: %v (cursor %q), want %v", c.name, got, p.NextCursor, c.want)
		}
	}
}
