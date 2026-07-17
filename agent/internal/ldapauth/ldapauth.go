// Package ldapauth provides connectivity and credential tests for an LDAP
// directory, used by the Settings > Authentication > LDAP panel to validate a
// config before it is relied on. It does not persist anything.
package ldapauth

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// Config is the subset of LDAP settings needed to bind and search.
type Config struct {
	Host         string
	Port         string
	UseTLS       bool
	BaseDN       string
	BindDN       string
	BindPassword string
	UserFilter   string // e.g. (uid=%s); %s is replaced by the username
	GroupBaseDN  string
	// ServerType selects the group-resolution style when MemberAttr is unset:
	// "microsoft" (Active Directory) defaults to the memberOf attribute; any
	// other value ("generic"/OpenLDAP) uses the reverse group search.
	ServerType string
	// GroupFilter is the reverse group-search filter (LDAP_FILTER_GROUP); %s is
	// replaced by the authenticated user's DN. Empty falls back to the
	// OpenLDAP-friendly default (&(objectclass=groupOfNames)(member=%s)).
	GroupFilter string
	// MemberAttr (LDAP_TACMEMBER) is the user attribute holding group DNs, used
	// instead of a reverse search when set (e.g. memberOf on AD).
	MemberAttr string
	// ConnectTimeout is the dial/bind timeout in seconds. Empty/invalid uses
	// the 5s default so an unreachable directory fails fast (important for the
	// periodic Dashboard health probe) rather than hanging the request.
	ConnectTimeout string

	// --- TLS ---
	// TLSMode is "none", "ldaps" or "starttls". Empty falls back to UseTLS
	// (legacy field) so older saved configs keep working.
	TLSMode string
	// TLSVerify turns on server certificate validation. When false the cert is
	// accepted unverified (lab self-signed); when true CAFile (or the system
	// roots) must validate it and the hostname must match.
	TLSVerify bool
	// CAFile validates the directory's server certificate. Empty = system roots.
	CAFile string
	// ClientCertFile / ClientKeyFile enable mutual TLS, required by directories
	// configured with `olcTLSVerifyClient: demand`.
	ClientCertFile string
	ClientKeyFile  string
}

// tlsMode resolves the effective TLS mode, honouring the legacy UseTLS bool.
func (c Config) tlsMode() string {
	switch m := strings.ToLower(strings.TrimSpace(c.TLSMode)); m {
	case "ldaps", "starttls", "none":
		return m
	}
	if c.UseTLS {
		return "ldaps"
	}
	return "none"
}

// tlsConfig builds the TLS settings: optional CA pinning, optional client
// certificate (mutual TLS), and verification controlled by TLSVerify.
func (c Config) tlsConfig() (*tls.Config, error) {
	cfg := &tls.Config{
		ServerName:         strings.TrimSpace(c.Host),
		InsecureSkipVerify: !c.TLSVerify, //nolint:gosec // opt-in verification; lab certs are self-signed
		MinVersion:         tls.VersionTLS12,
	}
	if f := strings.TrimSpace(c.CAFile); f != "" {
		pem, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("read CA certificate: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("CA certificate %s contains no usable PEM certificate", f)
		}
		cfg.RootCAs = pool
	}
	crt, key := strings.TrimSpace(c.ClientCertFile), strings.TrimSpace(c.ClientKeyFile)
	if (crt == "") != (key == "") {
		return nil, fmt.Errorf("mutual TLS needs both a client certificate and a client key")
	}
	if crt != "" {
		pair, err := tls.LoadX509KeyPair(crt, key)
		if err != nil {
			return nil, fmt.Errorf("load client certificate: %w", err)
		}
		cfg.Certificates = []tls.Certificate{pair}
	}
	return cfg, nil
}

// timeout returns the connect timeout, defaulting to 5s.
func (c Config) timeout() time.Duration {
	if n, err := strconv.Atoi(strings.TrimSpace(c.ConnectTimeout)); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return 5 * time.Second
}

// defaultGroupFilter is the OpenLDAP-friendly reverse group search used when no
// explicit group filter is configured. Mirrors the mavis LDAP script default.
const defaultGroupFilter = "(&(objectclass=groupOfNames)(member=%s))"

// memberAttr resolves the effective group-membership attribute: an explicit
// MemberAttr wins, otherwise Active Directory defaults to memberOf and every
// other directory (OpenLDAP) uses none (reverse search instead).
func (c Config) memberAttr() string {
	if a := strings.TrimSpace(c.MemberAttr); a != "" {
		return a
	}
	if strings.EqualFold(strings.TrimSpace(c.ServerType), "microsoft") {
		return "memberOf"
	}
	return ""
}

