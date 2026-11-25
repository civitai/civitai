package feed

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
)

var hubIDOn = InfinitePorts{HubID: true}

// fakeHubs is a HubReader over literal rows, recording what it was asked.
type fakeHubs struct {
	hubs     map[int]*HubRow
	ranked   []RankedVersion
	versions map[int][]int // model → every version (the excluded-model read)
	withheld map[int]bool

	asked        []hubAsk
	maxRanks     []int
	rankedModels [][]int
	withheldAsk  [][]int
	err          error
}

type hubAsk struct {
	hubID, viewerID int
	moderator       bool
}

func (f *fakeHubs) Hub(_ context.Context, hubID, viewerID int, isModerator bool) (*HubRow, error) {
	f.asked = append(f.asked, hubAsk{hubID, viewerID, isModerator})
	if f.err != nil {
		return nil, f.err
	}
	return f.hubs[hubID], nil
}

func (f *fakeHubs) RankedModelVersions(_ context.Context, modelIDs []int, maxRank int) ([]RankedVersion, error) {
	f.rankedModels = append(f.rankedModels, modelIDs)
	f.maxRanks = append(f.maxRanks, maxRank)
	return f.ranked, nil
}

func (f *fakeHubs) ModelVersionIDsOf(_ context.Context, modelIDs []int) ([]int, error) {
	var out []int
	for _, m := range modelIDs {
		out = append(out, f.versions[m]...)
	}
	return out, nil
}

func (f *fakeHubs) WithheldModels(_ context.Context, modelIDs []int, _ int) (map[int]bool, error) {
	f.withheldAsk = append(f.withheldAsk, modelIDs)
	out := map[int]bool{}
	for _, m := range modelIDs {
		if f.withheld[m] {
			out[m] = true
		}
	}
	return out, nil
}

func gk(n int) *int { return &n }

func heldSettings(level int) *GallerySettings {
	held := true
	return &GallerySettings{SfwHeld: &held, Level: &level}
}

