// Package dns manages authoritative DNS behind a provider interface so the
// backend (local BIND9 today; NetBox / phpIPAM later) can be swapped without
// touching the API or frontend. The local backend rewrites BIND zone files and
// named.conf.local, bumps the SOA serial, and reloads named via SIGHUP. BIND
// itself stays `allow-update none`, so the agent is the only writer.
package dns

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Record is a single resource record (owner name relative to the zone).
type Record struct {
	Name  string `json:"name"` // e.g. "tacacs", "@", or "160" (reverse host octet)
	Type  string `json:"type"` // A, AAAA, CNAME, TXT, NS, MX, PTR, SRV
	TTL   int    `json:"ttl,omitempty"`
	Value string `json:"value"` // rdata, e.g. "192.168.1.160" or "host.soteria.local."
}

// Zone is an authoritative zone with its SOA metadata and records.
type Zone struct {
	Name      string   `json:"name"`              // "soteria.local" or "1.168.192.in-addr.arpa"
	Kind      string   `json:"kind"`              // "forward" | "reverse"
	Network   string   `json:"network,omitempty"` // derived for reverse, e.g. "192.168.1.0/24"
	PrimaryNS string   `json:"primaryNs"`         // "ns.soteria.local."
	Admin     string   `json:"admin"`             // "admin.soteria.local."
	Serial    int64    `json:"serial"`
	TTL       int      `json:"ttl"`
	Records   []Record `json:"records"`
}

// Provider is the pluggable DNS backend. A future NetBox/phpIPAM provider
// implements the same interface; the API and UI are provider-agnostic.
type Provider interface {
	Name() string
	Zones(ctx context.Context) ([]Zone, error) // summaries (Records omitted)
	Zone(ctx context.Context, name string) (*Zone, error)
	CreateZone(ctx context.Context, z Zone) error
	DeleteZone(ctx context.Context, name string) error
	ReplaceRecords(ctx context.Context, zone string, records []Record) error
}

var recordTypes = map[string]bool{
	"A": true, "AAAA": true, "CNAME": true, "TXT": true,
	"NS": true, "MX": true, "PTR": true, "SRV": true,
}

func isReverse(name string) bool {
	return strings.HasSuffix(name, ".in-addr.arpa") || strings.HasSuffix(name, ".ip6.arpa")
}

func kindOf(name string) string {
	if isReverse(name) {
		return "reverse"
	}
	return "forward"
}

// networkOf derives a display CIDR from an IPv4 reverse zone name
// (e.g. "1.168.192.in-addr.arpa" -> "192.168.1.0/24"). Best-effort.
func networkOf(name string) string {
	if !strings.HasSuffix(name, ".in-addr.arpa") {
		return ""
	}
	labels := strings.Split(strings.TrimSuffix(name, ".in-addr.arpa"), ".")
	for i, j := 0, len(labels)-1; i < j; i, j = i+1, j-1 {
		labels[i], labels[j] = labels[j], labels[i]
	}
	switch len(labels) {
	case 3:
		return strings.Join(labels, ".") + ".0/24"
	case 2:
		return strings.Join(labels, ".") + ".0.0/16"
	case 1:
		return labels[0] + ".0.0.0/8"
	}
	return ""
}

// NetworkOf is the exported CIDR for a reverse zone name (e.g.
// "1.168.192.in-addr.arpa" -> "192.168.1.0/24").
func NetworkOf(zoneName string) string { return networkOf(zoneName) }

