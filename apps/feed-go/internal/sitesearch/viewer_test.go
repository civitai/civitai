package sitesearch

import (
	"slices"
	"testing"
)

// ViewerOf against the handler's rules (src/pages/api/search/[...path].ts, getServerBrowsingLevel,
// collectionImageLevelFor), each expectation read off the Node code and pinned as a literal.
func TestViewerOf(t *testing.T) {
	for _, c := range []struct {
		name string
		in   Session
		want Viewer
	}{
		{"signed out, SFW host", Session{}, Viewer{Cap: 1, ShowSfwFace: true}},
		{"signed out, mature host", Session{CanViewNsfw: true}, Viewer{Cap: 1, ShowSfwFace: true}},
		{"signed in, SFW host", Session{SignedIn: true, ID: 7, BrowsingLevel: 31, ShowNsfw: true},
			Viewer{UserID: 7, Cap: 3, ShowSfwFace: true}},
		{"signed in, every level", Session{SignedIn: true, ID: 7, BrowsingLevel: 31, ShowNsfw: true, CanViewNsfw: true},
			Viewer{UserID: 7}},
		{"signed in, PG to R", Session{SignedIn: true, ID: 7, BrowsingLevel: 7, ShowNsfw: true, CanViewNsfw: true},
			Viewer{UserID: 7, CollectionImageLevel: 7}},
		{"signed in, SFW levels only", Session{SignedIn: true, ID: 7, BrowsingLevel: 3, ShowNsfw: true, CanViewNsfw: true},
			Viewer{UserID: 7, CollectionImageLevel: 3, ShowSfwFace: true}},
		{"signed in, showNsfw off", Session{SignedIn: true, ID: 7, BrowsingLevel: 31, CanViewNsfw: true},
			Viewer{UserID: 7, CollectionImageLevel: 1, ShowSfwFace: true}},
		// A non-moderator's Blocked bit is dropped: nothing selectable is left, so PG.
		{"signed in, Blocked only", Session{SignedIn: true, ID: 7, BrowsingLevel: 32, ShowNsfw: true, CanViewNsfw: true},
			Viewer{UserID: 7, CollectionImageLevel: 1, ShowSfwFace: true}},
		{"moderator", Session{SignedIn: true, ID: 9, IsModerator: true, BrowsingLevel: 63, ShowNsfw: true, CanViewNsfw: true},
			Viewer{UserID: 9, IsModerator: true}},
		{"moderator on the SFW host", Session{SignedIn: true, ID: 9, IsModerator: true, BrowsingLevel: 63, ShowNsfw: true},
			Viewer{UserID: 9, IsModerator: true, Cap: 3, ShowSfwFace: true}},
	} {
		if got := ViewerOf(c.in); got != c.want {
			t.Errorf("%s: ViewerOf = %+v, want %+v", c.name, got, c.want)
		}
	}
}

// Clauses against viewerSearchClauses and indexBrowsingLevelClause, pinned as the strings Node sends.
func TestClauses(t *testing.T) {
	for _, c := range []struct {
		name string
		uid  string
		v    Viewer
		want []string
	}{
		{"models signed out under PG", ModelsIndex, Viewer{Cap: 1},
			[]string{"poi != true", "availability != Private", "nsfwLevel=1"}},
		{"models own carve-out, no cap", ModelsIndex, Viewer{UserID: 42},
			[]string{"poi != true OR user.id = 42", "availability != Private OR user.id = 42"}},
		{"models moderator under SFW", ModelsIndex, Viewer{UserID: 9, IsModerator: true, Cap: 3},
			[]string{"nsfwLevel=1 OR nsfwLevel=2"}},
		{"models moderator, no cap", ModelsIndex, Viewer{UserID: 9, IsModerator: true}, nil},
		{"comics under PG", ComicsIndex, Viewer{Cap: 1},
			[]string{"nsfwLevel IS NOT EMPTY AND nsfwLevel NOT IN [2, 4, 8, 16, 32]"}},
		{"comics under SFW", ComicsIndex, Viewer{Cap: 3},
			[]string{"nsfwLevel IS NOT EMPTY AND nsfwLevel NOT IN [4, 8, 16, 32]"}},
		{"articles under SFW", ArticlesIndex, Viewer{Cap: 3}, []string{"nsfwLevel=1 OR nsfwLevel=2"}},
		{"collections under PG", CollectionsIndex, Viewer{Cap: 1, UserID: 3}, []string{"nsfwLevel=1"}},
		{"bounties under PG", BountiesIndex, Viewer{Cap: 1}, []string{"nsfwLevel=1"}},
		{"users have no level", UsersIndex, Viewer{Cap: 1}, nil},
		{"tools have no level", ToolsIndex, Viewer{Cap: 1}, nil},
		{"articles, no cap", ArticlesIndex, Viewer{UserID: 4}, nil},
	} {
		if got := Clauses(c.uid, c.v); !slices.Equal(got, c.want) {
			t.Errorf("%s: Clauses = %q, want %q", c.name, got, c.want)
		}
	}
	// A comics level holding every bit leaves nothing outside.
	if got := IndexBrowsingLevelClause(ComicsIndex, 63); got != "nsfwLevel IS NOT EMPTY" {
		t.Errorf("comics, every level: %q", got)
	}
	if got := IndexBrowsingLevelClause(ModelsIndex, 0); got != "" {
		t.Errorf("no bit: %q, want none", got)
	}
}

func TestHitsNeedShaping(t *testing.T) {
	capped, level, none := Viewer{Cap: 1}, Viewer{CollectionImageLevel: 7}, Viewer{}
	for _, c := range []struct {
		uid                 string
		capped, level, none bool
	}{
		{ModelsIndex, true, true, true},
		{CollectionsIndex, true, true, false},
		{ComicsIndex, true, false, false},
		{BountiesIndex, true, false, false},
		{ArticlesIndex, true, false, false},
		{UsersIndex, true, false, false},
		{ToolsIndex, false, false, false},
		{"", false, false, false},
	} {
		if got := HitsNeedShaping(c.uid, capped); got != c.capped {
			t.Errorf("%q capped: %v", c.uid, got)
		}
		if got := HitsNeedShaping(c.uid, level); got != c.level {
			t.Errorf("%q collection level: %v", c.uid, got)
		}
		if got := HitsNeedShaping(c.uid, none); got != c.none {
			t.Errorf("%q uncapped: %v", c.uid, got)
		}
	}
}

// The searchable indexes are SITE_SEARCH_INDEXES: the retired images index is refused.
func TestIndexes(t *testing.T) {
	want := []string{"models_v9", "articles_v5", "users_v3", "collections_v3", "bounties_v3", "tools_v2", "comics_v1"}
	if !slices.Equal(Indexes, want) {
		t.Fatalf("Indexes = %q, want %q", Indexes, want)
	}
	for _, uid := range []string{"images_v6", "metrics_images_v1", "", "models_v8"} {
		if IsSearchable(uid) {
			t.Errorf("%q is searchable", uid)
		}
	}
}
