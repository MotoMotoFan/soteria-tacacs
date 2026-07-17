package tacconfig

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/Pathfinder-Insights/soteria-agent/internal/model"
)

// ---------------------------------------------------------------------------
// 02-dns.cfg
// ---------------------------------------------------------------------------

var reDNSServers = regexp.MustCompile(`(?m)^\s*dns\s+servers\s*=\s*"?([^"\n]*)"?`)
var reDNSReverse = regexp.MustCompile(`(?m)^\s*dns\s+reverse-lookup\s*=\s*(\w+)`)
var reDNSTimeout = regexp.MustCompile(`(?m)^\s*dns\s+timeout\s*=\s*(\d+)`)

// ParseDNS extracts DNS settings from 02-dns.cfg content.
func ParseDNS(src string, s *model.ServerSettings) {
	if m := reDNSServers.FindStringSubmatch(src); m != nil {
		s.DNSServer = strings.TrimSpace(m[1])
	}
	s.DNSReverseLookup = true
	if m := reDNSReverse.FindStringSubmatch(src); m != nil {
		s.DNSReverseLookup = m[1] == "yes"
	}
	s.DNSTimeout = "5"
	if m := reDNSTimeout.FindStringSubmatch(src); m != nil {
		s.DNSTimeout = m[1]
	}
}

// RenderDNS writes 02-dns.cfg from settings.
func RenderDNS(s model.ServerSettings) string {
	var b strings.Builder
	b.WriteString(banner("02-dns.cfg", "DNS resolution settings"))
	if strings.TrimSpace(s.DNSServer) != "" {
		b.WriteString(fmt.Sprintf("dns servers = \"%s\"\n", strings.TrimSpace(s.DNSServer)))
	}
	reverse := "no"
	if s.DNSReverseLookup {
		reverse = "yes"
	}
	timeout := s.DNSTimeout
	if timeout == "" {
		timeout = "5"
	}
	b.WriteString(fmt.Sprintf("dns reverse-lookup = %s\n", reverse))
	b.WriteString(fmt.Sprintf("dns timeout        = %s\n", timeout))
	b.WriteString("dns cache period   = 86400\n")
	return b.String()
}

// ---------------------------------------------------------------------------
// 03-mavis.cfg (LDAP backend)
// ---------------------------------------------------------------------------

func mavisSetenv(key string) *regexp.Regexp {
	return regexp.MustCompile(`(?m)^\s*setenv\s+` + regexp.QuoteMeta(key) + `\s*=\s*"([^"]*)"`)
}

// ParseMavis extracts LDAP setenv values from 03-mavis.cfg content.
func ParseMavis(src string, s *model.ServerSettings) {
	get := func(k string) string {
		if m := mavisSetenv(k).FindStringSubmatch(src); m != nil {
			return m[1]
		}
		return ""
	}
	s.LdapServerType = get("LDAP_SERVER_TYPE")
	s.LdapHosts = get("LDAP_HOSTS")
	s.LdapUser = get("LDAP_USER")
	s.LdapPasswordSet = get("LDAP_PASSWD") != ""
	s.LdapBase = get("LDAP_BASE")
	s.LdapFilter = get("LDAP_FILTER")
	s.LdapBaseGroup = get("LDAP_BASE_GROUP")
	s.LdapFilterGroup = get("LDAP_FILTER_GROUP")
	s.LdapTacMember = get("LDAP_TACMEMBER")
	s.LdapConnectTimeout = get("LDAP_CONNECT_TIMEOUT")
	if s.LdapConnectTimeout == "" {
		s.LdapConnectTimeout = "5"
	}

	// TLS: the scheme lives in LDAP_HOSTS (ldaps://) while StartTLS is its own
	// flag. Strip the scheme back off so the UI's Hosts field stays clean and
	// the mode selector alone drives it.
	switch {
	case get("USE_STARTTLS") != "":
		s.LdapTLSMode = "starttls"
	case strings.Contains(strings.ToLower(s.LdapHosts), "ldaps://"):
		s.LdapTLSMode = "ldaps"
	default:
		s.LdapTLSMode = "none"
	}
	s.LdapHosts = stripLdapScheme(s.LdapHosts)
	s.LdapTLSVerify = strings.Contains(get("TLS_OPTIONS"), "verify => 'require'")
}

// LDAP TLS material, uploaded via the UI, lives in the shared tacacs-config
// volume (mounted at /etc/tac_plus-ng in both soteria-agent and soteria-tacacs)
// so the MAVIS perl backend and the agent's Go client read the same files.
const (
	LdapTLSDir         = "/etc/tac_plus-ng/tls/ldap"
	LdapCAPath         = LdapTLSDir + "/ca.crt"
	LdapClientCertPath = LdapTLSDir + "/client.crt"
	LdapClientKeyPath  = LdapTLSDir + "/client.key"
)

func tlsFileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// stripLdapScheme removes ldap://ldaps:// prefixes from a host list.
func stripLdapScheme(hosts string) string {
	f := strings.Fields(hosts)
	for i, h := range f {
		l := strings.ToLower(h)
		switch {
		case strings.HasPrefix(l, "ldaps://"):
			f[i] = h[len("ldaps://"):]
		case strings.HasPrefix(l, "ldap://"):
			f[i] = h[len("ldap://"):]
		}
	}
	return strings.Join(f, " ")
}

// mavisHosts re-adds the ldaps:// scheme when LDAPS is selected; Net::LDAP in
// the mavis script negotiates TLS from the scheme.
func mavisHosts(hosts, mode string) string {
	if mode != "ldaps" {
		return stripLdapScheme(hosts)
	}
	f := strings.Fields(stripLdapScheme(hosts))
	for i, h := range f {
		f[i] = "ldaps://" + h
	}
	return strings.Join(f, " ")
}

// mavisTLSOptions renders the Net::LDAP option hash that the mavis script
// eval()s from TLS_OPTIONS. Every value is a fixed enum or a fixed path, never
// operator free-text, so the eval has no injection surface.
func mavisTLSOptions(verify bool) string {
	parts := []string{"verify => 'none'"}
	if verify {
		parts[0] = "verify => 'require'"
	}
	if tlsFileExists(LdapCAPath) {
		parts = append(parts, fmt.Sprintf("cafile => '%s'", LdapCAPath))
	}
	if tlsFileExists(LdapClientCertPath) && tlsFileExists(LdapClientKeyPath) {
		parts = append(parts,
			fmt.Sprintf("clientcert => '%s'", LdapClientCertPath),
			fmt.Sprintf("clientkey => '%s'", LdapClientKeyPath))
	}
	return strings.Join(parts, ", ")
}

// MavisPassword returns the current LDAP bind password from 03-mavis.cfg
// (used to preserve it when the UI submits an empty password field).
func MavisPassword(src string) string {
	if m := mavisSetenv("LDAP_PASSWD").FindStringSubmatch(src); m != nil {
		return m[1]
	}
	return ""
}

// RenderMavis writes 03-mavis.cfg. If keepPassword is non-empty it is written
// as the bind password; otherwise the existing password is preserved by the
// caller (which passes it in via s.LdapPassword).
func RenderMavis(s model.ServerSettings) string {
	esc := func(v string) string { return strings.ReplaceAll(v, `"`, "") } // no quotes in values
	scope := func(v string) string {
		if v == "" {
			return "sub"
		}
		return v
	}
	timeout := s.LdapConnectTimeout
	if timeout == "" {
		timeout = "5"
	}
	var b strings.Builder
	b.WriteString(banner("03-mavis.cfg", "MAVIS authentication backend (LDAP)"))
	b.WriteString(`# Authorization cache for performance improvement
mavis module = tacinfo_cache {
    directory = /tmp/tacinfo
}

mavis module = external {
`)
	tlsMode := strings.ToLower(strings.TrimSpace(s.LdapTLSMode))
	fmt.Fprintf(&b, "    setenv LDAP_SERVER_TYPE = \"%s\"\n", esc(s.LdapServerType))
	fmt.Fprintf(&b, "    setenv LDAP_HOSTS       = \"%s\"\n", esc(mavisHosts(s.LdapHosts, tlsMode)))
	fmt.Fprintf(&b, "    setenv LDAP_USER        = \"%s\"\n", esc(s.LdapUser))
	fmt.Fprintf(&b, "    setenv LDAP_PASSWD      = \"%s\"\n", esc(s.LdapPassword))
	fmt.Fprintf(&b, "    setenv LDAP_BASE        = \"%s\"\n", esc(s.LdapBase))
	fmt.Fprintf(&b, "    setenv LDAP_SCOPE       = \"%s\"\n", scope(""))
	// Empty user/group filters and TACMEMBER are OMITTED so the mavis script's
	// own defaults apply - notably LDAP_FILTER_GROUP defaults to
	// "(&(objectclass=groupOfNames)(member=%s))", the OpenLDAP reverse group
	// lookup (OpenLDAP has no memberOf overlay by default). Setting these blank
	// used to override those defaults and break group resolution.
	if s.LdapFilter != "" {
		fmt.Fprintf(&b, "    setenv LDAP_FILTER      = \"%s\"\n", esc(s.LdapFilter))
	}
	fmt.Fprintf(&b, "    setenv LDAP_BASE_GROUP   = \"%s\"\n", esc(s.LdapBaseGroup))
	fmt.Fprintf(&b, "    setenv LDAP_SCOPE_GROUP  = \"%s\"\n", scope(""))
	if s.LdapFilterGroup != "" {
		fmt.Fprintf(&b, "    setenv LDAP_FILTER_GROUP = \"%s\"\n", esc(s.LdapFilterGroup))
	}
	fmt.Fprintf(&b, "    setenv LDAP_CONNECT_TIMEOUT = \"%s\"\n", esc(timeout))
	// Group-membership attribute on the user entry (AD: memberOf). Blank on
	// OpenLDAP so the reverse group search above is used instead.
	if s.LdapTacMember != "" {
		fmt.Fprintf(&b, "    setenv LDAP_TACMEMBER    = \"%s\"\n", esc(s.LdapTacMember))
	}
	// TLS. LDAPS is carried by the ldaps:// scheme on LDAP_HOSTS above; StartTLS
	// upgrades the plain 389 connection. TLS_OPTIONS supplies the CA, the client
	// certificate (mutual TLS) and whether the server cert is verified.
	if tlsMode == "starttls" {
		b.WriteString("    setenv USE_STARTTLS     = \"1\"\n")
	}
	if tlsMode == "ldaps" || tlsMode == "starttls" {
		fmt.Fprintf(&b, "    setenv TLS_OPTIONS      = \"%s\"\n", mavisTLSOptions(s.LdapTLSVerify))
	}
	b.WriteString(`
    exec = /usr/local/lib/mavis/mavis_tacplus-ng_ldap.pl
}

login backend = mavis
user backend  = mavis
pap backend   = mavis

cache timeout       = 86400
mavis cache timeout = 86400
`)
	return b.String()
}

