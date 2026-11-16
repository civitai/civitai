package feed

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// blockingDB blocks every query until its context ends, then returns the context's error, as pgx does
// for a cancelled query.
type blockingDB struct{ calls int }

func (b *blockingDB) Query(ctx context.Context, _ string, _ ...any) (pgx.Rows, error) {
	b.calls++
	<-ctx.Done()
	return nil, ctx.Err()
}

// failingDB fails at once with a non-timeout error.
type failingDB struct{}

func (failingDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("connection refused")
}

func shortStatementTimeout(t *testing.T) {
	t.Helper()
	prev := statementTimeout
	statementTimeout = 20 * time.Millisecond
	t.Cleanup(func() { statementTimeout = prev })
}

func TestFetchRowsStatementTimeoutIsAnEmptyPage(t *testing.T) {
	shortStatementTimeout(t)
	db := &blockingDB{}
	rows, err := FetchRows(context.Background(), db, nil, Built{SQL: "select 1"})
	if err != nil {
		t.Fatalf("a statement timeout must answer an empty page, as Node does; got error %v", err)
	}
	if rows == nil || len(rows) != 0 || db.calls != 1 {
		t.Fatalf("rows=%v (nil=%v) calls=%d, want an empty non-nil page from one query", rows, rows == nil, db.calls)
	}
}

func TestFetchRowsCallerCancellationIsAnError(t *testing.T) {
	shortStatementTimeout(t)
	// The caller's own deadline expires first: that is not this query's statement timeout.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if _, err := FetchRows(ctx, &blockingDB{}, nil, Built{SQL: "select 1"}); err == nil {
		t.Fatal("an expired caller context must stay an error")
	}
	cctx, ccancel := context.WithCancel(context.Background())
	ccancel()
	if _, err := FetchRows(cctx, &blockingDB{}, nil, Built{SQL: "select 1"}); err == nil {
		t.Fatal("a cancelled caller context must stay an error")
	}
}

func TestFetchRowsOtherErrorsStayErrors(t *testing.T) {
	if _, err := FetchRows(context.Background(), failingDB{}, nil, Built{SQL: "select 1"}); err == nil {
		t.Fatal("a query error that is not a timeout must stay an error")
	}
}

// A read-only query cache (the Go-first probe's) reads an entry but never writes one; the same cache
// writable is the positive control that a miss is written at all.
func TestFetchRowsReadOnlyCacheNeverWrites(t *testing.T) {
	b := Built{SQL: "select 1", CacheTTL: time.Minute, CacheTags: []string{"images-model-7"}}
	for _, readOnly := range []bool{false, true} {
		r := testkit.NewRedis()
		db := &testkit.DB{Routes: []testkit.Route{{Match: "select 1", Rows: func([]any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"id"}), nil
		}}}}
		cache := &QueryCache{Redis: r, Enabled: true, ReadOnly: readOnly}
		if _, err := FetchRows(context.Background(), db, cache, b); err != nil {
			t.Fatal(err)
		}
		keys := r.AllKeys()
		if readOnly && len(keys) != 0 {
			t.Fatalf("read-only: wrote %v", keys)
		}
		if !readOnly && len(keys) != 2 {
			t.Fatalf("writable: wrote %v, want the entry and its tag set", keys)
		}
	}
	// A read-only cache still answers from an entry.
	r := testkit.NewRedis()
	cache := &QueryCache{Redis: r, Enabled: true, ReadOnly: true}
	r.SetString(cache.Key(b), []byte(`[{"id":9}]`))
	rows, err := FetchRows(context.Background(), failingDB{}, cache, b)
	if err != nil || len(rows) != 1 || rows[0].ID != 9 {
		t.Fatalf("rows %v, err %v; want the cached row without a query", rows, err)
	}
}
