package hydrate

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// collectionDB answers the permission read from rows (collection id -> [read, owner]) and perms
// (collection id -> viewer -> permissions), recording each query's SQL and args.
func collectionDB(rows map[int][2]any, perms map[int]map[int][]string, sqls *[]string, asked *[][]any) *testkit.DB {
	return &testkit.DB{Routes: []testkit.Route{{Match: `FROM "Collection" c`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
		*sqls = append(*sqls, sql)
		*asked = append(*asked, args)
		out := testkit.NewRows([]string{"read", "userId", "permissions"})
		r, ok := rows[args[0].(int)]
		if !ok {
			return out, nil
		}
		p := []string{}
		if len(args) > 1 && perms[args[0].(int)][args[1].(int)] != nil {
			p = perms[args[0].(int)][args[1].(int)]
		}
		out.Data = append(out.Data, []any{r[0], r[1], p})
		return out, nil
	}}}}
}

// Signed out, the read is the Collection row alone (no contributor join, one bound id); signed in, it
// joins the viewer's CollectionContributor row and binds the viewer second. The row's read setting,
// owner and the viewer's permissions come back as read; a collection without a row is nil.
func TestCollectionPermission(t *testing.T) {
	rows := map[int][2]any{9101: {"Public", 1001}, 9102: {"Private", 1001}}
	perms := map[int]map[int][]string{9102: {1002: {"VIEW", "ADD"}}}
	for _, c := range []struct {
		name       string
		collection int
		viewer     int
		want       *CollectionPermission
		joins      bool
		args       []any
	}{
		{"public signed out", 9101, 0, &CollectionPermission{Read: "Public", OwnerID: 1001, Contributor: []string{}, CollectionID: 9101}, false, []any{9101}},
		{"private, a contributor", 9102, 1002, &CollectionPermission{Read: "Private", OwnerID: 1001, Contributor: []string{"VIEW", "ADD"}, CollectionID: 9102}, true, []any{9102, 1002}},
		{"private, no contributor row", 9102, 1003, &CollectionPermission{Read: "Private", OwnerID: 1001, Contributor: []string{}, CollectionID: 9102}, true, []any{9102, 1003}},
		{"missing", 88, 1003, nil, true, []any{88, 1003}},
	} {
		var sqls []string
		var asked [][]any
		s := &Sources{Replica: collectionDB(rows, perms, &sqls, &asked)}
		got, err := s.CollectionPermission(context.Background(), c.collection, c.viewer)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Fatalf("%s: %+v, want %+v", c.name, got, c.want)
		}
		if len(sqls) != 1 || strings.Contains(sqls[0], `LEFT JOIN "CollectionContributor" cc ON cc."collectionId" = c.id AND cc."userId" = $2`) != c.joins {
			t.Fatalf("%s: queries %v, want one that joins the contributor row: %v", c.name, sqls, c.joins)
		}
		if !reflect.DeepEqual(asked[0], c.args) {
			t.Fatalf("%s: args %v, want %v", c.name, asked[0], c.args)
		}
	}

	boom := errors.New("replica down")
	s := &Sources{Replica: &testkit.DB{Routes: []testkit.Route{{Match: `FROM "Collection" c`, Rows: func([]any) (*testkit.Rows, error) {
		return nil, boom
	}}}}}
	if _, err := s.CollectionPermission(context.Background(), 9101, 0); !errors.Is(err, boom) {
		t.Fatalf("a failed read: %v, want it wrapped", err)
	}
}
