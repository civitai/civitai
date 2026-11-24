package hydrate

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// userCosmeticsRoute answers userCosmeticCache's lookup: owner 1001 has badge 301 equipped.
func userCosmeticsRoute(reads *int) testkit.Route {
	return testkit.Route{Match: `FROM "UserCosmetic" WHERE "userId" = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
		*reads++
		out := testkit.NewRows([]string{"userId", "cosmeticId", "data"})
		for _, id := range args[0].([]int) {
			if id == 1001 {
				out.Data = append(out.Data, []any{int64(1001), int64(301), nil})
			}
		}
		return out, nil
	}}
}

// A model page's owner with no user-cosmetics entry: with ComputeUserCosmetics (and the miss
// computation) the entry is computed with the image pages' lookup, joined as a hit is, and written
// back only with WriteBack; without it, or without a miss computation, it is the
// `user-cosmetics-miss` fallback, as before.
func TestModelPageComputesUserCosmeticsMissWhenAsked(t *testing.T) {
	for _, c := range []struct {
		name               string
		compute, writeBack bool
		ask                bool
		reason             string
	}{
		{"not asked", true, false, false, "user-cosmetics-miss"},
		{"asked, no miss computation", false, false, true, "user-cosmetics-miss"},
		{"asked", true, false, true, ""},
		{"asked, written back", true, true, true, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := fullModelFixture(t)
			f.del(KeyUserCosmetics, 1001)
			s := f.sources()
			var r *testkit.Redis
			obs := &observed{}
			if c.compute {
				s, r = computedModelSources(f, &MissCompute{WriteBack: writeSet(c.writeBack), FrameNegative: true, Observe: obs.observe})
			}
			reads := 0
			db := s.Replica.(*testkit.DB)
			db.Routes = append([]testkit.Route{userCosmeticsRoute(&reads)}, db.Routes...)
			req := modelPageRequest()
			req.ComputeUserCosmetics = c.ask
			p, err := s.ModelPage(context.Background(), req)
			if c.reason != "" {
				if got := fallback.Reason(err); got != c.reason {
					t.Fatalf("%q (%v), want %q", got, err, c.reason)
				}
				if reads != 0 {
					t.Fatalf("the lookup ran %d time(s) for a fallback", reads)
				}
				return
			}
			if err != nil {
				t.Fatalf("ModelPage: %v (%q)", err, fallback.Reason(err))
			}
			if reads != 1 {
				t.Fatalf("the lookup ran %d time(s), want once for the page", reads)
			}
			list := p.UserCosmetics[1001]
			if len(list) != 1 {
				t.Fatalf("user cosmetics %v, want the one equipped badge", p.UserCosmetics)
			}
			if o := obs.get(); o["user-cosmetics/computed"] != 1 {
				t.Fatalf("observed %v, want 1 computed user-cosmetics id", o)
			}
			key := pageNS + KeyUserCosmetics + ":" + strconv.Itoa(1001)
			if !c.writeBack {
				wantAbsent(t, r, key)
				return
			}
			if !r.Has(key) || r.Expiry(key) != 24*time.Hour {
				t.Fatalf("%s: written %v, expiry %v; want written for a day", key, r.Has(key), r.Expiry(key))
			}
		})
	}
}