// ReverseZoneName computes the in-addr.arpa zone name for an IPv4 CIDR
// ("192.168.1.0/24" -> "1.168.192.in-addr.arpa"). Supports /8, /16, /24.
func ReverseZoneName(cidr string) (string, bool) {
	_, ipnet, err := net.ParseCIDR(cidr)
	if err != nil || ipnet.IP.To4() == nil {
		return "", false
	}
	ones, _ := ipnet.Mask.Size()
	o := ipnet.IP.To4()
	var take int
	switch {
	case ones >= 24:
		take = 3
	case ones >= 16:
		take = 2
	case ones >= 8:
		take = 1
	default:
		return "", false
	}
	parts := make([]string, 0, take)
	for i := take - 1; i >= 0; i-- {
		parts = append(parts, strconv.Itoa(int(o[i])))
	}
	return strings.Join(parts, ".") + ".in-addr.arpa", true
}

// HostOctet returns the last-octet owner name for a reverse /24 PTR from an IP
// ("192.168.1.160" -> "160").
func HostOctet(ip string) string {
	parts := strings.Split(ip, ".")
	if len(parts) == 4 {
		return parts[3]
	}
	return ip
}

// PtrOwner returns the PTR owner label for an IPv4 address inside a reverse
// zone, using only the octets NOT covered by the zone base (so it is correct
// for /8, /16 and /24). E.g. zone "168.192.in-addr.arpa" (/16) + 192.168.5.10
// -> "10.5"; zone "1.168.192.in-addr.arpa" (/24) + 192.168.1.160 -> "160".
func PtrOwner(ip, zoneName string) string {
	base := strings.TrimSuffix(zoneName, ".in-addr.arpa")
	if base == zoneName {
		return HostOctet(ip)
	}
	n := len(strings.Split(base, ".")) // network octets covered by the zone
	o := strings.Split(ip, ".")
	if len(o) != 4 || n < 1 || n > 3 {
		return HostOctet(ip)
	}
	rem := o[n:]
	for i, j := 0, len(rem)-1; i < j; i, j = i+1, j-1 {
		rem[i], rem[j] = rem[j], rem[i]
	}
	return strings.Join(rem, ".")
}

// nextSerial bumps a zone serial, keeping the YYYYMMDDnn convention.
func nextSerial(old int64) int64 {
	base, _ := strconv.ParseInt(time.Now().UTC().Format("20060102")+"00", 10, 64)
	if old >= base {
		return old + 1
	}
	return base + 1
}

