package chwrite

import (
	"testing"

	"go.uber.org/goleak"
)

// Every test must leave no goroutine behind: a Writer's background goroutine has to end with Close,
// and the connections of the client it owns with it.
func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m)
}
