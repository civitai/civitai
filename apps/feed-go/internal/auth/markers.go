package auth

import (
	"container/list"
	"sync"
)

// MarkerCacheMaxEntries is REVOCATION_MARKER_CACHE_MAX_ENTRIES (packages/civitai-auth/src/revocation-check.ts):
// the record's size bound, least recently used evicted first. There is no time-based expiry, as in the
// package: a held marker only ever revokes tokens signed before it (or the one token or family it names),
// so keeping it longer cannot deny a session the store would allow, and a restart empties the record.
const MarkerCacheMaxEntries = 20_000

// MarkerCache is createRevocationMarkerCache (packages/civitai-auth/src/revocation-marker-cache.ts): a
// per-process record of the revocation markers this process has READ from the session store, so a
// revocation already seen here still denies while the store cannot be read.
//
// What it records, as the package does:
//   - a hash field (token or family state) only when its value is `invalid`; any other value (a
//     `refresh` marker) or an absent field deletes the entry.
//   - a plain key (the global cut-off, a user's cut, an impersonator's cut) whenever it has a value; an
//     absent key deletes the entry.
//   - a read that failed records nothing.
//
// It is a record of what was seen here, not a replica: with the store down, a marker this process never
// read is not applied. Safe for concurrent use.
type MarkerCache struct {
	max int

	mu      sync.Mutex
	order   *list.List // front = most recently used
	entries map[string]*list.Element
}

type markerEntry struct {
	key, value string
}

// NewMarkerCache returns an empty record holding at most max entries (<= 0 = MarkerCacheMaxEntries).
func NewMarkerCache(max int) *MarkerCache {
	if max <= 0 {
		max = MarkerCacheMaxEntries
	}
	return &MarkerCache{max: max, order: list.New(), entries: map[string]*list.Element{}}
}

// Hash keys and field names never contain NUL, so a hash entry cannot collide with a plain key.
func hashEntry(key, field string) string { return key + "\x00" + field }

// record is the package's record(): the entry is removed, then stored again when present, as the most
// recently used; the least recently used are evicted past the bound.
func (m *MarkerCache) record(entry, value string, present bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if el, ok := m.entries[entry]; ok {
		m.order.Remove(el)
		delete(m.entries, entry)
	}
	if !present {
		return
	}
	m.entries[entry] = m.order.PushFront(&markerEntry{key: entry, value: value})
	for len(m.entries) > m.max {
		oldest := m.order.Back()
		m.order.Remove(oldest)
		delete(m.entries, oldest.Value.(*markerEntry).key)
	}
}

// lookup is the package's lookup(): a hit becomes the most recently used. "" = no entry.
func (m *MarkerCache) lookup(entry string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	el, ok := m.entries[entry]
	if !ok {
		return ""
	}
	m.order.MoveToFront(el)
	return el.Value.(*markerEntry).value
}

// Len is the number of entries held.
func (m *MarkerCache) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.entries)
}

// reply is one command's outcome for the record.
type reply struct {
	value   string
	ok      bool // the command was answered
	present bool // the key or field exists
}

// observeHash records one token/family-state read.
func (m *MarkerCache) observeHash(key, field string, r reply) {
	if !r.ok {
		return
	}
	m.record(hashEntry(key, field), r.value, r.present && r.value == "invalid")
}

// observeKey records one plain-key read.
func (m *MarkerCache) observeKey(key string, r reply) {
	if !r.ok {
		return
	}
	m.record(key, r.value, r.present)
}
