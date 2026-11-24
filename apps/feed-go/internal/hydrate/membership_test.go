package hydrate

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// sub is a subscription row with its own and its product's metadata as JSON text.
func sub(t *testing.T, userID int, metadata, product string) membershipSub {
	t.Helper()
	m, err := jspack.FromJSON(metadata)
	if err != nil {
		t.Fatal(err)
	}
	p, err := jspack.FromJSON(product)
	if err != nil {
		t.Fatal(err)
	}
	return membershipSub{userID: userID, metadata: m, productMetadata: p}
}

// queryValidCreatorMembership's reduce: the highest tier per user, a renewal-emailed subscription
// and a Buzz-bought product skipped, valid for any tier but free and founder; every id answered.
func TestValidMemberships(t *testing.T) {
	subs := []membershipSub{
		sub(t, 1, `{}`, `{"tier":"bronze"}`),
		sub(t, 1, `{}`, `{"tier":"free"}`),
		sub(t, 2, `{"renewalEmailSent":true}`, `{"tier":"gold"}`),
		sub(t, 2, `{}`, `{"tier":"founder"}`),
		sub(t, 3, `{}`, `{"tier":"gold","buzzPurchase":"true"}`),
		sub(t, 4, `{"renewalEmailSent":0}`, `{"tier":"silver","monthlyBuzz":"5000","rewardsMultiplier":1.5,"badgeType":"static","buzzType":"blue","extra":[1]}`),
		sub(t, 5, `"not an object"`, `{"tier":"gold","buzzPurchase":0}`),
		sub(t, 6, `{}`, `{"tier":"free"}`),
		sub(t, 6, `{}`, `{"tier":"silver"}`),
		sub(t, 6, `{}`, `{"tier":"bronze"}`),
	}
	got, err := validMemberships([]int{1, 2, 3, 4, 5, 6, 7}, subs, "")
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]bool{1: true, 2: false, 3: false, 4: true, 5: true, 6: true, 7: false}
	for id, w := range want {
		if got[id] != w {
			t.Errorf("user %d: %v, want %v", id, got[id], w)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("answered %v, want every id", got)
	}
}

// A metadata subscriptionProductMetadataSchema rejects (or that is read here less surely than Node
// reads it) is membership-shape; the schema's accepted spellings are read.
func TestParseProductMetadata(t *testing.T) {
	for _, ok := range []string{
		`{"tier":"gold"}`,
		`{"tier":"gold","vaultSizeKb":0,"queueLimit":"3","maxPrivateModels":2.5,"rewardsMultiplier":"2"}`,
		`{"tier":"gold","badge":"b","supportLevel":"x","animatedBadge":true,"includeWithTransaction":"No"}`,
		`{"tier":"founder","buzzPurchase":1,"unknown":{"a":null}}`,
	} {
		v, _ := jspack.FromJSON(ok)
		if _, err := parseProductMetadata(v); err != nil {
			t.Errorf("%s: %v, want accepted", ok, err)
		}
	}
	for _, bad := range []string{
		`null`, `[]`, `"gold"`, `{}`, `{"tier":"platinum"}`, `{"tier":5}`,
		`{"tier":"gold","vaultSizeKb":-1}`, `{"tier":"gold","monthlyBuzz":"5k"}`, `{"tier":"gold","monthlyBuzz":null}`,
		`{"tier":"gold","monthlyBuzz":""}`, `{"tier":"gold","rewardsMultiplier":0}`, `{"tier":"gold","badge":3}`,
		`{"tier":"gold","badgeType":"shiny"}`, `{"tier":"gold","buzzType":null}`, `{"tier":"gold","buzzPurchase":"maybe"}`,
		`{"tier":"gold","monthlyBuzz":"1e3"}`,
	} {
		v, err := jspack.FromJSON(bad)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := parseProductMetadata(v); fallback.Reason(err) != "membership-shape" {
			t.Errorf("%s: %v, want membership-shape", bad, err)
		}
	}
	if _, err := validMemberships([]int{1}, []membershipSub{sub(t, 1, `{}`, `{"monthlyBuzz":5}`)}, ""); fallback.Reason(err) != "membership-shape" {
		t.Fatalf("a product with no tier: %v, want membership-shape", err)
	}
}

// TIER_METADATA_KEY: another key reads the loose metadata's own value (absent: free); a key the
// schema declares, or a value that is not a string, is left to Node.
func TestValidMembershipsTierKey(t *testing.T) {
	subs := []membershipSub{
		sub(t, 1, `{}`, `{"tier":"free","plan":"gold"}`),
		sub(t, 2, `{}`, `{"tier":"gold"}`),
	}
	got, err := validMemberships([]int{1, 2}, subs, "plan")
	if err != nil {
		t.Fatal(err)
	}
	if !got[1] || got[2] {
		t.Fatalf("plan key: %v, want 1 valid (its plan) and 2 not (no plan: free)", got)
	}
	for _, c := range []struct{ key, product string }{{"badge", `{"tier":"gold","badge":"gold"}`}, {"plan", `{"tier":"gold","plan":3}`}, {"plan", `{"tier":"gold","plan":null}`}} {
		if _, err := validMemberships([]int{1}, []membershipSub{sub(t, 1, `{}`, c.product)}, c.key); fallback.Reason(err) != "membership-shape" {
			t.Errorf("key %s over %s: %v, want membership-shape", c.key, c.product, err)
		}
	}
}