func validateRecords(records []Record) error {
	for _, r := range records {
		t := strings.ToUpper(strings.TrimSpace(r.Type))
		if !recordTypes[t] {
			return fmt.Errorf("record %q: unsupported type %q", r.Name, r.Type)
		}
		if strings.TrimSpace(r.Name) == "" || strings.TrimSpace(r.Value) == "" {
			return fmt.Errorf("record of type %s: name and value are required", t)
		}
		// Guard the zone file: a whitespace-bearing owner or a value with a
		// newline would break parsing or allow injecting extra directives.
		if strings.ContainsAny(r.Name, " \t\r\n") {
			return fmt.Errorf("record %q: name must not contain whitespace", r.Name)
		}
		if strings.ContainsAny(r.Value, "\r\n") {
			return fmt.Errorf("record %q: value must not contain a newline", r.Name)
		}
		if t == "A" {
			if ip := net.ParseIP(r.Value); ip == nil || ip.To4() == nil {
				return fmt.Errorf("record %q: %q is not a valid IPv4 address", r.Name, r.Value)
			}
		}
		if t == "AAAA" {
			if ip := net.ParseIP(r.Value); ip == nil || ip.To4() != nil {
				return fmt.Errorf("record %q: %q is not a valid IPv6 address", r.Name, r.Value)
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// BIND9 file-based provider
// ---------------------------------------------------------------------------

// BindProvider manages zone files + named.conf.local for a local BIND9. Paths
// are split because the agent and the bind9 container mount the same host dirs
// at different locations: ZonesDir is where the agent writes; BindZonesDir is
// the path recorded in named.conf.local (what named reads).
type BindProvider struct {
	ZonesDir     string // agent-side, e.g. /bind9/zones
	BindZonesDir string // bind9-side, e.g. /var/lib/bind
	NamedLocal   string // agent-side named.conf.local
	Reload       func(ctx context.Context) error
	mu           sync.Mutex
}

func (b *BindProvider) Name() string { return "bind9" }

// Available reports whether the required mounts exist (DNS management is only
// offered when the bind9 project is mounted into the agent).
func (b *BindProvider) Available() bool {
	if b == nil {
		return false
	}
	if _, err := os.Stat(b.NamedLocal); err != nil {
		return false
	}
	if _, err := os.Stat(b.ZonesDir); err != nil {
		return false
	}
	return true
}

func (b *BindProvider) fileFor(name string) string { return "db." + name }

// agentPath translates a named.conf.local file path (bind9-side) to the
// agent-side path so the agent can read/write it.
func (b *BindProvider) agentPath(bindFile string) string {
	if b.BindZonesDir != "" && strings.HasPrefix(bindFile, b.BindZonesDir) {
		return filepath.Join(b.ZonesDir, strings.TrimPrefix(bindFile, b.BindZonesDir))
	}
	return filepath.Join(b.ZonesDir, filepath.Base(bindFile))
}

var zoneBlockRe = regexp.MustCompile(`(?s)zone\s+"([^"]+)"\s*\{.*?file\s+"([^"]+)"\s*;.*?\}\s*;`)

// zoneFiles returns the name->file map parsed from named.conf.local.
func (b *BindProvider) zoneFiles() (map[string]string, error) {
	data, err := os.ReadFile(b.NamedLocal)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, m := range zoneBlockRe.FindAllStringSubmatch(string(data), -1) {
		out[m[1]] = m[2]
	}
	return out, nil
}

func (b *BindProvider) Zones(_ context.Context) ([]Zone, error) {
	files, err := b.zoneFiles()
	if err != nil {
		return nil, err
	}
	var zones []Zone
	for name, bindFile := range files {
		z, err := parseZoneFile(name, b.agentPath(bindFile))
		if err != nil {
			// A zone we can't parse still shows up (empty), so it's visible.
			z = &Zone{Name: name, Kind: kindOf(name), Network: networkOf(name)}
		}
		summary := *z
		summary.Records = nil
		zones = append(zones, summary)
	}
	sort.Slice(zones, func(i, j int) bool { return zones[i].Name < zones[j].Name })
	return zones, nil
}

func (b *BindProvider) Zone(_ context.Context, name string) (*Zone, error) {
	files, err := b.zoneFiles()
	if err != nil {
		return nil, err
	}
	bindFile, ok := files[name]
	if !ok {
		return nil, fmt.Errorf("zone %q not found", name)
	}
	return parseZoneFile(name, b.agentPath(bindFile))
}

// defaultPrimaryNS picks the SOA nameserver + admin contact for a new zone.
//
// Forward zones may self-reference (ns.<zone>. resolves via in-zone glue).
// A REVERSE zone must NOT: ns.<reverse-zone>. is in-bailiwick with no address
// record, and BIND's default check-integrity then refuses to load the zone,
// so every PTR query SERVFAILs. Reverse zones therefore borrow an existing
// forward zone's resolvable, out-of-bailiwick nameserver.
func (b *BindProvider) defaultPrimaryNS(z Zone) (ns, admin string) {
	selfNS, selfAdmin := "ns."+z.Name+".", "admin."+z.Name+"."
	if z.Kind != "reverse" {
		return selfNS, selfAdmin
	}
	files, err := b.zoneFiles()
	if err == nil {
		names := make([]string, 0, len(files))
		for name := range files {
			names = append(names, name)
		}
		sort.Strings(names) // deterministic pick
		for _, name := range names {
			if kindOf(name) == "reverse" {
				continue
			}
			if fz, ferr := parseZoneFile(name, b.agentPath(files[name])); ferr == nil && fz.PrimaryNS != "" {
				adminContact := fz.Admin
				if adminContact == "" {
					adminContact = "admin." + name + "."
				}
				return fz.PrimaryNS, adminContact
			}
		}
	}
	// No forward zone to borrow from (unusual). Fall back to the self name; the
	// operator can override PrimaryNS explicitly if BIND rejects it.
	return selfNS, selfAdmin
}

func (b *BindProvider) CreateZone(ctx context.Context, z Zone) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	z.Name = strings.TrimSuffix(strings.TrimSpace(z.Name), ".")
	if z.Name == "" {
		return fmt.Errorf("zone name is required")
	}
	files, err := b.zoneFiles()
	if err != nil {
		return err
	}
	if _, exists := files[z.Name]; exists {
		return fmt.Errorf("zone %q already exists", z.Name)
	}

	z.Kind = kindOf(z.Name)
	z.Network = networkOf(z.Name)
	if z.PrimaryNS == "" || z.Admin == "" {
		ns, admin := b.defaultPrimaryNS(z)
		if z.PrimaryNS == "" {
			z.PrimaryNS = ns
		}
		if z.Admin == "" {
			z.Admin = admin
		}
	}
	if z.TTL == 0 {
		z.TTL = 3600
	}
	z.Serial = nextSerial(0)
	// Seed the required NS record.
	if len(z.Records) == 0 {
		z.Records = []Record{{Name: "@", Type: "NS", Value: z.PrimaryNS}}
	}
	if err := validateRecords(z.Records); err != nil {
		return err
	}

	// Write the zone file (agent side).
	agentFile := filepath.Join(b.ZonesDir, b.fileFor(z.Name))
	if err := writeFileAtomic(agentFile, renderZone(z)); err != nil {
		return err
	}
	// Append the zone block to named.conf.local (bind9-side file path).
	bindFile := filepath.Join(b.BindZonesDir, b.fileFor(z.Name))
	block := fmt.Sprintf("\nzone \"%s\" {\n    type master;\n    file \"%s\";\n};\n", z.Name, bindFile)
	if err := appendFile(b.NamedLocal, block); err != nil {
		_ = os.Remove(agentFile)
		return err
	}
	return b.reload(ctx)
}

func (b *BindProvider) DeleteZone(ctx context.Context, name string) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	files, err := b.zoneFiles()
	if err != nil {
		return err
	}
	bindFile, ok := files[name]
	if !ok {
		return fmt.Errorf("zone %q not found", name)
	}
	// Remove the zone block from named.conf.local.
	data, err := os.ReadFile(b.NamedLocal)
	if err != nil {
		return err
	}
	removed := zoneBlockRe.ReplaceAllStringFunc(string(data), func(block string) string {
		m := zoneBlockRe.FindStringSubmatch(block)
		if m != nil && m[1] == name {
			return ""
		}
		return block
	})
	if err := writeFileAtomic(b.NamedLocal, strings.TrimRight(removed, "\n")+"\n"); err != nil {
		return err
	}
	_ = os.Remove(b.agentPath(bindFile))
	return b.reload(ctx)
}

func (b *BindProvider) ReplaceRecords(ctx context.Context, name string, records []Record) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	if err := validateRecords(records); err != nil {
		return err
	}
	files, err := b.zoneFiles()
	if err != nil {
		return err
	}
	bindFile, ok := files[name]
	if !ok {
		return fmt.Errorf("zone %q not found", name)
	}
	agentFile := b.agentPath(bindFile)
	z, err := parseZoneFile(name, agentFile)
	if err != nil {
		return err
	}
	z.Records = records
	z.Serial = nextSerial(z.Serial)
	if err := writeFileAtomic(agentFile, renderZone(*z)); err != nil {
		return err
	}
	return b.reload(ctx)
}

func (b *BindProvider) reload(ctx context.Context) error {
	if b.Reload == nil {
		return nil
	}
	return b.Reload(ctx)
}

// ---------------------------------------------------------------------------
// Zone file parse / render
// ---------------------------------------------------------------------------

var (
	soaRe    = regexp.MustCompile(`(?is)SOA\s+(\S+)\s+(\S+)\s*\(([^)]*)\)`)
	ttlRe    = regexp.MustCompile(`(?im)^\s*\$TTL\s+(\d+)`)
	recordRe = regexp.MustCompile(`^(\S+)\s+(?:(\d+)\s+)?IN\s+([A-Za-z]+)\s+(.+?)\s*(?:;.*)?$`)
)

func parseZoneFile(name, path string) (*Zone, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	content := string(data)
	// Records is initialised non-nil so it marshals to [] not null even for a
	// zone with no resource records (the UI maps over it directly).
	z := &Zone{Name: name, Kind: kindOf(name), Network: networkOf(name), TTL: 3600, Records: []Record{}}

	if m := ttlRe.FindStringSubmatch(content); m != nil {
		z.TTL, _ = strconv.Atoi(m[1])
	}
	if m := soaRe.FindStringSubmatch(content); m != nil {
		z.PrimaryNS, z.Admin = m[1], m[2]
		if fields := strings.Fields(m[3]); len(fields) > 0 {
			z.Serial, _ = strconv.ParseInt(fields[0], 10, 64)
		}
	}
	// Strip the SOA block so its inner lines aren't parsed as records.
	content = soaRe.ReplaceAllString(content, "SOA")

	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, ";") || strings.HasPrefix(trimmed, "$") {
			continue
		}
		m := recordRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		typ := strings.ToUpper(m[3])
		if typ == "SOA" || !recordTypes[typ] {
			continue
		}
		ttl := 0
		if m[2] != "" {
			ttl, _ = strconv.Atoi(m[2])
		}
		z.Records = append(z.Records, Record{
			Name:  m[1],
			TTL:   ttl,
			Type:  typ,
			Value: strings.TrimSpace(m[4]),
		})
	}
	return z, nil
}