// ---------------------------------------------------------------------------
// mavis include toggle in tac_plus-ng.cfg
// ---------------------------------------------------------------------------

var reMavisInclude = regexp.MustCompile(`(?m)^(\s*)(#\s*)?(include\s*=\s*/etc/tac_plus-ng/conf\.d/03-mavis\.cfg)\s*$`)

// MavisIncludeEnabled reports whether the mavis include is active (uncommented).
func MavisIncludeEnabled(mainCfg string) bool {
	m := reMavisInclude.FindStringSubmatch(mainCfg)
	return m != nil && m[2] == ""
}

// SetMavisInclude comments/uncomments the 03-mavis.cfg include line.
func SetMavisInclude(mainCfg string, enabled bool) string {
	return reMavisInclude.ReplaceAllStringFunc(mainCfg, func(line string) string {
		m := reMavisInclude.FindStringSubmatch(line)
		if enabled {
			return m[1] + m[3]
		}
		return m[1] + "# " + m[3]
	})
}

// ---------------------------------------------------------------------------
// Listener port + TLS in tac_plus-ng.cfg
// ---------------------------------------------------------------------------

// The plain (non-TLS) listener is the first `port = N` inside a listen block.
var rePlainPort = regexp.MustCompile(`(?m)^(\s*)port = \d+(\s*)$`)

// ParseListenPort returns the plain listener port from tac_plus-ng.cfg.
func ParseListenPort(mainCfg string) string {
	if m := rePlainPort.FindStringSubmatch(mainCfg); m != nil {
		p := regexp.MustCompile(`\d+`).FindString(m[0])
		return p
	}
	return "49"
}

// SetListenPort rewrites the first (plain) listener port.
func SetListenPort(mainCfg, port string) string {
	done := false
	return rePlainPort.ReplaceAllStringFunc(mainCfg, func(line string) string {
		if done {
			return line
		}
		done = true
		m := rePlainPort.FindStringSubmatch(line)
		return m[1] + "port = " + port + m[2]
	})
}

// TLS listener block + include are commented in the shipped config; the
// entrypoint uncomments them when ENABLE_TLS=true. The agent toggles them
// directly so it works via config + restart.
var reTLSInclude = regexp.MustCompile(`(?m)^(\s*)(#\s*)?(include\s*=\s*/etc/tac_plus-ng/conf\.d/09-tls\.cfg)\s*$`)
var reTLSListen = regexp.MustCompile(`(?ms)^(\s*)(#\s*)?listen = \{\s*\n\s*(#\s*)?address = 0\.0\.0\.0\s*\n\s*(#\s*)?port = 300\s*\n\s*(#\s*)?tls = yes\s*\n\s*(#\s*)?\}`)

// TLSEnabled reports whether the TLS include is active.
func TLSEnabled(mainCfg string) bool {
	m := reTLSInclude.FindStringSubmatch(mainCfg)
	return m != nil && m[2] == ""
}

