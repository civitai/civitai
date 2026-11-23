package modelfeed

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

func parseAssoc(t *testing.T, input string) (*AssocInput, error) {
	t.Helper()
	m, err := trpc.DecodeEnvelope([]byte(input))
	if err != nil {
		t.Fatal(err)
	}
	return ParseAssociated(m)
}

func TestParseAssociated(t *testing.T) {
	in, err := parseAssoc(t, `{"json":{"fromId":42,"type":"Suggested","browsingLevel":3,"authed":true}}`)
	if err != nil {
		t.Fatal(err)
	}
	if in.FromID != 42 || in.Type != AssociationSuggested || in.BrowsingLevel == nil || *in.BrowsingLevel != 3 {
		t.Fatalf("parsed %+v", in)
	}
	in, err = parseAssoc(t, `{"json":{"fromId":7,"type":"Suggested"}}`)
	if err != nil || in.BrowsingLevel != nil {
		t.Fatalf("absent level: %+v %v", in, err)
	}
	for _, c := range []struct {
		input, reason string
	}{
		{`{"json":{"fromId":1,"type":"Suggested","excludedUserIds":[1]}}`, "input-unknown-key"},
		{`{"json":{"type":"Suggested"}}`, "input-invalid"},
		{`{"json":{"fromId":null,"type":"Suggested"}}`, "input-invalid"},
		{`{"json":{"fromId":1.5,"type":"Suggested"}}`, "input-invalid"},
		{`{"json":{"fromId":"1","type":"Suggested"}}`, "input-invalid"},
		{`{"json":{"fromId":3000000000,"type":"Suggested"}}`, "input-invalid"},
		{`{"json":{"fromId":1,"type":"Other"}}`, "input-invalid"},
		{`{"json":{"fromId":1}}`, "input-invalid"},
		{`{"json":{"fromId":1,"type":"Suggested","browsingLevel":null}}`, "input-invalid"},
		{`{"json":{"fromId":1,"type":"Suggested","browsingLevel":"3"}}`, "input-invalid"},
		{`{"json":{"fromId":1,"type":"Suggested","browsingLevel":-1}}`, "input-invalid"},
		{`{"json":{"fromId":1,"type":"Suggested","browsingLevel":1.5}}`, "input-invalid"},
	} {
		_, err := parseAssoc(t, c.input)
		if got := reasonOf(err); got != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.input, got, err, c.reason)
		}
	}
}

func reasonOf(err error) string { return fallback.Reason(err) }

