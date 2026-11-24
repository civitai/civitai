//go:build integration

package integtest

import "github.com/civitai/civitai/apps/feed-go/internal/jspack"

// The integration tier writes cache values with the service's own msgpackr-exact encoder
// (internal/jspack, whose goldens msgpackr itself wrote); these names keep the tests' spelling.

// Obj is a JS object: its keys in insertion order, as msgpackr walks them.
type Obj = jspack.Obj

// KV is one object member.
type KV = jspack.KV

// Undefined is the JS `undefined` value.
type Undefined = jspack.Undefined

// O builds an Obj from alternating keys and values: O("id", 1, "name", "x").
func O(kv ...any) Obj { return jspack.O(kv...) }

// Pack encodes v as msgpackr's module-level `pack` does (see jspack.Pack).
func Pack(v any) []byte { return jspack.Pack(v) }
