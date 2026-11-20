package hydrate

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// followsFixture holds userFollowsCache for three users: 2001 follows 3005, 3001 and 3009 (in that
// cached order), 2002 has a notFound marker (no Follow row), 2003 a record without `follows`.
func followsFixture(tb testing.TB) *pageFixture {
	tb.Helper()
	f := &pageFixture{strings: map[string][]byte{}, hashes: map[string]map[string]string{}}
	f.put(tb, KeyUserFollows, 2001, map[string]any{"userId": 2001, "follows": []any{3005, 3001, 3009}, "cachedAt": pageNow})
	f.put(tb, KeyUserFollows, 2002, map[string]any{"userId": 2002, "notFound": true, "cachedAt": pageNow})
	f.put(tb, KeyUserFollows, 2003, map[string]any{"userId": 2003, "cachedAt": pageNow})
	return f
}

// followsRoute answers sqlUserFollows from rows (per user, in the order given), recording the ids each
// query asked for; fail answers every query with errMissDB.
func followsRoute(rows map[int][][]any, asked *[][]int, fail bool) testkit.Route {
	return testkit.Route{Match: `FROM "UserEngagement" WHERE "userId" = ANY($1::int[]) AND "type" = 'Follow'`, Rows: func(args []any) (*testkit.Rows, error) {
		ids, _ := args[0].([]int)
		*asked = append(*asked, slices.Clone(ids))
		if fail {
			return nil, errMissDB
		}
		out := testkit.NewRows([]string{"userId", "targetUserId"})
		for _, id := range ids {
			out.Data = append(out.Data, rows[id]...)
		}
		return out, nil
	}}
}

// A hit is the cached list in its order; a notFound marker and a record without `follows` are no
// follows (`userFollows[userId]?.follows ?? []`), as a list (never nil, so a caller can tell "read,
// empty" from "not read"). No query is sent for any of them.
func TestUserFollowsHits(t *testing.T) {
	for id, want := range map[int][]int{2001: {3005, 3001, 3009}, 2002: {}, 2003: {}} {
		s, _, db := followsFixture(t).load()
		var asked [][]int
		db.Routes = append([]testkit.Route{followsRoute(nil, &asked, false)}, db.Routes...)
		s.Compute = &MissCompute{}
		got, err := s.UserFollows(context.Background(), id)
		if err != nil {
			t.Fatalf("user %d: %v", id, err)
		}
		if got == nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("user %d: follows %#v, want %#v", id, got, want)
		}
		if len(asked) != 0 {
			t.Fatalf("user %d: a hit queried the replica %v", id, asked)
		}
	}
}

// Without the miss computation a miss (no key, a debounce marker, an undecodable value) falls back;
// an entry Node would not read as this user's list of integers falls back whatever the computation.
func TestUserFollowsFallbacks(t *testing.T) {
	for name, c := range map[string]struct {
		change  func(testing.TB, *pageFixture)
		compute bool
		reason  string
	}{
		"absent":      {func(_ testing.TB, f *pageFixture) { f.del(KeyUserFollows, 2001) }, false, "user-follows-miss"},
		"debounced":   {func(tb testing.TB, f *pageFixture) { f.put(tb, KeyUserFollows, 2001, map[string]any{"debounce": true}) }, false, "user-follows-miss"},
		"undecodable": {func(_ testing.TB, f *pageFixture) { f.strings[pageNS+KeyUserFollows+":2001"] = []byte{0xc1} }, false, "user-follows-miss"},
		"another user's": {func(tb testing.TB, f *pageFixture) {
			f.put(tb, KeyUserFollows, 2001, map[string]any{"userId": 2009, "follows": []any{1}})
		}, true, "user-follows-shape"},
		"follows a string": {func(tb testing.TB, f *pageFixture) {
			f.put(tb, KeyUserFollows, 2001, map[string]any{"userId": 2001, "follows": "3005"})
		}, true, "user-follows-shape"},
		"a string id": {func(tb testing.TB, f *pageFixture) {
			f.put(tb, KeyUserFollows, 2001, map[string]any{"userId": 2001, "follows": []any{3005, "3001"}})
		}, true, "user-follows-shape"},
		"a fractional id": {func(tb testing.TB, f *pageFixture) {
			f.put(tb, KeyUserFollows, 2001, map[string]any{"userId": 2001, "follows": []any{3005.5}})
		}, true, "user-follows-shape"},
	} {
		t.Run(name, func(t *testing.T) {
			f := followsFixture(t)
			c.change(t, f)
			s, _, _ := f.load()
			if c.compute {
				s.Compute = &MissCompute{}
			}
			_, err := s.UserFollows(context.Background(), 2001)
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("err %v (reason %q), want %q", err, got, c.reason)
			}
		})
	}
}

// A miss with the computation is userFollowsCache's lookupFn on the replica: the target ids in row
// order; a user with no Follow row has no follows (the lookup's notFound). Never written back, even
// with every write-back cache listed, and never kept in process: a second miss queries again.
func TestUserFollowsComputesMiss(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		f := followsFixture(t)
		f.del(KeyUserFollows, 2001)
		f.del(KeyUserFollows, 2002)
		rows := map[int][][]any{2001: {{int32(2001), int32(3007)}, {int32(2001), int32(3002)}}}
		var asked [][]int
		obs := &observed{}
		s, r, db := f.load()
		db.Routes = append([]testkit.Route{followsRoute(rows, &asked, false)}, db.Routes...)
		s.Compute = &MissCompute{WriteBack: writeSet(writeBack), Observe: obs.observe}
		for _, c := range []struct {
			id   int
			want []int
		}{{2001, []int{3007, 3002}}, {2002, []int{}}, {2001, []int{3007, 3002}}} {
			got, err := s.UserFollows(context.Background(), c.id)
			if err != nil {
				t.Fatalf("write-back %v: user %d: %v (fallback %q)", writeBack, c.id, err, fallback.Reason(err))
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("write-back %v: user %d follows %#v, want %#v", writeBack, c.id, got, c.want)
			}
		}
		if !reflect.DeepEqual(asked, [][]int{{2001}, {2002}, {2001}}) {
			t.Fatalf("write-back %v: follow queries %v, want one per miss (none kept)", writeBack, asked)
		}
		if o := obs.get(); o["user-follows/computed"] != 3 {
			t.Fatalf("write-back %v: observed %v, want 3 computed user-follows ids", writeBack, o)
		}
		wantAbsent(t, r, pageNS+missKey(KeyUserFollows, 2001), pageNS+missKey(KeyUserFollows, 2002))
	}
}

// A failed lookup is the miss's `-failed` fallback.
func TestUserFollowsLookupFailure(t *testing.T) {
	f := followsFixture(t)
	f.del(KeyUserFollows, 2001)
	var asked [][]int
	s, _, db := f.load()
	db.Routes = append([]testkit.Route{followsRoute(nil, &asked, true)}, db.Routes...)
	s.Compute = &MissCompute{}
	_, err := s.UserFollows(context.Background(), 2001)
	if got := fallback.Reason(err); got != "user-follows-miss-failed" {
		t.Fatalf("err %v (reason %q), want user-follows-miss-failed", err, got)
	}
	if !reflect.DeepEqual(asked, [][]int{{2001}}) {
		t.Fatalf("follow queries %v, want one for 2001", asked)
	}
}
