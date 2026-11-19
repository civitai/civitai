//go:build integration

// Package pgtest gives integration tests a Postgres pool on a schema of their own.
package pgtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Pool is a pool on a fresh schema of APP_INDEX_TEST_PG_URL, dropped when the test ends. Without
// the variable the test is skipped, except in CI (CI set), where it fails: the integration tier
// must not pass by running nothing.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("APP_INDEX_TEST_PG_URL")
	if url == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("APP_INDEX_TEST_PG_URL is not set in CI")
		}
		t.Skip("APP_INDEX_TEST_PG_URL not set")
	}
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	schema := "t_" + hex.EncodeToString(b[:])
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+schema+` CASCADE`)
		admin.Close()
	})
	return pool
}