// membershipSources is a Sources whose replica answers the membership origin with rows, counting the
// reads (failing them with fail).
func membershipSources(t *testing.T, rows [][]any, fail bool, writeBack bool) (*Sources, *testkit.Redis, *int) {
	t.Helper()
	r := testkit.NewRedis()
	reads := 0
	db := &testkit.DB{Routes: []testkit.Route{{Match: `FROM "CustomerSubscription" cs`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
		reads++
		if fail {
			return nil, errMissDB
		}
		if !strings.Contains(sql, `cs.status NOT IN ('canceled', 'incomplete_expired', 'past_due', 'unpaid')`) || !strings.Contains(sql, `JOIN "Product" p ON p.id = cs."productId"`) {
			t.Errorf("the origin query is not Node's: %s", sql)
		}
		out := testkit.NewRows([]string{"userId", "metadata", "productMetadata"})
		for _, row := range rows {
			for _, id := range args[0].([]int) {
				if row[0] == int64(id) {
					out.Data = append(out.Data, row)
				}
			}
		}
		return out, nil
	}}}}
	s := &Sources{
		Packed:  &PackedReader{Redis: r, Prefix: pageNS, Now: func() time.Time { return pageNow }},
		Cache:   r,
		Replica: db,
		Compute: &MissCompute{Now: func() time.Time { return pageNow }, WriteBack: writeSet(writeBack)},
	}
	return s, r, &reads
}

// Hits are the cached booleans; a miss (no key, a value that is not a packed boolean) is computed
// once with the origin and written back with a plain SET for 10 minutes only with write-back; without
// a miss computation it falls back, as CreatorMemberships does.
func TestCreatorMembershipsComputed(t *testing.T) {
	rows := [][]any{{int64(1002), `{}`, `{"tier":"gold"}`}}
	for _, writeBack := range []bool{false, true} {
		s, r, reads := membershipSources(t, rows, false, writeBack)
		r.SetString(pageNS+KeyMembershipValid+":1001", jspack.Pack(true))
		r.SetString(pageNS+KeyMembershipValid+":1003", jspack.Pack("junk"))
		got, err := s.CreatorMembershipsComputed(context.Background(), []int{1001, 1002, 1003, 1002})
		if err != nil {
			t.Fatalf("write-back %v: %v", writeBack, err)
		}
		if !got[1001] || !got[1002] || got[1003] || len(got) != 3 {
			t.Fatalf("write-back %v: %v, want 1001 (hit) and 1002 (gold) valid, 1003 not", writeBack, got)
		}
		if *reads != 1 {
			t.Fatalf("write-back %v: %d origin reads, want 1", writeBack, *reads)
		}
		for id, want := range map[string]bool{"1002": true, "1003": false} {
			key := pageNS + KeyMembershipValid + ":" + id
			b, ok := r.String(key)
			if !writeBack {
				if id == "1002" && ok {
					t.Fatalf("write-back off: %s written", key)
				}
				continue
			}
			v, err := Unpack(b)
			if !ok || err != nil || v != want || r.Expiry(key) != 10*time.Minute {
				t.Fatalf("write-back on: %s = %v (%v), expiry %v; want %v for 10 minutes (a SET, over the junk too)", key, v, err, r.Expiry(key), want)
			}
		}
	}
	s, _, _ := membershipSources(t, rows, false, false)
	s.Compute = nil
	if _, err := s.CreatorMembershipsComputed(context.Background(), []int{1002}); fallback.Reason(err) != "membership-miss" {
		t.Fatalf("no miss computation: %v, want membership-miss", err)
	}
}

// A failed origin read is membership-miss-failed; a metadata Node's parse rejects, membership-shape.
func TestCreatorMembershipsComputedFailures(t *testing.T) {
	s, _, _ := membershipSources(t, nil, true, false)
	if _, err := s.CreatorMembershipsComputed(context.Background(), []int{1002}); fallback.Reason(err) != "membership-miss-failed" {
		t.Fatalf("failed read: %v, want membership-miss-failed", err)
	}
	s, _, _ = membershipSources(t, [][]any{{int64(1002), `{}`, `{"monthlyBuzz":1}`}}, false, true)
	if _, err := s.CreatorMembershipsComputed(context.Background(), []int{1002}); fallback.Reason(err) != "membership-shape" {
		t.Fatalf("no tier: %v, want membership-shape", err)
	}
}
