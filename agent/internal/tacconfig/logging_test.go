package tacconfig

import (
	"os"
	"testing"

	"github.com/Pathfinder-Insights/soteria-agent/internal/model"
)

func TestLoggingRoundTrip(t *testing.T) {
	// Shipped default (no export block) parses as disabled.
	b, err := os.ReadFile("testdata/01-logging.cfg")
	if err == nil {
		cfg, err := ParseLogging(string(b))
		if err != nil {
			t.Fatal(err)
		}
		if cfg.SyslogEnabled {
			t.Fatalf("shipped config should have syslog disabled: %+v", cfg)
		}
	}

	for _, want := range []model.LoggingConfig{
		{FileLogEnabled: true, SyslogTimestamp: "RFC3164"},
		{FileLogEnabled: true, SyslogEnabled: true, SyslogHost: "192.168.1.50", SyslogPort: 514, SyslogTimestamp: "RFC3164"},
		{FileLogEnabled: false, SyslogEnabled: true, SyslogHost: "syslog.lab.home", SyslogPort: 1514, SyslogTimestamp: "RFC5424"},
	} {
		got, err := ParseLogging(RenderLogging(want))
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("round trip mismatch: want %+v got %+v", want, got)
		}
	}

	// Empty timestamp normalizes to RFC3164 on render.
	got, err := ParseLogging(RenderLogging(model.LoggingConfig{FileLogEnabled: true, SyslogEnabled: true, SyslogHost: "10.0.0.1", SyslogPort: 514}))
	if err != nil {
		t.Fatal(err)
	}
	if got.SyslogTimestamp != "RFC3164" {
		t.Fatalf("empty timestamp should default to RFC3164, got %q", got.SyslogTimestamp)
	}
}

func TestValidateLogging(t *testing.T) {
	bad := []model.LoggingConfig{
		{}, // nothing enabled
		{SyslogEnabled: true},
		{SyslogEnabled: true, SyslogHost: "10.0.0.1", SyslogPort: 0},
		{SyslogEnabled: true, SyslogHost: "bad host", SyslogPort: 514},
		{SyslogEnabled: true, SyslogHost: "a:b", SyslogPort: 514},
		{SyslogEnabled: true, SyslogHost: "10.0.0.1", SyslogPort: 514, SyslogTimestamp: "RFC9999"},
	}
	for _, cfg := range bad {
		if err := ValidateLogging(cfg); err == nil {
			t.Fatalf("expected validation error for %+v", cfg)
		}
	}
	if err := ValidateLogging(model.LoggingConfig{FileLogEnabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateLogging(model.LoggingConfig{SyslogEnabled: true, SyslogHost: "10.0.0.5", SyslogPort: 514}); err != nil {
		t.Fatal(err)
	}
}
