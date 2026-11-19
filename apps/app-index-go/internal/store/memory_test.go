package store

import (
	"testing"
	"time"
)

func (m *Memory) setFailBeforeCommit(f func(op string) error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.failBeforeCommit = f
}

func (m *Memory) setNow(f func() time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.now = f
}

func TestMemoryContract(t *testing.T) {
	runContract(t, func(*testing.T) testStore { return NewMemory() })
}
