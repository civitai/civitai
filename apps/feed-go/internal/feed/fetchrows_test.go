package feed

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
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
