package server

import (
	"testing"

	"go.uber.org/goleak"
)

// Every test in the package must leave no goroutine behind: a shadow sample's goroutine has to end
// with the sample, and Close has to end them all.
func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m)
}