// groupFilter returns the reverse-search filter template (with %s), defaulting
// to the OpenLDAP groupOfNames/member form.
func (c Config) groupFilter() string {
	f := strings.TrimSpace(c.GroupFilter)
	if f == "" || !strings.Contains(f, "%s") {
		return defaultGroupFilter
	}
	return f
}

// cnFromDN pulls the CN value out of a group DN (e.g. CN=netadmins,OU=..) so a
// memberOf value renders as the bare group name.
func cnFromDN(dn string) string {
	for _, part := range strings.Split(dn, ",") {
		part = strings.TrimSpace(part)
		if len(part) > 3 && strings.EqualFold(part[:3], "cn=") {
			return part[3:]
		}
	}
	return dn
}

func (c Config) port() int {
	if p, err := strconv.Atoi(strings.TrimSpace(c.Port)); err == nil && p > 0 {
		return p
	}
	if c.tlsMode() == "ldaps" {
		return 636
	}
	return 389
}

func (c Config) dial() (*ldap.Conn, error) {
	if strings.TrimSpace(c.Host) == "" {
		return nil, fmt.Errorf("host is required")
	}
	mode := c.tlsMode()
	tlsCfg, err := c.tlsConfig()
	if err != nil {
		return nil, err
	}

	scheme := "ldap"
	if mode == "ldaps" {
		scheme = "ldaps"
	}
	addr := fmt.Sprintf("%s:%d", c.Host, c.port())
	conn, err := ldap.DialURL(scheme+"://"+addr,
		ldap.DialWithDialer(&net.Dialer{Timeout: c.timeout()}),
		ldap.DialWithTLSConfig(tlsCfg))
	if err != nil {
		return nil, err
	}
	// Bound bind/search too, so a server that accepts the socket then stalls
	// still fails within the timeout instead of hanging the request.
	conn.SetTimeout(c.timeout())

	// StartTLS upgrades the plaintext connection in place (port 389).
	if mode == "starttls" {
		if err := conn.StartTLS(tlsCfg); err != nil {
			conn.Close()
			return nil, fmt.Errorf("StartTLS failed: %w", err)
		}
	}
	return conn, nil
}

// TestConnection binds with the service account and reports how many user
// objects are visible, confirming host + credentials + base DN.
func TestConnection(c Config) (string, error) {
	conn, err := c.dial()
	if err != nil {
		return "", fmt.Errorf("connect failed: %w", err)
	}
	defer conn.Close()
	if err := conn.Bind(c.BindDN, c.BindPassword); err != nil {
		return "", fmt.Errorf("bind as %q failed: %w", c.BindDN, err)
	}
	if strings.TrimSpace(c.BaseDN) == "" {
		return "Bind succeeded.", nil
	}
	res, err := conn.Search(ldap.NewSearchRequest(
		c.BaseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 5, false,
		"(|(objectClass=inetOrgPerson)(objectClass=person))", []string{"dn"}, nil))
	if err != nil {
		return "", fmt.Errorf("bind ok but search under %q failed: %w", c.BaseDN, err)
	}
	return fmt.Sprintf("Bind succeeded. Found %d user object(s) under %s.", len(res.Entries), c.BaseDN), nil
}

// UserResult is the outcome of a user-login test.
type UserResult struct {
	OK          bool     `json:"ok"`
	DN          string   `json:"dn,omitempty"`
	Email       string   `json:"email,omitempty"`
	DisplayName string   `json:"displayName,omitempty"`
	Groups      []string `json:"groups"`
	Message     string   `json:"message"`
	// Trace is a human-readable step-by-step log of the bind/search flow, the
	// equivalent of the mavis perl script's debug output, surfaced in the
	// admin LDAP test UI.
	Trace []string `json:"trace,omitempty"`
}

