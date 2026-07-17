package dns

import "testing"

func TestReverseZoneName(t *testing.T) {
	cases := map[string]string{
		"192.168.1.0/24": "1.168.192.in-addr.arpa",
		"192.168.0.0/16": "168.192.in-addr.arpa",
		"10.0.0.0/8":     "10.in-addr.arpa",
	}
	for cidr, want := range cases {
		got, ok := ReverseZoneName(cidr)
		if !ok || got != want {
			t.Errorf("ReverseZoneName(%q) = %q,%v; want %q", cidr, got, ok, want)
		}
	}
	// Sub-/24 prefixes map to their covering /24 reverse zone.
	if got, ok := ReverseZoneName("192.168.1.128/25"); !ok || got != "1.168.192.in-addr.arpa" {
		t.Errorf("ReverseZoneName(/25) = %q,%v; want covering /24", got, ok)
	}
	// Prefixes shorter than /8 are rejected.
	if _, ok := ReverseZoneName("10.0.0.0/4"); ok {
		t.Errorf("ReverseZoneName should reject /4")
	}
}

func TestPtrOwner(t *testing.T) {
	cases := []struct{ ip, zone, want string }{
		{"192.168.1.160", "1.168.192.in-addr.arpa", "160"},    // /24
		{"192.168.5.10", "168.192.in-addr.arpa", "10.5"},      // /16
		{"192.168.6.10", "168.192.in-addr.arpa", "10.6"},      // /16 - must NOT collide with .5.10
		{"10.5.168.20", "10.in-addr.arpa", "20.168.5"},        // /8
	}
	for _, c := range cases {
		if got := PtrOwner(c.ip, c.zone); got != c.want {
			t.Errorf("PtrOwner(%q,%q) = %q; want %q", c.ip, c.zone, got, c.want)
		}
	}
}
