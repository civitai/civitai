package listingread

import (
	"encoding/json"
	"testing"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// The detail is the card plus the description, the install count and the gallery; an off-site
// listing has no play count and its link in kindData.
func TestProjectDetail(t *testing.T) {
	_, listings := loadParity(t)
	d, err := ProjectDetail(listings["null-rating"], Viewer{RedCapable: true, BrowsingLevel: 15, Scope: ScopeFull}, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(d)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["installCount"] != 12.0 || got["description"] != nil || got["openCount"] != nil ||
		got["coverUrl"] != "img/null-rating/cover-pg" || got["iconUrl"] != "img/null-rating/icon-pg13" {
		t.Fatalf("detail %s", b)
	}
	if shots := got["screenshots"].([]any); len(shots) != 1 {
		t.Fatalf("gallery %v", shots)
	}
	// The detail's off-site kindData carries the connect client (none here), which the card's does not.
	if kd := got["kindData"].(map[string]any); kd["kind"] != "offsite" || len(kd) != 3 || kd["connectClientId"] != nil {
		t.Fatalf("kindData %v", kd)
	}
	// A fork whose parent the stream names but the generation does not hold (nil), or holds under
	// another slug, reads as a parent not available.
	fork := listings["pg13-plain"]
	slug := "pg-mixed"
	fork.Detail.ForkOf = &store.ListingStreamFork{Slug: &slug}
	other := listings["g-listing"]
	for _, parent := range []*store.Listing{nil, &other} {
		d, err := ProjectDetail(fork, Viewer{Scope: ScopeFull}, parent)
		if err != nil || d.ForkOf == nil || d.ForkOf.Visible || d.ForkOf.Slug != nil {
			t.Fatalf("parent %v: forkOf %+v %v", parent != nil, d.ForkOf, err)
		}
	}
	// A listing whose body carries no detail fields reads them empty, never absent; its creator chip
	// is the body's.
	plain := listings["x-listing"]
	var fields map[string]any
	if err := json.Unmarshal(plain.Body, &fields); err != nil {
		t.Fatal(err)
	}
	fields["creator"] = map[string]any{"id": 8123, "username": "x-maker", "image": nil}
	plain.Body, _ = json.Marshal(fields)
	pd, err := ProjectDetail(plain, Viewer{RedCapable: true, BrowsingLevel: 15, Scope: ScopeFull}, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(pd)
	got = nil
	_ = json.Unmarshal(b, &got)
	for k, want := range map[string]string{"collaborators": "[]", "scopes": "[]", "connectScopes": "[]",
		"serialId": "null", "forkOf": "null", "forkable": "false", "creator": `{"id":8123,"image":null,"username":"x-maker"}`} {
		if g, _ := json.Marshal(got[k]); string(g) != want {
			t.Errorf("x-listing detail %s = %s, want %s", k, g, want)
		}
	}
	// A body the card cannot read fails the projection rather than serve a partial card.
	bad := listings["no-media"]
	bad.Body = json.RawMessage(`{"tagline": 5}`)
	if _, err := ProjectDetail(bad, Viewer{Scope: ScopeFull}, nil); err == nil {
		t.Fatal("an unreadable body projected")
	}
	if _, err := ProjectCard(store.Listing{Body: json.RawMessage(`[]`)}, Viewer{Scope: ScopeFull}); err == nil {
		t.Fatal("an array body projected")
	}
}
