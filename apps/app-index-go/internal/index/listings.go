package index

import (
	"context"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/app-index-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// ListingSchema is the store listing schema of the civitai registry adapter
// (src/server/registry-adapter/urn.ts STORE_LISTING_SCHEMA).
const ListingSchema = "urn:schema:apps.civitai.com:store-listing@v1"

// ListingsConsumer is the second consumer, of store-listing@v1 into the listings read model
// (LISTINGS-READ-MODEL.md, slice 2), or nil when on is false (APP_INDEX_LISTINGS unset or off).
//
// Off, nothing of it exists: newStore is never called, so its tables are neither created nor
// written, no app_index_listings_* series is registered on reg, and no subscription is opened. On,
// it follows the stream with the app consumer's subscriber, token source, log and backoff (base),
// over its own store, generations, cursor and lock, with the empty-snapshot hold.
func ListingsConsumer(ctx context.Context, on bool, base Consumer, reg prometheus.Registerer,
	newStore func(ctx context.Context) (store.Listings, error)) (*Consumer, error) {
	if !on {
		return nil, nil
	}
	st, err := newStore(ctx)
	if err != nil {
		return nil, err
	}
	c := base
	c.Store = st
	c.Schema = ListingSchema
	c.Layout = ListingsLayoutVersion
	c.Metrics = metrics.NewListings(reg)
	c.Decode = store.DecodeListing
	c.Count = st.Count
	c.KeepInvalidWhileServing = true
	if c.Log != nil {
		c.Log = c.Log.With("stream", "listings")
	}
	return &c, nil
}
