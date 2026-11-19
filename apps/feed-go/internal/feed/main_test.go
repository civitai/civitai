package feed

import (
	"testing"

	"go.uber.org/goleak"
)

// Every test in the package must leave no goroutine behind: a request's fan-out (the hydration and
// completion errgroups) has to end with the request.
func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m)
}