func TestParseGateRules(t *testing.T) {
	rules, err := ParseGateRules(map[string]string{
		"a": `{"id":"a","availableTo":"moderators","presentation":"hidden","modelVersionIds":[5,6],"extra":1}`,
		"b": `{"id":"b","name":"x","availableTo":"nobody","presentation":"disabled","ecosystems":["SDXL"],"workflows":["w"],"message":null}`,
		// Refused by gateRuleSchema, each for one field: dropped.
		"c1": `{"availableTo":"nobody","presentation":"hidden","modelVersionIds":[1]}`,
		"c2": `{"id":"c2","availableTo":"everyone","presentation":"hidden"}`,
		"c3": `{"id":"c3","availableTo":"nobody","presentation":"gone"}`,
		"c4": `{"id":"c4","availableTo":"nobody","presentation":"hidden","modelVersionIds":[0]}`,
		"c5": `{"id":"c5","availableTo":"nobody","presentation":"hidden","modelVersionIds":[1.5]}`,
		"c6": `{"id":"c6","availableTo":"nobody","presentation":"hidden","ecosystems":null}`,
		"c7": `{"id":"c7","name":null,"availableTo":"nobody","presentation":"hidden"}`,
		"c8": `{"id":"c8","availableTo":"nobody","presentation":"hidden","message":7}`,
		"c9": `{"id":"12n","availableTo":"nobody","presentation":"hidden"}`,
		"d1": `not json`,
		"d2": `[1]`,
		"d3": `{"id":"d3","availableTo":"nobody","presentation":"hidden","workflows":[1]}`,
		"d4": `{"id":"d4","availableTo":"nobody","presentation":"hidden","modelVersionIds":["5"]}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []GateRule{
		{AvailableTo: "moderators", Presentation: "hidden", ModelVersionIDs: []int{5, 6}},
		{AvailableTo: "nobody", Presentation: "disabled", Ecosystems: []string{"SDXL"}},
	}
	if !reflect.DeepEqual(rules, want) {
		t.Fatalf("rules %+v, want %+v", rules, want)
	}
}

func TestHiddenGateVersions(t *testing.T) {
	cand := map[int]bool{5: true, 9: true}
	mod := &Viewer{ID: 1, IsModerator: true}
	user := &Viewer{ID: 2}
	for _, c := range []struct {
		name   string
		rule   GateRule
		viewer *Viewer
		want   map[int]bool
		reason string
	}{
		{"moderators, user", GateRule{AvailableTo: "moderators", Presentation: "hidden", ModelVersionIDs: []int{5}}, user, map[int]bool{5: true}, ""},
		{"moderators, mod", GateRule{AvailableTo: "moderators", Presentation: "hidden", ModelVersionIDs: []int{5}}, mod, map[int]bool{}, ""},
		{"members never", GateRule{AvailableTo: "members", Presentation: "hidden", ModelVersionIDs: []int{5}}, nil, map[int]bool{}, ""},
		{"nobody, mod", GateRule{AvailableTo: "nobody", Presentation: "hidden", ModelVersionIDs: []int{5}}, mod, map[int]bool{5: true}, ""},
		{"testers, signed out", GateRule{AvailableTo: "testers", Presentation: "hidden", ModelVersionIDs: []int{9}}, nil, map[int]bool{9: true}, ""},
		{"testers, mod", GateRule{AvailableTo: "testers", Presentation: "hidden", ModelVersionIDs: []int{9}}, mod, map[int]bool{}, ""},
		{"testers, user, other version", GateRule{AvailableTo: "testers", Presentation: "hidden", ModelVersionIDs: []int{7}}, user, map[int]bool{}, ""},
		{"testers, user, candidate", GateRule{AvailableTo: "testers", Presentation: "hidden", ModelVersionIDs: []int{9}}, user, nil, "gate-rules-testers"},
		{"testers, user, ecosystem", GateRule{AvailableTo: "testers", Presentation: "hidden", Ecosystems: []string{"X"}}, user, nil, "gate-rules-testers"},
		{"ecosystem applies", GateRule{AvailableTo: "nobody", Presentation: "hidden", Ecosystems: []string{"X"}}, nil, nil, "gate-rules-ecosystem"},
		{"ecosystem, not applicable", GateRule{AvailableTo: "moderators", Presentation: "hidden", Ecosystems: []string{"X"}}, mod, map[int]bool{}, ""},
		{"experimental", GateRule{AvailableTo: "nobody", Presentation: "experimental", ModelVersionIDs: []int{5}, Ecosystems: []string{"X"}}, nil, map[int]bool{}, ""},
		{"unknown audience", GateRule{AvailableTo: "?", Presentation: "hidden", ModelVersionIDs: []int{5}}, nil, map[int]bool{}, ""},
	} {
		got, err := hiddenGateVersions([]GateRule{c.rule}, c.viewer, cand)
		if c.reason != "" {
			if reasonOf(err) != c.reason {
				t.Errorf("%s: %v, want %q", c.name, err, c.reason)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %v %v, want %v", c.name, got, err, c.want)
		}
	}
}

func TestSysGateRules(t *testing.T) {
	r := testkit.NewRedis()
	g := &SysGateRules{Sys: r}
	_, err := g.GateRules(context.Background())
	if reasonOf(err) != "gate-rules-unmigrated" {
		t.Fatalf("no marker: %v", err)
	}
	r.SetString(gateRulesMigratedKey, []byte("1"))
	rules, err := g.GateRules(context.Background())
	if err != nil || len(rules) != 0 {
		t.Fatalf("migrated, no rules: %v %v", rules, err)
	}
	r.SetHash(gateRulesKey, map[string]string{"a": `{"id":"a","availableTo":"nobody","presentation":"hidden","modelVersionIds":[3]}`})
	rules, err = g.GateRules(context.Background())
	if err != nil || len(rules) != 1 || rules[0].ModelVersionIDs[0] != 3 {
		t.Fatalf("one rule: %v %v", rules, err)
	}
	r.Err = errors.New("down")
	if _, err = g.GateRules(context.Background()); reasonOf(err) != "gate-rules-unreadable" {
		t.Fatalf("redis down: %v", err)
	}
	r.Err = nil
	r.KeyErr = func(key string) error {
		if key == gateRulesKey {
			return errors.New("shard down")
		}
		return nil
	}
	if _, err = g.GateRules(context.Background()); reasonOf(err) != "gate-rules-unreadable" {
		t.Fatalf("hash shard down: %v", err)
	}
	if _, err = (*SysGateRules)(nil).GateRules(context.Background()); reasonOf(err) != "gate-rules-unconfigured" {
		t.Fatalf("nil: %v", err)
	}
}

func packUsers(t *testing.T, ids ...int) string {
	t.Helper()
	rows := make([]map[string]any, len(ids))
	for i, id := range ids {
		rows[i] = map[string]any{"id": id, "username": "u"}
	}
	b, err := msgpack.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestPackedHiddenPrefs(t *testing.T) {
	r := testkit.NewRedis()
	p := &PackedHiddenPrefs{Redis: r, Prefix: "ns:"}
	key := "ns:packed:user:-1:hidden-prefs"
	ctx := context.Background()
	if _, ok, err := p.HiddenUserIDs(ctx, -1); ok || err != nil {
		t.Fatalf("no hash: ok=%v err=%v, want a miss", ok, err)
	}
	r.SetHash(key, map[string]string{"hidden-users-5": packUsers(t, 4), "blocked-by-users-2": packUsers(t), "blocked-users-2": packUsers(t, 5, 4)})
	ids, ok, err := p.HiddenUserIDs(ctx, -1)
	if err != nil || !ok || !reflect.DeepEqual(ids, []int{4, 5, 4}) {
		t.Fatalf("all cached: %v %v %v", ids, ok, err)
	}
	for field, val := range map[string]string{"blocked-users-2": "", "blocked-by-users-2": "\xc1", "hidden-users-5": packUsers(t)[:0] + "\x01"} {
		r.SetHash(key, map[string]string{"hidden-users-5": packUsers(t), "blocked-by-users-2": packUsers(t), "blocked-users-2": packUsers(t), field: val})
		if _, ok, err := p.HiddenUserIDs(ctx, -1); ok || err != nil {
			t.Errorf("%s = %q: ok=%v err=%v, want a miss", field, val, ok, err)
		}
	}
	// A list entry that is not a `{ id }` row is a miss too.
	bad, _ := msgpack.Marshal([]any{"x"})
	r.SetHash(key, map[string]string{"hidden-users-5": string(bad), "blocked-by-users-2": packUsers(t), "blocked-users-2": packUsers(t)})
	if _, ok, _ := p.HiddenUserIDs(ctx, -1); ok {
		t.Error("a non-row entry: want a miss")
	}
	noID, _ := msgpack.Marshal([]map[string]any{{"username": "x"}})
	r.SetHash(key, map[string]string{"hidden-users-5": string(noID), "blocked-by-users-2": packUsers(t), "blocked-users-2": packUsers(t)})
	if _, ok, _ := p.HiddenUserIDs(ctx, -1); ok {
		t.Error("a row with no id: want a miss")
	}
	r.Err = errors.New("down")
	if _, _, err := p.HiddenUserIDs(ctx, 7); err == nil || errors.Is(err, redis.Nil) {
		t.Fatalf("redis down: %v, want the error", err)
	}
}

func TestAssocImageQuerySQL(t *testing.T) {
	signedOut, args := assocImageQuery{VersionIDs: []int{1, 2}, Level: 1}.build()
	for _, want := range []string{
		`FROM unnest($1::int[]) AS full_mv(id)`, `p."publishedAt" IS NOT NULL`, `i."tosViolation" = FALSE`,
		`(i."blockedFor" IS NULL)`, `i."needsReview" IS NULL AND i."acceptableMinor" = FALSE`,
		`(i."nsfwLevel" & $2) != 0`, `"nsfwLevelLocked"`, `NOT ((COALESCE(i."minor", FALSE))`,
		`((i."nsfwLevel" & 60) = 0 OR NOT i."modelRestricted")`, `LIMIT 1`, `i.metadata::text AS metadata`,
		`(i."meta"->'extra'->'remixOfId')::text AS "remixOfId"`,
	} {
		if !strings.Contains(signedOut, want) {
			t.Errorf("signed out: missing %s", want)
		}
	}
	if strings.Contains(signedOut, "TagsOnImageDetails") || len(args) != 2 || args[1] != 1 {
		t.Errorf("signed out: args %v", args)
	}
	viewer, args := assocImageQuery{VersionIDs: []int{1}, ViewerID: 9, Level: 63, ExcludedTagIDs: []int{4}}.build()
	for _, want := range []string{
		`(i."nsfwLevel" != 0 AND NOT EXISTS (SELECT 1 FROM "TagsOnImageDetails" toi WHERE toi."imageId" = i.id AND toi."disabled" = FALSE AND toi."tagId" = ANY($2::int[]) ) OR i."userId" = $3)`,
		`(i."blockedFor" IS NULL OR i."userId" = $4)`, `(i."nsfwLevel" & $5) != 0`,
		`OR i."userId" = $6)`, `OR NOT i."modelRestricted" OR i."userId" = $7)`,
	} {
		if !strings.Contains(viewer, want) {
			t.Errorf("viewer: missing %s\n%s", want, viewer)
		}
	}
	// The level is held to the selectable levels: Blocked dropped.
	if args[4] != 31 {
		t.Errorf("level arg %v, want 31", args[4])
	}
	mod, args := assocImageQuery{VersionIDs: []int{1}, ViewerID: 9, IsModerator: true, Level: 32}.build()
	if strings.Contains(mod, `"blockedFor"`) || !strings.Contains(mod, "AND TRUE") {
		t.Errorf("moderator: %s", mod)
	}
	// Only Blocked: no selectable level is every level.
	if args[1] != 31 {
		t.Errorf("Blocked-only level arg %v, want 31", args[1])
	}
	// A non-positive id is no uploader.
	neg, _ := assocImageQuery{VersionIDs: []int{1}, ViewerID: -1, Level: 1}.build()
	if strings.Contains(neg, `"modelRestricted" OR`) {
		t.Errorf("viewer -1 got the uploader carve-out")
	}
}

func TestAssocImagesRead(t *testing.T) {
	db := &testkit.DB{Routes: []testkit.Route{{Match: `AS full_mv(id)`, Rows: func(_ []any) (*testkit.Rows, error) {
		return testkit.NewRows(assocImageColumns,
			assocImageRow(1, 2, 4, 10, map[string]any{"width": nil, "remixOfId": "77"}),
			assocImageRow(3, 2, 1, 11, nil)), nil
	}}}}
	got, err := assocImages(context.Background(), db, assocImageQuery{VersionIDs: []int{10, 11}, Level: 31})
	if err != nil {
		t.Fatal(err)
	}
	if len(got[10]) != 1 || len(got[11]) != 1 {
		t.Fatalf("by version: %v", got)
	}
	img := got[10][0]
	if img["id"] != int64(1) || img["nsfwLevel"] != int64(4) || img["width"] != nil || img["height"] != int64(768) {
		t.Fatalf("image %v", img)
	}
	if string(img["remixOfId"].(json.RawMessage)) != "77" {
		t.Fatalf("remixOfId %v", img["remixOfId"])
	}
	if out, _ := assocImages(context.Background(), db, assocImageQuery{}); len(out) != 0 || len(db.Calls) != 1 {
		t.Fatalf("no versions must read nothing: %v %d", out, len(db.Calls))
	}
	failing := &testkit.DB{}
	if _, err := assocImages(context.Background(), failing, assocImageQuery{VersionIDs: []int{1}}); err == nil {
		t.Fatal("a failed query must be returned")
	}
}
