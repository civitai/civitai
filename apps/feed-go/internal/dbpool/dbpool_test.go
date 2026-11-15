package dbpool

import (
	"testing"
	"time"
)

const base = "postgres://u:p@db.example:5432/app"

func TestDefaultsApplied(t *testing.T) {
	cfg, err := Config(base, Settings{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConns != DefaultMaxConns || cfg.MinConns != 0 ||
		cfg.MaxConnLifetime != DefaultMaxConnLifetime || cfg.MaxConnIdleTime != DefaultMaxConnIdleTime {
		t.Fatalf("got max=%d min=%d life=%v idle=%v", cfg.MaxConns, cfg.MinConns, cfg.MaxConnLifetime, cfg.MaxConnIdleTime)
	}
}

func TestSettingsMaxConns(t *testing.T) {
	// 13 is neither the default nor pgxpool's own NumCPU-based default on a common node.
	cfg, err := Config(base, Settings{MaxConns: 13})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConns != 13 {
		t.Fatalf("MaxConns = %d, want 13", cfg.MaxConns)
	}
	if cfg, _ := Config(base, Settings{MaxConns: -2}); cfg.MaxConns != DefaultMaxConns {
		t.Fatalf("a non-positive setting must mean the default, got %d", cfg.MaxConns)
	}
	if cfg, _ := Config(base, Settings{MaxConns: 1 << 40}); cfg.MaxConns != 1000 {
		t.Fatalf("an oversized setting must be capped at 1000, got %d", cfg.MaxConns)
	}
}

func TestConnectionStringWins(t *testing.T) {
	url := base + "?sslmode=disable&pool_max_conns=3&pool_min_conns=1&pool_max_conn_lifetime=7m&pool_max_conn_idle_time=11s"
	cfg, err := Config(url, Settings{MaxConns: 13})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConns != 3 || cfg.MinConns != 1 || cfg.MaxConnLifetime != 7*time.Minute || cfg.MaxConnIdleTime != 11*time.Second {
		t.Fatalf("got max=%d min=%d life=%v idle=%v, want the connection string's 3/1/7m/11s",
			cfg.MaxConns, cfg.MinConns, cfg.MaxConnLifetime, cfg.MaxConnIdleTime)
	}
	// Keyword/value form too.
	kv := "host=db.example user=u password=p dbname=app pool_max_conns=5"
	cfg, err = Config(kv, Settings{MaxConns: 13})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConns != 5 || cfg.MaxConnIdleTime != DefaultMaxConnIdleTime {
		t.Fatalf("keyword/value: max=%d idle=%v, want 5 and the default idle", cfg.MaxConns, cfg.MaxConnIdleTime)
	}
}

func TestBadURL(t *testing.T) {
	if _, err := Config("postgres://u:p@db.example:5432/app?pool_max_conns=abc", Settings{}); err == nil {
		t.Fatal("an invalid pool setting must fail")
	}
}