// The hub's enabled sources by kind; a session toggle removes a positive source and takes a tag's
// whole AND-group with it, and never touches a keep-out (an exclude group sharing the key included);
// a Collection source is read by nothing.
func TestResolveHubSourcesSessionExclusions(t *testing.T) {
	hubs := &fakeHubs{hubs: map[int]*HubRow{
		11: {ForcedBrowsingLevel: 0, Sources: []HubSourceRow{
			{Type: "User", TargetID: 1002},
			{Type: "User", TargetID: 1005},
			{Type: "ModelVersion", TargetID: 6301},
			{Type: "Tag", TargetID: 501, GroupKey: gk(7)},
			{Type: "Tag", TargetID: 502, GroupKey: gk(7)},
			{Type: "Tag", TargetID: 520},
			{Type: "Tag", TargetID: 521, GroupKey: gk(8)},
			{Type: "Collection", TargetID: 9101},
			{Type: "User", TargetID: 1009, Exclude: true},
			{Type: "Tag", TargetID: 531, Exclude: true, GroupKey: gk(7)},
			{Type: "Tag", TargetID: 532, Exclude: true, GroupKey: gk(7)},
			{Type: "ModelVersion", TargetID: 6401, Exclude: true},
		}},
	}}
	d := hubDeps{hubs: hubs, models: postVersionsOnly{versions: map[int]int{6301: 5004}}, holds: &fakeV1Gallery{}}
	got, err := resolveHubSources(context.Background(), d, 11, Viewer{ID: 1003}, []HubSourceRef{
		{Type: "User", TargetID: 1005}, {Type: "Tag", TargetID: 502}, {Type: "User", TargetID: 1009}, {Type: "Tag", TargetID: 531},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := &ResolvedHub{
		UserIDs:            []int{1002},
		VersionIDs:         []int{6301},
		TagGroups:          [][]int{{520}, {521}},
		ExcludedUserIDs:    []int{1009},
		ExcludedVersionIDs: []int{6401},
		ExcludedTagGroups:  [][]int{{531, 532}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resolved\n  %+v\nwant\n  %+v", got, want)
	}
	if !reflect.DeepEqual(hubs.asked, []hubAsk{{11, 1003, false}}) {
		t.Fatalf("hub read %v, want hub 11 for viewer 1003", hubs.asked)
	}
}

// A Model source expands under its share of the budget the explicit versions leave
// (750 - 2 explicit = 748, two models: 374 each, asked with one rank more to see a trim), a rank past
// the share trims it; the excluded Model expands to every version after the excluded versions, without
// repeats.
func TestResolveHubSourcesVersionExpansion(t *testing.T) {
	hubs := &fakeHubs{
		hubs: map[int]*HubRow{12: {Sources: []HubSourceRow{
			{Type: "ModelVersion", TargetID: 6101},
			{Type: "ModelVersion", TargetID: 6101}, // a repeat counts once against the budget
			{Type: "ModelVersion", TargetID: 6102},
			{Type: "Model", TargetID: 5001},
			{Type: "Model", TargetID: 5005},
			{Type: "ModelVersion", TargetID: 6402, Exclude: true},
			{Type: "Model", TargetID: 5007, Exclude: true},
		}}},
		ranked: []RankedVersion{
			{ID: 6900, ModelID: 5005, Rank: 375}, // past the share: trimmed
			{ID: 6402, ModelID: 5005, Rank: 1},
			{ID: 6102, ModelID: 5001, Rank: 1}, // also explicit: kept once
			{ID: 6002, ModelID: 5001, Rank: 2},
		},
		versions: map[int][]int{5007: {6402, 6701, 6702}},
	}
	d := hubDeps{hubs: hubs, models: postVersionsOnly{versions: map[int]int{6101: 5002, 6102: 5001, 6402: 5005, 6002: 5001}},
		holds: &fakeV1Gallery{settings: map[int]*GallerySettings{}}}
	got, err := resolveHubSources(context.Background(), d, 12, Viewer{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(hubs.maxRanks, []int{375}) || !reflect.DeepEqual(hubs.rankedModels, [][]int{{5001, 5005}}) {
		t.Fatalf("ranking asked for models %v at max rank %v, want [[5001 5005]] at [375]", hubs.rankedModels, hubs.maxRanks)
	}
	if !slices.Equal(got.VersionIDs, []int{6101, 6102, 6402, 6002}) || !got.Truncated {
		t.Fatalf("versions %v truncated %v, want [6101 6102 6402 6002] truncated", got.VersionIDs, got.Truncated)
	}
	if !slices.Equal(got.ExcludedVersionIDs, []int{6402, 6701, 6702}) {
		t.Fatalf("excluded versions %v, want [6402 6701 6702]", got.ExcludedVersionIDs)
	}
	// The cap: 760 explicit versions leave no budget (each model still gets 1) and the list is cut at 750.
	var many []HubSourceRow
	for i := range 760 {
		many = append(many, HubSourceRow{Type: "ModelVersion", TargetID: 10_000 + i})
	}
	hubs2 := &fakeHubs{hubs: map[int]*HubRow{13: {Sources: append(many, HubSourceRow{Type: "Model", TargetID: 5001})}},
		ranked: []RankedVersion{{ID: 6002, ModelID: 5001, Rank: 1}, {ID: 6001, ModelID: 5001, Rank: 2}}}
	got, err = resolveHubSources(context.Background(), hubDeps{hubs: hubs2, models: postVersionsOnly{}, holds: &fakeV1Gallery{}}, 13, Viewer{IsModerator: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.VersionIDs) != 750 || got.VersionIDs[749] != 10_749 || !got.Truncated || !slices.Equal(hubs2.maxRanks, []int{2}) {
		t.Fatalf("%d versions (last %d), truncated %v, max rank %v; want 750 ending 10749, truncated, [2]",
			len(got.VersionIDs), got.VersionIDs[len(got.VersionIDs)-1], got.Truncated, hubs2.maxRanks)
	}
}

// A taken-down model's versions leave the hub for anyone but its owner; the held level is the
// intersection over every held model the hub's versions are on (the expanded ones by their known
// model); a moderator is neither withheld nor held, and nothing is read for it.
func TestResolveHubSourcesWithheldAndHeld(t *testing.T) {
	newDeps := func() (*fakeHubs, hubDeps) {
		hubs := &fakeHubs{
			hubs: map[int]*HubRow{14: {ForcedBrowsingLevel: 7, Sources: []HubSourceRow{
				{Type: "ModelVersion", TargetID: 6201}, // taken down (5003)
				{Type: "ModelVersion", TargetID: 6101}, // SFW-only, held at 3 (5002)
				{Type: "Model", TargetID: 5008},        // held at 9 (expanded: 6801)
				{Type: "ModelVersion", TargetID: 6999}, // a version the cache does not hold
			}}},
			ranked:   []RankedVersion{{ID: 6801, ModelID: 5008, Rank: 1}},
			withheld: map[int]bool{5003: true},
		}
		return hubs, hubDeps{hubs: hubs,
			models: postVersionsOnly{versions: map[int]int{6201: 5003, 6101: 5002, 6801: 5008}},
			holds:  &fakeV1Gallery{settings: map[int]*GallerySettings{5002: heldSettings(3), 5008: heldSettings(9)}}}
	}
	hubs, d := newDeps()
	got, err := resolveHubSources(context.Background(), d, 14, Viewer{ID: 1003}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got.VersionIDs, []int{6101, 6999, 6801}) || !got.Held || got.HeldBrowsingLevel != 1 || got.ForcedBrowsingLevel != 7 {
		t.Fatalf("versions %v held %v at %d forced %d, want [6101 6999 6801] held at 1 forced 7",
			got.VersionIDs, got.Held, got.HeldBrowsingLevel, got.ForcedBrowsingLevel)
	}
	if !reflect.DeepEqual(hubs.withheldAsk, [][]int{{5003, 5002, 5008}}) {
		t.Fatalf("withheld asked %v, want [[5003 5002 5008]]", hubs.withheldAsk)
	}
	hubs, d = newDeps()
	got, err = resolveHubSources(context.Background(), d, 14, Viewer{ID: 1004, IsModerator: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got.VersionIDs, []int{6201, 6101, 6999, 6801}) || got.Held || len(hubs.withheldAsk) != 0 {
		t.Fatalf("moderator: versions %v held %v withheld asked %v, want all four, not held, no read", got.VersionIDs, got.Held, hubs.withheldAsk)
	}
	if !reflect.DeepEqual(hubs.asked, []hubAsk{{14, 1004, true}}) {
		t.Fatalf("hub read %v, want hub 14 for moderator 1004", hubs.asked)
	}
	// A held model without a level is not answered.
	_, d = newDeps()
	held := true
	d.holds = &fakeV1Gallery{settings: map[int]*GallerySettings{5002: {SfwHeld: &held}}}
	if _, err := resolveHubSources(context.Background(), d, 14, Viewer{ID: 1003}, nil); fallback.Reason(err) != "held-level-unset" {
		t.Fatalf("a held model without a level: %v, want held-level-unset", err)
	}
}

// hubBrowsingLevel: the request's level unchanged without a cap; with one, an absent (0) level reads
// as PG, then the hub's cap and the held level narrow it.
func TestHubBrowsingLevel(t *testing.T) {
	for _, c := range []struct {
		level, forced int
		held          bool
		heldLevel     int
		want          int
	}{
		{31, 0, false, 0, 31},
		{0, 0, false, 0, 0},
		{31, 7, false, 0, 7},
		{31, 7, true, 3, 3},
		{0, 6, false, 0, 0},
		{0, 7, false, 0, 1},
		{0, 0, true, 2, 0},
		{28, 0, true, 0, 0},
		{1, 4, false, 0, 0},
	} {
		h := &ResolvedHub{ForcedBrowsingLevel: c.forced, Held: c.held, HeldBrowsingLevel: c.heldLevel}
		if got := hubBrowsingLevel(c.level, h); got != c.want {
			t.Errorf("hubBrowsingLevel(%d, forced %d, held %v@%d) = %d, want %d", c.level, c.forced, c.held, c.heldLevel, got, c.want)
		}
	}
}

// resolveHubForFeed: no hub, no source left (a Collection alone is no source) or a cap that leaves
// nothing is `hubSources: null` (nil); otherwise the feed's hub and the level it is asked at.
func TestHubForFeed(t *testing.T) {
	hubs := &fakeHubs{hubs: map[int]*HubRow{
		21: {Sources: []HubSourceRow{{Type: "Collection", TargetID: 9101}, {Type: "User", TargetID: 1009, Exclude: true}}},
		22: {ForcedBrowsingLevel: 4, Sources: []HubSourceRow{{Type: "User", TargetID: 1002}}},
		23: {ForcedBrowsingLevel: 6, Sources: []HubSourceRow{{Type: "User", TargetID: 1002}, {Type: "User", TargetID: 1009, Exclude: true}}},
	}}
	d := hubDeps{hubs: hubs, models: postVersionsOnly{}, holds: &fakeV1Gallery{}}
	ctx := context.Background()
	for _, c := range []struct {
		hubID, level int
		want         *feedsvc.Hub
		wantLevel    int
	}{
		{20, 31, nil, 0},
		{21, 31, nil, 0},
		{22, 1, nil, 0},
		{23, 31, &feedsvc.Hub{UserIDs: []int{1002}, ExcludedUserIDs: []int{1009}}, 6},
	} {
		got, level, err := hubForFeed(ctx, d, c.hubID, Viewer{}, nil, c.level)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, c.want) || level != c.wantLevel {
			t.Errorf("hub %d at %d: %+v at %d, want %+v at %d", c.hubID, c.level, got, level, c.want, c.wantLevel)
		}
	}
	hubs.err = errors.New("replica down")
	if _, _, err := hubForFeed(ctx, d, 22, Viewer{}, nil, 31); err == nil || err.Error() != "replica down" {
		t.Fatalf("a failed hub read: %v, want the read's error", err)
	}
}

// groupTagIds: rows sharing a key are one AND-group in first-appearance order; the polarity is part
// of the key, so an include and an exclude group of the same key stay apart even in one list.
func TestGroupTagIDs(t *testing.T) {
	got := groupTagIDs([]HubSourceRow{
		{Type: "Tag", TargetID: 1, GroupKey: gk(3)},
		{Type: "User", TargetID: 99, GroupKey: gk(3)},
		{Type: "Tag", TargetID: 2},
		{Type: "Tag", TargetID: 3, GroupKey: gk(3), Exclude: true},
		{Type: "Tag", TargetID: 4, GroupKey: gk(3)},
		{Type: "Tag", TargetID: 5, GroupKey: gk(3), Exclude: true},
	})
	if want := [][]int{{1, 4}, {2}, {3, 5}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("groups %v, want %v", got, want)
	}
}

// Off (the default), `hubId` and `hubExcludedSources` fall back as before the port; on, they are
// read, and the schema's refusals are Node's BAD_REQUEST, a non-int4 id the not-int4 fallback.
func TestParseInfiniteHubID(t *testing.T) {
	for input, want := range map[string]string{
		`{"hubId":9301}`: "input-hubId",
		`{"hubId":0}`:    "input-hubId",
		`{"hubExcludedSources":[{"type":"User","targetId":1}]}`: "input-hubExcludedSources",
	} {
		if _, err := ParseInfiniteWith(parseObj(t, input), InfinitePorts{}); fallback.Reason(err) != want {
			t.Errorf("%s off: %v, want %s", input, err, want)
		}
	}
	in, err := ParseInfiniteWith(parseObj(t,
		`{"hubId":9301,"hubExcludedSources":[{"type":"User","targetId":1002,"extra":1},{"type":"Tag","targetId":3000000000},{"type":"ModelVersion","targetId":6301}]}`), hubIDOn)
	if err != nil {
		t.Fatal(err)
	}
	if in.HubID != 9301 || !reflect.DeepEqual(in.HubExcludedSources, []HubSourceRef{{"User", 1002}, {"ModelVersion", 6301}}) {
		t.Fatalf("parsed hub %d, exclusions %+v; want 9301 and [User:1002 ModelVersion:6301]", in.HubID, in.HubExcludedSources)
	}
	if in, err := ParseInfiniteWith(parseObj(t, `{"hubId":-5}`), hubIDOn); err != nil || in.HubID != -5 {
		t.Fatalf("a negative hubId: %+v %v, want -5 (truthy)", in, err)
	}
	if in, err := ParseInfiniteWith(parseObj(t, `{"hubId":0,"postId":7101}`), hubIDOn); err != nil || in.HubID != 0 {
		t.Fatalf("hubId 0 beside a postId: %+v %v, want no hub and no refusal", in, err)
	}
	for input, want := range map[string]string{
		`{"hubId":null}`:                                          "input-invalid",
		`{"hubId":"9301"}`:                                        "input-invalid",
		`{"hubId":1.5}`:                                           "input-hubId",
		`{"hubId":2147483648}`:                                    "input-hubId",
		`{"hubId":9301,"postId":7101}`:                            "input-invalid",
		`{"hubId":9301,"ids":[1]}`:                                "input-invalid",
		`{"hubId":9301,"modelId":5001}`:                           "input-invalid",
		`{"hubId":9301,"collectionId":9}`:                         "input-invalid",
		`{"hubId":9301,"userId":1001,"publishedOnly":true}`:       "input-publishedOnly",
		`{"hubId":9301,"userId":1001,"requiringMeta":true}`:       "input-invalid",
		`{"hubExcludedSources":null}`:                             "input-invalid",
		`{"hubExcludedSources":[{"type":"Image","targetId":1}]}`:  "input-invalid",
		`{"hubExcludedSources":[{"type":"User","targetId":0}]}`:   "input-invalid",
		`{"hubExcludedSources":[{"type":"User","targetId":1.5}]}`: "input-invalid",
		`{"hubExcludedSources":[{"type":"User"}]}`:                "input-invalid",
		`{"hubExcludedSources":["User:1"]}`:                       "input-invalid",
	} {
		if _, err := ParseInfiniteWith(parseObj(t, input), hubIDOn); fallback.Reason(err) != want {
			t.Errorf("%s on: %v, want %s", input, err, want)
		}
	}
	// `publishedOnly` beside a `userId`, with its own port on: the superRefine reads it as sent.
	if _, err := ParseInfiniteWith(parseObj(t, `{"hubId":9301,"userId":1001,"publishedOnly":true}`),
		InfinitePorts{HubID: true, PublishedOnly: true}); fallback.Reason(err) != "input-invalid" {
		t.Fatalf("hubId beside publishedOnly+userId: %v, want input-invalid", err)
	}
	// More than 50 exclusions.
	many := `{"hubExcludedSources":[` + `{"type":"User","targetId":1}`
	for range 50 {
		many += `,{"type":"User","targetId":1}`
	}
	if _, err := ParseInfiniteWith(parseObj(t, many+`]}`), hubIDOn); fallback.Reason(err) != "input-invalid" {
		t.Fatalf("51 exclusions: %v, want input-invalid", err)
	}
	if in, err := ParseInfiniteWith(parseObj(t, many[:len(many)-len(`,{"type":"User","targetId":1}`)]+`]}`), hubIDOn); err != nil || len(in.HubExcludedSources) != 50 {
		t.Fatalf("50 exclusions: %v, want them read", err)
	}
}
