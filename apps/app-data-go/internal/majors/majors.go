// Package majors is the book of each collection's current schema major, as far as this process has
// seen: the highest major among the collection schema URNs (`urn:schema:apps.civitai.com:<slug>/<c>@v<N>`)
// its streams' records claim. A write naming another major is refused `409 stale_major`
// (WRITES-DESIGN.md, "The API"). The book only learns from what the adapter sends, never from what a
// client asks to subscribe to (a client can name a major that does not exist).
package majors

import (
	"sync"

	"github.com/civitai/civitai/apps/app-data-go/internal/urn"
)

type collection struct{ slug, name string }

// Book is safe for concurrent use. The zero value is an empty book.
type Book struct {
	mu sync.RWMutex
	m  map[collection]int
}

// Observe records the majors of schemas, an entity's `schemas` as the adapter sent them. Anything
// that is not a collection schema URN (a per-viewer schema, another namespace) is ignored. A major
// only ever rises.
func (b *Book) Observe(schemas []string) {
	for _, s := range schemas {
		slug, name, major, err := urn.ParseCollectionSchema(s)
		if err != nil {
			continue
		}
		k := collection{slug, name}
		b.mu.RLock()
		known := b.m[k]
		b.mu.RUnlock()
		if known >= major {
			continue
		}
		b.mu.Lock()
		if b.m == nil {
			b.m = map[collection]int{}
		}
		if b.m[k] < major {
			b.m[k] = major
		}
		b.mu.Unlock()
	}
}

// Current is the highest major seen for the app slug's collection, and whether any was seen.
func (b *Book) Current(slug, name string) (int, bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	major, ok := b.m[collection{slug, name}]
	return major, ok
}
