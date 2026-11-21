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
	d, err := ProjectDetail(listings["null-rating"], Viewer{RedCapable: true, BrowsingLevel: 15, Scope: ScopeFull})
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
	if kd := got["kindData"].(map[string]any); kd["kind"] != "offsite" || len(kd) != 2 {
		t.Fatalf("kindData %v", kd)
	}
	// A body the card cannot read fails the projection rather than serve a partial card.
	bad := listings["no-media"]
	bad.Body = json.RawMessage(`{"tagline": 5}`)
	if _, err := ProjectDetail(bad, Viewer{Scope: ScopeFull}); err == nil {
		t.Fatal("an unreadable body projected")
	}
	if _, err := ProjectCard(store.Listing{Body: json.RawMessage(`[]`)}, Viewer{Scope: ScopeFull}); err == nil {
		t.Fatal("an array body projected")
	}
}