// TestUser looks up a username with the service account, then binds as that
// user with the supplied password, and lists its groups. It records each step
// (and the exact expanded group filter) in the returned Trace.
func TestUser(c Config, username, password string) (UserResult, error) {
	var trace []string
	step := func(format string, args ...any) { trace = append(trace, fmt.Sprintf(format, args...)) }

	scheme := "ldap"
	if c.UseTLS {
		scheme = "ldaps"
	}
	step("connect %s://%s:%d", scheme, strings.TrimSpace(c.Host), c.port())
	conn, err := c.dial()
	if err != nil {
		return UserResult{Trace: trace}, fmt.Errorf("connect failed: %w", err)
	}
	defer conn.Close()
	if err := conn.Bind(c.BindDN, c.BindPassword); err != nil {
		step("service bind as %q FAILED", c.BindDN)
		return UserResult{Trace: trace}, fmt.Errorf("service bind failed: %w", err)
	}
	step("service bind as %q OK", c.BindDN)

	filter := strings.TrimSpace(c.UserFilter)
	if filter == "" || !strings.Contains(filter, "%s") {
		filter = "(uid=%s)"
	}
	filter = strings.ReplaceAll(filter, "%s", ldap.EscapeFilter(username))
	userAttrs := []string{"mail", "cn", "displayName", "sAMAccountName"}
	memberAttr := c.memberAttr()
	if memberAttr != "" {
		userAttrs = append(userAttrs, memberAttr)
	}
	step("user search %s under %s", filter, c.BaseDN)
	res, err := conn.Search(ldap.NewSearchRequest(
		c.BaseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 5, false,
		filter, userAttrs, nil))
	if err != nil {
		return UserResult{Trace: trace}, fmt.Errorf("user search failed: %w", err)
	}
	if len(res.Entries) == 0 {
		step("no entry matched")
		return UserResult{OK: false, Message: fmt.Sprintf("No user matched %s.", filter), Trace: trace}, nil
	}
	if len(res.Entries) > 1 {
		step("%d entries matched (must be unique)", len(res.Entries))
		return UserResult{OK: false, Message: fmt.Sprintf("Filter %s matched %d entries (must be unique).", filter, len(res.Entries)), Trace: trace}, nil
	}
	entry := res.Entries[0]
	userDN := entry.DN
	email := entry.GetAttributeValue("mail")
	display := entry.GetAttributeValue("displayName")
	if display == "" {
		display = entry.GetAttributeValue("cn")
	}
	step("matched dn: %s", userDN)

	// Bind as the user on a fresh connection to verify the password.
	uconn, err := c.dial()
	if err != nil {
		return UserResult{Trace: trace}, fmt.Errorf("connect failed: %w", err)
	}
	defer uconn.Close()
	if err := uconn.Bind(userDN, password); err != nil {
		step("user password bind FAILED")
		return UserResult{OK: false, DN: userDN, Email: email, Message: "User found, but the password is invalid.", Trace: trace}, nil
	}
	step("user password bind OK")

	groups := resolveGroups(conn, c, entry, userDN, step)

	step("RESULT: authenticated, groups=%v", groups)
	return UserResult{OK: true, DN: userDN, Email: email, DisplayName: display, Groups: groups, Message: "Authentication succeeded.", Trace: trace}, nil
}

// resolveGroups mirrors the mavis LDAP script's group logic: read the memberOf
// (or configured) attribute for Active Directory, otherwise run the reverse
// groupOfNames/member search under the group base DN. It records the exact
// attribute or expanded filter it used in the trace. If a configured
// membership attribute yields nothing (a common misconfiguration: putting a
// group-side attribute like "member" here), it falls back to the reverse
// search so OpenLDAP directories still resolve.
func resolveGroups(conn *ldap.Conn, c Config, entry *ldap.Entry, userDN string, step func(string, ...any)) []string {
	if memberAttr := c.memberAttr(); memberAttr != "" {
		dns := entry.GetAttributeValues(memberAttr)
		step("group source: user attribute %q -> %d value(s)", memberAttr, len(dns))
		if len(dns) > 0 {
			groups := make([]string, 0, len(dns))
			for _, dn := range dns {
				groups = append(groups, cnFromDN(dn))
			}
			return groups
		}
		step("attribute empty on user (is %q a group-side attribute?); trying reverse group search", memberAttr)
	}

	if strings.TrimSpace(c.GroupBaseDN) == "" {
		step("group source: reverse search skipped (no group base DN configured)")
		return nil
	}
	expanded := strings.ReplaceAll(c.groupFilter(), "%s", ldap.EscapeFilter(userDN))
	step("group filter: %s under %s", expanded, c.GroupBaseDN)
	gres, err := conn.Search(ldap.NewSearchRequest(
		c.GroupBaseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 5, false,
		expanded, []string{"cn"}, nil))
	if err != nil {
		step("group search error: %v", err)
		return nil
	}
	groups := make([]string, 0, len(gres.Entries))
	for _, e := range gres.Entries {
		if cn := e.GetAttributeValue("cn"); cn != "" {
			groups = append(groups, cn)
		}
	}
	step("reverse search matched %d group(s)", len(groups))
	return groups
}