func pad(s string, w int) string {
	if len(s) < w {
		return s + strings.Repeat(" ", w-len(s))
	}
	return s
}

func renderZone(z Zone) string {
	if z.TTL == 0 {
		z.TTL = 3600
	}
	// Column widths so records line up (tabular), regardless of name length.
	nameW, typeW, ttlW := 1, 1, 0
	hasTTL := false
	for _, r := range z.Records {
		name := r.Name
		if name == "" {
			name = "@"
		}
		if len(name) > nameW {
			nameW = len(name)
		}
		if len(r.Type) > typeW {
			typeW = len(r.Type)
		}
		if r.TTL > 0 {
			hasTTL = true
			if s := strconv.Itoa(r.TTL); len(s) > ttlW {
				ttlW = len(s)
			}
		}
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "$TTL %d\n", z.TTL)
	fmt.Fprintf(&sb, "@       IN  SOA %s %s (\n", z.PrimaryNS, z.Admin)
	fmt.Fprintf(&sb, "                %d ; Serial (managed by soteria-agent)\n", z.Serial)
	sb.WriteString("                3600       ; Refresh\n")
	sb.WriteString("                1800       ; Retry\n")
	sb.WriteString("                604800     ; Expire\n")
	sb.WriteString("                300 )      ; Negative cache TTL\n\n")
	for _, r := range z.Records {
		name := r.Name
		if name == "" {
			name = "@"
		}
		ttl := ""
		if hasTTL {
			if r.TTL > 0 {
				ttl = strconv.Itoa(r.TTL)
			}
			ttl = pad(ttl, ttlW) + "  "
		}
		fmt.Fprintf(&sb, "%s  %sIN  %s  %s\n", pad(name, nameW), ttl, pad(strings.ToUpper(r.Type), typeW), r.Value)
	}
	return sb.String()
}

func writeFileAtomic(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func appendFile(path, content string) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(content)
	return err
}
