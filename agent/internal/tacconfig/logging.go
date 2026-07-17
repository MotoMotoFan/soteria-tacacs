package tacconfig

import (
	"fmt"
	"net/netip"
	"strings"

	"github.com/Pathfinder-Insights/soteria-agent/internal/model"
)

// ParseLogging reads 01-logging.cfg. The file logs are fixed; only the
// optional external syslog export block is user-configurable.
func ParseLogging(src string) (model.LoggingConfig, error) {
	cfg := model.LoggingConfig{}
	nodes, _, err := parse(src)
	if err != nil {
		return cfg, err
	}
	cfg.SyslogTimestamp = "RFC3164"
	for _, n := range nodes {
		if n.kind != nBlock || n.name != "log" || n.label != "external_syslog" {
			continue
		}
		dest := assignValue(n.children, "destination")
		host, port, ok := strings.Cut(dest, ":")
		if ok {
			cfg.SyslogHost = host
			fmt.Sscanf(port, "%d", &cfg.SyslogPort)
		}
		if ts := assignValue(n.children, "timestamp"); ts != "" {
			cfg.SyslogTimestamp = ts
		}
	}
	// A log type is "assigned" to a destination via `<type> log = <dest>`.
	for _, n := range nodes {
		if n.kind == nAssign && strings.HasSuffix(n.name, " log") {
			if n.value == "external_syslog" {
				cfg.SyslogEnabled = true
			}
			if strings.HasSuffix(n.value, "_log") { // authentication_log, etc.
				cfg.FileLogEnabled = true
			}
		}
	}
	return cfg, nil
}

// ValidateLogging checks user input before rendering.
func ValidateLogging(cfg model.LoggingConfig) error {
	if !cfg.FileLogEnabled && !cfg.SyslogEnabled {
		return fmt.Errorf("at least one log destination must be enabled (local files or remote syslog)")
	}
	if !cfg.SyslogEnabled {
		return nil
	}
	if cfg.SyslogTimestamp != "" && cfg.SyslogTimestamp != "RFC3164" && cfg.SyslogTimestamp != "RFC5424" {
		return fmt.Errorf("syslog timestamp must be RFC3164 or RFC5424")
	}
	if cfg.SyslogHost == "" {
		return fmt.Errorf("syslog collector host is required when export is enabled")
	}
	if strings.ContainsAny(cfg.SyslogHost, " \t\"{}()=#:") {
		return fmt.Errorf("syslog host %q contains invalid characters", cfg.SyslogHost)
	}
	if _, err := netip.ParseAddr(cfg.SyslogHost); err != nil && !isHostname(cfg.SyslogHost) {
		return fmt.Errorf("syslog host %q is not a valid IP address or hostname", cfg.SyslogHost)
	}
	if cfg.SyslogPort < 1 || cfg.SyslogPort > 65535 {
		return fmt.Errorf("syslog port must be between 1 and 65535")
	}
	return nil
}

func isHostname(s string) bool {
	for _, label := range strings.Split(s, ".") {
		if label == "" {
			return false
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
				return false
			}
		}
	}
	return true
}

// RenderLogging writes 01-logging.cfg. Local daily file logs and remote
// syslog export are independent toggles; both, one, or (validation forbids)
// neither can be assigned. tac_plus-ng accepts multiple `<type> log =`
// assignments (validated against the real binary).
func RenderLogging(cfg model.LoggingConfig) string {
	var b strings.Builder
	b.WriteString(banner("01-logging.cfg", "Log destinations and assignments"))
	b.WriteString("# Suppress non-session logs from appearing in terminal/syslogd\nsyslog default = deny\n")

	// Destination definitions (harmless if not assigned).
	b.WriteString(`
log authentication_log {
    destination = /var/log/tac_plus/authentication/%Y/%m/authentication-%m-%d-%Y.log
    timestamp   = RFC5424
}

log authorization_log {
    destination = /var/log/tac_plus/authorization/%Y/%m/authorization-%m-%d-%Y.log
    timestamp   = RFC5424
}

log accounting_log {
    destination = /var/log/tac_plus/accounting/%Y/%m/accounting-%m-%d-%Y.log
    timestamp   = RFC5424
}
`)
	if cfg.SyslogEnabled {
		ts := cfg.SyslogTimestamp
		if ts != "RFC5424" {
			ts = "RFC3164"
		}
		fmt.Fprintf(&b, "\nlog external_syslog {\n    destination = %s:%d\n    timestamp   = %s\n}\n", cfg.SyslogHost, cfg.SyslogPort, ts)
	}

	b.WriteString("\n# Assignments\n")
	if cfg.FileLogEnabled {
		b.WriteString("authentication log = authentication_log\nauthorization log  = authorization_log\naccounting log     = accounting_log\n")
	}
	if cfg.SyslogEnabled {
		b.WriteString("authentication log = external_syslog\nauthorization log  = external_syslog\naccounting log     = external_syslog\n")
	}
	return b.String()
}
