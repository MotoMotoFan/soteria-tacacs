// Package logsvc reads the AAA logs tac_plus-ng writes to the shared
// tacacs-logs volume: <type>/YYYY/MM/<type>-MM-DD-YYYY.log with RFC 5424
// timestamps and tab-separated fields.
//
// Field parsing is deliberately lenient: exact field layout differs per log
// type and device, and will be tightened once real device traffic produces
// samples. Unknown layouts degrade to timestamp + raw detail, never errors.
//
// Design note: the daily-file reader is ONE log source, not THE log source.
// A remote syslog backend (RFC 5424 over UDP/TCP) is planned; keep Query's
// signature and the LogEntry mapping independent of the file layout so the
// syslog source can slot in beside it.
package logsvc

import (
	"fmt"
	"net/netip"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/Pathfinder-Insights/soteria-agent/internal/model"
)

var logTypes = []string{"authentication", "authorization", "accounting"}

// maxRangeDays caps a from..to query to keep file reads bounded.
const maxRangeDays = 92

// Query reads logs for an inclusive date range [from, to] (YYYY-MM-DD, each
// defaulting to today). devices resolves a NAS IP to its configured name.
func Query(logDir, from, to string, typeFilter string, devices []model.Device) ([]model.LogEntry, error) {
	start, err := parseDay(from)
	if err != nil {
		return nil, err
	}
	end, err := parseDay(to)
	if err != nil {
		return nil, err
	}
	if end.Before(start) {
		start, end = end, start
	}
	if end.Sub(start) > maxRangeDays*24*time.Hour {
		return nil, fmt.Errorf("date range too large (max %d days)", maxRangeDays)
	}

	entries := []model.LogEntry{}
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		for _, t := range logTypes {
			if typeFilter != "" && t != typeFilter {
				continue
			}
			path := fmt.Sprintf("%s/%s/%s/%s/%s-%s.log",
				logDir, t, day.Format("2006"), day.Format("01"), t, day.Format("01-02-2006"))
			b, err := os.ReadFile(path)
			if err != nil {
				continue // no traffic of this type that day
			}
			for _, line := range strings.Split(string(b), "\n") {
				line = strings.TrimSpace(line)
				if line == "" {
					continue
				}
				entries = append(entries, parseLine(t, line, devices))
			}
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Timestamp > entries[j].Timestamp })
	return entries, nil
}

func parseDay(s string) (time.Time, error) {
	if s == "" {
		now := time.Now()
		return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local), nil
	}
	d, err := time.ParseInLocation("2006-01-02", s, time.Local)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid date %q, want YYYY-MM-DD", s)
	}
	return d, nil
}

// parseLine maps one tac_plus-ng log line into structured fields. Layouts
// (tab-separated, verified against real device traffic) differ per type —
// field 0 is always "timestamp<space>NAS-IP", then:
//
//	authentication: user \t port \t rem_addr \t message
//	authorization:  user \t port \t rem_addr \t profile \t result \t service \t cmd
//	accounting:     user \t port \t rem_addr \t acct-type \t service \t cmd
func parseLine(logType, line string, devices []model.Device) model.LogEntry {
	e := model.LogEntry{Type: logType}
	fields := strings.Split(line, "\t")

	field := func(i int) string {
		if i < len(fields) {
			return strings.TrimSpace(fields[i])
		}
		return ""
	}

	head := strings.SplitN(strings.TrimSpace(fields[0]), " ", 2)
	e.Timestamp = formatTimestamp(head[0])
	if len(head) > 1 {
		e.DeviceIP = strings.TrimSpace(head[1])
		e.Device = resolveDevice(e.DeviceIP, devices)
	}
	e.User = field(1)
	e.Port = field(2)

	switch {
	case logType == "authorization" && len(fields) >= 6:
		// profile, result, service, cmd — cmd empty for exec/session authz
		e.Result = mapResult(field(5))
		e.Service = field(6)
		e.Command = field(7)
		e.Detail = field(4) // the matched profile/priv
	case logType == "accounting" && len(fields) >= 6:
		e.Result = "success"
		e.Detail = field(4) // acct-type: start | stop | update
		e.Service = field(5)
		e.Command = field(6)
	case len(fields) >= 5:
		// authentication (or any type without the extra fields)
		e.Result = classify(logType, line)
		e.Detail = strings.TrimSpace(strings.Join(fields[4:], " "))
	default:
		e.Result = classify(logType, line)
		e.Detail = strings.TrimSpace(strings.Join(fields[min(2, len(fields)):], " "))
	}
	return e
}

// mapResult normalizes an authorization verdict to the UI's result values.
func mapResult(s string) string {
	switch strings.ToLower(s) {
	case "permit":
		return "success"
	case "deny", "denied", "reject":
		return "failure"
	case "":
		return "error"
	default:
		return s
	}
}

// formatTimestamp renders the RFC 3339 log timestamp as a readable local
// "YYYY-MM-DD HH:MM:SS"; unparseable values pass through untouched.
func formatTimestamp(ts string) string {
	if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		return t.Local().Format("2006-01-02 15:04:05")
	}
	return ts
}

func classify(logType, line string) string {
	l := strings.ToLower(line)
	switch {
	case strings.Contains(l, "fail") || strings.Contains(l, "deny") || strings.Contains(l, "denied") || strings.Contains(l, "reject"):
		return "failure"
	case strings.Contains(l, "succ") || strings.Contains(l, "permit") || strings.Contains(l, "pass"):
		return "success"
	case logType == "accounting":
		return "success" // accounting records are informational
	default:
		return "error"
	}
}

// resolveDevice maps a NAS IP to the configured device name whose CIDR
// contains it (most specific wins; the 0.0.0.0/0 catch-all is skipped).
func resolveDevice(ip string, devices []model.Device) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	bestBits := -1
	best := ip
	for _, d := range devices {
		prefix, err := netip.ParsePrefix(d.Address)
		if err != nil || prefix.Bits() == 0 {
			continue
		}
		if prefix.Contains(addr) && prefix.Bits() > bestBits {
			bestBits = prefix.Bits()
			best = d.Name
		}
	}
	return best
}