// SetTLS toggles both the TLS listen block and the 09-tls include.
func SetTLS(mainCfg string, enabled bool) string {
	c := reTLSInclude.ReplaceAllStringFunc(mainCfg, func(line string) string {
		m := reTLSInclude.FindStringSubmatch(line)
		if enabled {
			return m[1] + m[3]
		}
		return m[1] + "# " + m[3]
	})
	c = reTLSListen.ReplaceAllStringFunc(c, func(block string) string {
		ind := "    "
		if enabled {
			return ind + "listen = {\n" + ind + ind + "address = 0.0.0.0\n" + ind + ind + "port = 300\n" + ind + ind + "tls = yes\n" + ind + "}"
		}
		return ind + "# listen = {\n" + ind + "#     address = 0.0.0.0\n" + ind + "#     port = 300\n" + ind + "#     tls = yes\n" + ind + "# }"
	})
	return c
}

// ---------------------------------------------------------------------------
// agent-overrides.env (TZ + log rotation, sourced by the entrypoint)
// ---------------------------------------------------------------------------

func overrideVal(src, key string) string {
	re := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(key) + `=(.*)$`)
	if m := re.FindStringSubmatch(src); m != nil {
		return strings.Trim(strings.TrimSpace(m[1]), `"`)
	}
	return ""
}

// ParseOverrides reads TZ / log-rotation from agent-overrides.env into s.
func ParseOverrides(src string, s *model.ServerSettings) {
	if tz := overrideVal(src, "TZ"); tz != "" {
		s.Timezone = tz
	}
	// Default enabled unless explicitly "false".
	s.Logrotate = !strings.EqualFold(overrideVal(src, "ENABLE_LOGROTATE"), "false")
	s.MonthlyArchive = !strings.EqualFold(overrideVal(src, "ENABLE_MONTHLY_ARCHIVE"), "false")
}

// shellQuote single-quotes a value for the agent-overrides.env file, which the
// entrypoint sources with `. file`. Single quotes stop the shell from
// interpreting $, backticks, spaces etc. in LDAP DNs/passwords.
func shellQuote(v string) string {
	return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'"
}

// RenderOverrides writes agent-overrides.env. Besides TZ / log rotation, it
// carries the LDAP enable flag and core LDAP vars: the entrypoint activates the
// MAVIS backend (and spawns its helper process) ONLY when ENABLE_LDAP=true at
// (re)start, and validates these vars — a SIGHUP alone never starts MAVIS. The
// mavis runtime still reads its real config from 03-mavis.cfg's setenv lines.
func RenderOverrides(s model.ServerSettings) string {
	b := func(v bool) string {
		if v {
			return "true"
		}
		return "false"
	}
	var sb strings.Builder
	sb.WriteString("# Managed by soteria-agent - applied on container restart\n")
	fmt.Fprintf(&sb, "TZ=%s\n", s.Timezone)
	fmt.Fprintf(&sb, "ENABLE_LOGROTATE=%s\n", b(s.Logrotate))
	fmt.Fprintf(&sb, "ENABLE_MONTHLY_ARCHIVE=%s\n", b(s.MonthlyArchive))
	fmt.Fprintf(&sb, "ENABLE_LDAP=%s\n", b(s.LdapEnabled))
	if s.LdapEnabled {
		fmt.Fprintf(&sb, "LDAP_SERVER_TYPE=%s\n", shellQuote(s.LdapServerType))
		fmt.Fprintf(&sb, "LDAP_HOSTS=%s\n", shellQuote(s.LdapHosts))
		fmt.Fprintf(&sb, "LDAP_USER=%s\n", shellQuote(s.LdapUser))
		fmt.Fprintf(&sb, "LDAP_PASSWD=%s\n", shellQuote(s.LdapPassword))
		fmt.Fprintf(&sb, "LDAP_BASE=%s\n", shellQuote(s.LdapBase))
		fmt.Fprintf(&sb, "LDAP_BASE_GROUP=%s\n", shellQuote(s.LdapBaseGroup))
		fmt.Fprintf(&sb, "LDAP_FILTER=%s\n", shellQuote(s.LdapFilter))
		fmt.Fprintf(&sb, "LDAP_FILTER_GROUP=%s\n", shellQuote(s.LdapFilterGroup))
		fmt.Fprintf(&sb, "LDAP_TACMEMBER=%s\n", shellQuote(s.LdapTacMember))
		fmt.Fprintf(&sb, "LDAP_CONNECT_TIMEOUT=%s\n", shellQuote(s.LdapConnectTimeout))
	}
	return sb.String()
}
