// The Go half of the Node <-> Go Flipt parity check (../README.md). Its own module so that no
// service takes go.flipt.io/flipt-client as a dependency before one adopts it; it moves into the
// shared Go module when that exists.
module github.com/civitai/civitai/packages/civitai-flipt/parity/go

go 1.26.0

require go.flipt.io/flipt-client v1.1.1

require (
	github.com/tetratelabs/wazero v1.9.0 // indirect
	golang.org/x/net v0.43.0 // indirect
	golang.org/x/text v0.28.0 // indirect
)
