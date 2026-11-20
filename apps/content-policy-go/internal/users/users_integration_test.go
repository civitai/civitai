//go:build integration

package users

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/civitai/civitai/apps/content-policy-go/internal/policy"
)

// TestIntegrationQuery runs Query against a real Postgres, on a "User" table with the columns the
// query reads (the types of schema.full.prisma's User model), so a quoting or column mistake fails
// here and not in production. CI sets CONTENT_POLICY_TEST_PG_URL; without it the test fails under CI
// and skips elsewhere.
func TestIntegrationQuery(t *testing.T) {
	url := os.Getenv("CONTENT_POLICY_TEST_PG_URL")
	if url == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("CONTENT_POLICY_TEST_PG_URL is unset in CI")
		}
		t.Skip("CONTENT_POLICY_TEST_PG_URL is unset")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for _, stmt := range []string{
		`DROP TABLE IF EXISTS "User"`,
		`CREATE TABLE "User" (
			id integer PRIMARY KEY,
			"showNsfw" boolean NOT NULL DEFAULT false,
			"browsingLevel" integer NOT NULL DEFAULT 1,
			"isModerator" boolean DEFAULT false,
			"deletedAt" timestamp(3),
			"bannedAt" timestamp(3)
		)`,
		`INSERT INTO "User" (id, "showNsfw", "browsingLevel", "isModerator", "deletedAt", "bannedAt") VALUES
			(1, true, 28, true, NULL, NULL),
			(2, false, 1, NULL, NULL, NULL),
			(3, true, 31, false, now(), NULL),
			(4, true, 31, false, NULL, now()),
			(5, true, -1, false, NULL, NULL)`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	src := Postgres{DB: pool}
	for _, c := range []struct {
		id    int64
		found bool
		want  policy.User
	}{
		{1, true, policy.User{ShowNsfw: true, BrowsingLevel: 28, IsModerator: true}},
		{2, true, policy.User{BrowsingLevel: 1}}, // a null isModerator reads false
		{3, false, policy.User{}},                // deleted
		{4, false, policy.User{}},                // banned
		{5, true, policy.User{ShowNsfw: true, BrowsingLevel: -1}},
		{6, false, policy.User{}}, // no such user
	} {
		u, found, err := src.Lookup(ctx, c.id)
		if err != nil || found != c.found || u != c.want {
			t.Errorf("user %d: %+v found=%v err=%v, want %+v found=%v", c.id, u, found, err, c.want, c.found)
		}
	}
}
