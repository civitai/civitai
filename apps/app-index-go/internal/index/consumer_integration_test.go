//go:build integration

package index

import (
	"context"
	"testing"

	"github.com/civitai/civitai/apps/app-index-go/internal/pgtest"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

func TestIntegrationScenariosPostgres(t *testing.T) {
	runScenarios(t, func(t *testing.T) store.Store {
		s, err := store.NewPostgres(context.Background(), pgtest.Pool(t))
		if err != nil {
			t.Fatal(err)
		}
		return s
	})
}

func TestIntegrationListingScenariosPostgres(t *testing.T) {
	runListingScenarios(t, func(t *testing.T) store.Listings {
		s, err := store.NewListingsPostgres(context.Background(), pgtest.Pool(t))
		if err != nil {
			t.Fatal(err)
		}
		return s
	})
}
