package cache

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"time"
)

// memStore is an in-memory Store with valkey's semantics for the commands Cache uses, and fault
// injection: fail answers every call with an error (connection refused), hang blocks every call until
// its context ends (a valkey that stopped answering).
type memStore struct {
	mu    sync.Mutex
	now   func() time.Time
	vals  map[string][]byte
	until map[string]time.Time
	ttls  map[string]time.Duration // the last ttl each key was written with
	calls int
	fail  bool
	hang  bool
	// afterGet, when set, runs after every Get, without the lock (a test's barrier).
	afterGet func()
}

var errRefused = errors.New("connect: connection refused")

func newMemStore() *memStore {
	return &memStore{now: time.Now, vals: map[string][]byte{}, until: map[string]time.Time{}, ttls: map[string]time.Duration{}}
}

// enter counts a call and applies the faults; m.mu is held on a nil answer.
func (m *memStore) enter(ctx context.Context) error {
	m.mu.Lock()
	m.calls++
	fail, hang := m.fail, m.hang
	if fail {
		m.mu.Unlock()
		return errRefused
	}
	if hang {
		m.mu.Unlock()
		// Bounded, so a caller that never sets a deadline fails its test rather than hanging it.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
			return errors.New("hung for 2s")
		}
	}
	m.expire()
	return nil
}

func (m *memStore) expire() {
	now := m.now()
	for k, t := range m.until {
		if !now.Before(t) {
			delete(m.vals, k)
			delete(m.until, k)
		}
	}
}

func (m *memStore) setLocked(key string, val []byte, ttl time.Duration) {
	m.vals[key] = bytes.Clone(val)
	m.until[key] = m.now().Add(ttl)
	m.ttls[key] = ttl
}

func (m *memStore) Get(ctx context.Context, key string) ([]byte, error) {
	if err := m.enter(ctx); err != nil {
		return nil, err
	}
	v, ok := m.vals[key]
	after := m.afterGet
	m.mu.Unlock()
	if after != nil {
		after()
	}
	if !ok {
		return nil, ErrMiss
	}
	return bytes.Clone(v), nil
}

func (m *memStore) Set(ctx context.Context, key string, val []byte, ttl time.Duration) error {
	if err := m.enter(ctx); err != nil {
		return err
	}
	defer m.mu.Unlock()
	m.setLocked(key, val, ttl)
	return nil
}

func (m *memStore) Del(ctx context.Context, key string) error {
	if err := m.enter(ctx); err != nil {
		return err
	}
	defer m.mu.Unlock()
	delete(m.vals, key)
	delete(m.until, key)
	return nil
}

// keys is every key name held.
func (m *memStore) keys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.vals))
	for k := range m.vals {
		out = append(out, k)
	}
	return out
}

func (m *memStore) set(f func(m *memStore)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f(m)
}

func (m *memStore) callCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

// raw is what key holds as stored (sealed), and the ttl it was last written with.
func (m *memStore) raw(key string) ([]byte, time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.vals[key], m.ttls[key]
}
