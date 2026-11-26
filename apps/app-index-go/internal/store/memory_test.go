package store

import "testing"

func (m *Memory) setFailBeforeCommit(f func(op string) error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.failBeforeCommit = f
}

func TestMemoryContract(t *testing.T) {
	runContract(t, func(*testing.T) testStore { return NewMemory() })
}
