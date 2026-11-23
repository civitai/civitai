// Package urn builds the one registry URN this service subscribes by: a collection's schema,
// `urn:schema:apps.civitai.com:<slug>/<collection>@v<major>`.
//
// The TypeScript twin is `registryUrn({ kind: 'collection-schema', … })` in
// src/server/registry-adapter/urn.ts, the function the registry adapter names its private streams
// with. The two must agree on every input, so testdata/golden/vectors.json is generated from the
// real TypeScript function (testdata/golden/gen.ts), a drift test in scripts/__tests__ fails when
// the committed file differs from what that function answers today, and urn_test.go checks this
// package against every vector.
package urn

import (
	"errors"
	"fmt"
	"regexp"
)

// Namespace is the registry adapter's namespace (urn.ts REGISTRY_NAMESPACE).
const Namespace = "apps.civitai.com"

// The segment shapes of urn.ts (SLUG_RE, COLLECTION_RE). A slug is an app's blockId.
var (
	slugRE       = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)
	collectionRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
)

// ErrInvalid is returned for a slug, collection or major the adapter would refuse to name.
var ErrInvalid = errors.New("invalid collection schema reference")

// MaxMajor bounds a schema major: urn.ts parses at most nine digits back (`[1-9][0-9]{0,8}`).
const MaxMajor = 999_999_999

// CollectionSchema is the schema URN of one major of one app's collection.
func CollectionSchema(slug, collection string, major int) (string, error) {
	if !slugRE.MatchString(slug) {
		return "", fmt.Errorf("%w: slug", ErrInvalid)
	}
	if !collectionRE.MatchString(collection) {
		return "", fmt.Errorf("%w: collection", ErrInvalid)
	}
	if major < 1 || major > MaxMajor {
		return "", fmt.Errorf("%w: major", ErrInvalid)
	}
	return fmt.Sprintf("urn:schema:%s:%s/%s@v%d", Namespace, slug, collection, major), nil
}

// ValidSlug reports whether slug is an app slug the adapter would name (urn.ts SLUG_RE).
func ValidSlug(slug string) bool { return slugRE.MatchString(slug) }

// ValidCollection reports whether collection is a collection name the adapter would name
// (urn.ts COLLECTION_RE).
func ValidCollection(collection string) bool { return collectionRE.MatchString(collection) }
