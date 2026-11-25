//go:build integration

package feed

// GalleryStore.Hub against a real Postgres: which viewer may read which hub row, and the sources it
// then reads. The unit tests' fake applies its own visibility rule after matching two substrings of
// the SQL, so only this test runs the WHERE clause itself. Expected values are literals written here.
//
// Ids in this file live in 2_108_000..2_108_999.

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// integSeedHubs resets the 2_108_xxx hub fixture: owner O = 2108901, stranger S = 2108902, moderator
// M = 2108903.
//
//	hub      owner  availability  forcedBrowsingLevel  enabled sources (id order)
//	2108101  O      Private       3                    User O; ModelVersion 2108601 (exclude);
//	                                                   Tag 2108701 + Tag 2108702 (group 7)
//	                                                   (and a disabled Model 2108651)
//	2108102  O      Public        0                    User S
//	2108103  S      Public        28                   Model 2108652
//	2108104  O      Unsearchable  1                    Tag 2108703
//
// Two Public rows besides the private hub: a WHERE clause whose visibility test escapes its `h.id`
// match would find one of them for a stranger asking for 2108101.
func integSeedHubs(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	integtest.Exec(t, pool, `
		DELETE FROM "UserHubSource" WHERE "hubId" BETWEEN 2108000 AND 2108999;
		DELETE FROM "UserHub" WHERE id BETWEEN 2108000 AND 2108999;
		INSERT INTO "UserHub" (id, "userId", availability, "forcedBrowsingLevel") VALUES
		  (2108101, 2108901, 'Private', 3),
		  (2108102, 2108901, 'Public', 0),
		  (2108103, 2108902, 'Public', 28),
		  (2108104, 2108901, 'Unsearchable', 1);
		INSERT INTO "UserHubSource" (id, "hubId", type, "targetId", enabled, exclude, "groupKey") VALUES
		  (2108205, 2108101, 'Tag', 2108702, true, false, 7),
		  (2108201, 2108101, 'User', 2108901, true, false, NULL),
		  (2108203, 2108101, 'ModelVersion', 2108601, true, true, NULL),
		  (2108202, 2108101, 'Model', 2108651, false, false, NULL),
		  (2108204, 2108101, 'Tag', 2108701, true, false, 7),
		  (2108206, 2108102, 'User', 2108902, true, false, NULL),
		  (2108207, 2108103, 'Model', 2108652, true, false, NULL),
		  (2108208, 2108104, 'Tag', 2108703, true, false, NULL);`)
}

func TestIntegrationHubVisibility(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedHubs(t, pool)
	g := &GalleryStore{DB: pool}
	const owner, stranger, moderator = 2108901, 2108902, 2108903
	seven := 7
	private := &HubRow{ForcedBrowsingLevel: 3, Sources: []HubSourceRow{
		{Type: "User", TargetID: 2108901},
		{Type: "ModelVersion", TargetID: 2108601, Exclude: true},
		{Type: "Tag", TargetID: 2108701, GroupKey: &seven},
		{Type: "Tag", TargetID: 2108702, GroupKey: &seven},
	}}
	public := &HubRow{ForcedBrowsingLevel: 0, Sources: []HubSourceRow{{Type: "User", TargetID: 2108902}}}
	strangers := &HubRow{ForcedBrowsingLevel: 28, Sources: []HubSourceRow{{Type: "Model", TargetID: 2108652}}}
	unsearchable := &HubRow{ForcedBrowsingLevel: 1, Sources: []HubSourceRow{{Type: "Tag", TargetID: 2108703}}}
	cases := []struct {
		name        string
		hub, viewer int
		mod         bool
		want        *HubRow
	}{
		{"private hub, its owner", 2108101, owner, false, private},
		{"private hub, a stranger", 2108101, stranger, false, nil},
		{"private hub, signed out", 2108101, 0, false, nil},
		{"private hub, a moderator", 2108101, moderator, true, private},
		{"public hub, its owner", 2108102, owner, false, public},
		{"public hub, a stranger", 2108102, stranger, false, public},
		{"public hub, signed out", 2108102, 0, false, public},
		{"public hub, a moderator", 2108102, moderator, true, public},
		{"another owner's public hub, the first owner", 2108103, owner, false, strangers},
		{"unsearchable hub, its owner", 2108104, owner, false, unsearchable},
		{"unsearchable hub, a stranger", 2108104, stranger, false, nil},
		{"unsearchable hub, signed out", 2108104, 0, false, nil},
		{"unsearchable hub, a moderator", 2108104, moderator, true, unsearchable},
		{"no such hub, a stranger", 2108199, stranger, false, nil},
		{"no such hub, signed out", 2108199, 0, false, nil},
		{"no such hub, a moderator", 2108199, moderator, true, nil},
	}
	for _, c := range cases {
		got, err := g.Hub(integtest.Ctx(t), c.hub, c.viewer, c.mod)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: Hub(%d, viewer %d, moderator %v) = %s, want %s", c.name, c.hub, c.viewer, c.mod, hubString(got), hubString(c.want))
		}
	}
}

// hubString prints a HubRow with its sources' group keys dereferenced.
func hubString(h *HubRow) string {
	if h == nil {
		return "nil"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "{level %d:", h.ForcedBrowsingLevel)
	for _, src := range h.Sources {
		fmt.Fprintf(&b, " %s:%d", src.Type, src.TargetID)
		if src.Exclude {
			b.WriteString("(exclude)")
		}
		if src.GroupKey != nil {
			fmt.Fprintf(&b, "(group %d)", *src.GroupKey)
		}
	}
	b.WriteString("}")
	return b.String()
}
