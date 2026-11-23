package api

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/app-index-go/internal/listingread"
	"github.com/civitai/civitai/apps/app-index-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// blockingListings blocks the one read named by block until its context ends, as a stuck
// database read does, and answers that read with the context's error.
type blockingListings struct {
	*store.ListingsMemory
	block string
}

func (b blockingListings) wait(ctx context.Context, what string) error {
	if b.block != what {
		return nil
	}
	<-ctx.Done()
	return ctx.Err()
}

func (b blockingListings) State(ctx context.Context) (store.State, error) {
	if err := b.wait(ctx, "state"); err != nil {
		return store.State{}, err
	}
	return b.ListingsMemory.State(ctx)
}

func (b blockingListings) Keys(ctx context.Context, gen int64) ([]store.Listing, error) {
	if err := b.wait(ctx, "keys"); err != nil {
		return nil, err
	}
	return b.ListingsMemory.Keys(ctx, gen)
}

func (b blockingListings) GetMany(ctx context.Context, gen int64, urns []string) ([]store.Listing, error) {
	if err := b.wait(ctx, "many"); err != nil {
		return nil, err
	}
	return b.ListingsMemory.GetMany(ctx, gen, urns)
}

func (b blockingListings) BySlug(ctx context.Context, gen int64, slug string) (store.Listing, bool, error) {
	if err := b.wait(ctx, "slug"); err != nil {
		return store.Listing{}, false, err
	}
	return b.ListingsMemory.BySlug(ctx, gen, slug)
}

// SearchTimeout bounds every store read a listing request makes: a read that never returns is
// answered 500 at about the timeout, never held for as long as the store holds it. The client gives
// up after 5 s, so a read the timeout does not reach fails the test rather than hanging it.
func TestListingSearchTimeoutBoundsReads(t *testing.T) {
	const timeout = 100 * time.Millisecond
	ls := readyListings(t, paintBody)
	client := &http.Client{Timeout: 5 * time.Second}
	token := listingread.SignViewer(viewerKey, sfwViewer, testNow.Add(time.Minute))
	for _, c := range []struct{ block, path string }{
		{"state", "/listings"},
		{"keys", "/listings"},
		{"many", "/listings"},
		{"state", "/listings/paint"},
		{"slug", "/listings/paint"},
	} {
		reg := prometheus.NewRegistry()
		s := &Server{Store: readyStore(t), Metrics: metrics.New(reg), Gatherer: reg, Log: slog.New(slog.DiscardHandler),
			Listings: blockingListings{ls, c.block}, ViewerKey: viewerKey, Now: func() time.Time { return testNow },
			SearchTimeout: timeout}
		srv := httptest.NewServer(s.Handler())
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+c.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(listingread.ViewerHeader, token)
		start := time.Now()
		res, err := client.Do(req)
		took := time.Since(start)
		if err != nil {
			t.Errorf("%s blocked on %s: %v after %v, want a 500 at about %v", c.path, c.block, err, took, timeout)
			srv.Close()
			continue
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusInternalServerError || took > 2*time.Second {
			t.Errorf("%s blocked on %s: %d after %v, want 500 at about %v", c.path, c.block, res.StatusCode, took, timeout)
		}
		srv.Close()
	}
}
