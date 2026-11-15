package sysredis

import (
	"reflect"
	"strings"
	"testing"
)

// Fixture values are pairwise distinct (and distinct from DefaultSentinelPort) so a mutant that
// copies one field into another, or hardcodes a default, shows up.
const (
	masterPass   = "master-pw-7f3a"
	sentinelPass = "sentinel-pw-91c2"
	groupName    = "group-q8"
)

func TestPlainModeWhenSentinelsUnset(t *testing.T) {
	failover, plain, err := Options(Settings{
		URL:          "redis://alice:" + masterPass + "@sys-primary.example:6390/4",
		SentinelName: groupName, // ignored without REDIS_SYS_SENTINELS, as in Node
	})
	if err != nil {
		t.Fatalf("Options: %v", err)
	}
	if failover != nil || plain == nil {
		t.Fatalf("want single-connection options only, got failover=%v plain=%v", failover, plain)
	}
	if plain.Addr != "sys-primary.example:6390" {
		t.Errorf("Addr = %q", plain.Addr)
	}
	if plain.Username != "alice" || plain.Password != masterPass {
		t.Errorf("auth = %q/%q", plain.Username, plain.Password)
	}
	// Node connects to protocol//host only, so the /4 path never selects a database.
	if plain.DB != 0 {
		t.Errorf("DB = %d, want 0 (path ignored, as in Node)", plain.DB)
	}
	if plain.TLSConfig != nil {
		t.Errorf("redis:// must not enable TLS")
	}
}

func TestPlainModeRedissEnablesTLS(t *testing.T) {
	_, plain, err := Options(Settings{URL: "rediss://:" + masterPass + "@sys-primary.example:6390"})
	if err != nil {
		t.Fatalf("Options: %v", err)
	}
	if plain == nil || plain.TLSConfig == nil {
		t.Fatalf("rediss:// must enable TLS in single-connection mode")
	}
}

func TestSentinelMode(t *testing.T) {
	failover, plain, err := Options(Settings{
		// Host is NOT used in Sentinel mode; the path and username are ignored, as in Node.
		URL:              "redis://bob:" + masterPass + "@not-the-master.example:6390/5",
		Sentinels:        " s-one.example:26400 , s-two.example ,, 10.9.8.7:26401",
		SentinelName:     groupName,
		SentinelPassword: sentinelPass,
	})
	if err != nil {
		t.Fatalf("Options: %v", err)
	}
	if plain != nil || failover == nil {
		t.Fatalf("want failover options only, got failover=%v plain=%v", failover, plain)
	}
	if failover.MasterName != groupName {
		t.Errorf("MasterName = %q, want %q", failover.MasterName, groupName)
	}
	wantAddrs := []string{"s-one.example:26400", "s-two.example:26379", "10.9.8.7:26401"}
	if !reflect.DeepEqual(failover.SentinelAddrs, wantAddrs) {
		t.Errorf("SentinelAddrs = %v, want %v", failover.SentinelAddrs, wantAddrs)
	}
	if failover.Password != masterPass {
		t.Errorf("master Password = %q, want the REDIS_SYS_URL password", failover.Password)
	}
	if failover.SentinelPassword != sentinelPass {
		t.Errorf("SentinelPassword = %q, want %q", failover.SentinelPassword, sentinelPass)
	}
	if failover.Username != "" || failover.SentinelUsername != "" {
		t.Errorf("usernames = %q/%q, want none (Node sends only the password)", failover.Username, failover.SentinelUsername)
	}
	if failover.DB != 0 {
		t.Errorf("DB = %d, want 0", failover.DB)
	}
	if failover.TLSConfig != nil {
		t.Errorf("Sentinel mode must not enable TLS (Node's Sentinel branch has none)")
	}
}

func TestSentinelModeWithoutSentinelPassword(t *testing.T) {
	failover, _, err := Options(Settings{
		URL:          "redis://:" + masterPass + "@x.example:6379",
		Sentinels:    "s-one.example:26400",
		SentinelName: groupName,
	})
	if err != nil {
		t.Fatalf("Options: %v", err)
	}
	if failover.SentinelPassword != "" {
		t.Errorf("SentinelPassword = %q, want empty (Sentinel auth off)", failover.SentinelPassword)
	}
	if failover.Password != masterPass {
		t.Errorf("master Password = %q", failover.Password)
	}
}

func TestSentinelRedissStaysPlaintext(t *testing.T) {
	failover, _, err := Options(Settings{
		URL:          "rediss://:" + masterPass + "@x.example:6379",
		Sentinels:    "s-one.example:26400",
		SentinelName: groupName,
	})
	if err != nil {
		t.Fatalf("Options: %v", err)
	}
	if failover.TLSConfig != nil {
		t.Errorf("Sentinel mode must not enable TLS, even for rediss://")
	}
}

func TestErrors(t *testing.T) {
	cases := []struct {
		name string
		s    Settings
		want string
	}{
		{"no url", Settings{}, "REDIS_SYS_URL is required"},
		{"no url in sentinel mode", Settings{Sentinels: "s.example:26400", SentinelName: groupName}, "REDIS_SYS_URL is required"},
		{"name missing", Settings{URL: "redis://x.example:6379", Sentinels: "s.example:26400"}, "REDIS_SYS_SENTINEL_NAME is required"},
		// Set-but-blank still selects Sentinel mode (as Node's truthiness check does) and then fails
		// loudly, instead of silently falling back to the single connection.
		{"blank sentinels", Settings{URL: "redis://x.example:6379", Sentinels: " , ", SentinelName: groupName}, "names no sentinel"},
		{"bad port", Settings{URL: "redis://x.example:6379", Sentinels: "s.example:port", SentinelName: groupName}, "invalid port"},
		{"empty port", Settings{URL: "redis://x.example:6379", Sentinels: "s.example:", SentinelName: groupName}, "invalid port"},
		{"no host", Settings{URL: "redis://x.example:6379", Sentinels: ":26400", SentinelName: groupName}, "has no host"},
		{"bad plain url", Settings{URL: "http://x.example:6379"}, "REDIS_SYS_URL"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			failover, plain, err := Options(c.s)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want it to contain %q", err, c.want)
			}
			if failover != nil || plain != nil {
				t.Fatalf("options returned with an error")
			}
			if _, err := New(c.s); err == nil {
				t.Fatalf("New must fail where Options fails")
			}
		})
	}
}
