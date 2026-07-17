// Package model defines the JSON entity shapes exchanged with soteria-frontend.
// These are the single source of truth; the frontend's TypeScript interfaces
// (soteria-frontend/src/data/mock.ts and the page-local types in
// Profiles.tsx / Rulesets.tsx) mirror them field for field.
package model

type Device struct {
	Name     string `json:"name"`
	Address  string `json:"address"` // CIDR
	Platform string `json:"platform"`
	KeyType  string `json:"keyType"` // "global" | "custom" | "group" (inherited via parent)
	Key      string `json:"key,omitempty"`
	// Group is the parent device group (tac_plus-ng `parent = name`), if any.
	Group    string `json:"group,omitempty"`
	LastSeen string `json:"lastSeen"`
	Status   string `json:"status"` // "online" | "offline" | "unknown"
}

// DeviceGroup is rendered as an address-less device block that member
// devices reference via `parent = name` — members inherit its key and
// any other settings they don't define themselves.
type DeviceGroup struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	KeyType     string `json:"keyType"` // "global" | "custom"
	Key         string `json:"key,omitempty"`
	Members     int    `json:"members"` // derived, read-only
}

type User struct {
	Name       string `json:"name"`
	Group      string `json:"group"`
	AuthSource string `json:"authSource"` // "local" | "ldap"
	LastLogin  string `json:"lastLogin"`
	Status     string `json:"status"` // "active" | "locked" | "disabled"

	// Hash is the SHA-512 crypt hash from 05-local-users.cfg. Never serialized.
	Hash string `json:"-"`
	// Password is write-only input on PUT /api/users for new/changed passwords.
	Password string `json:"password,omitempty"`
}

type Group struct {
	Name    string `json:"name"`
	Members int    `json:"members"`
	Source  string `json:"source"` // "local" | "ldap"
	Profile string `json:"profile"`
}

// ConditionRule mirrors ConditionRule in Profiles.tsx.
type ConditionRule struct {
	Attribute     string   `json:"attribute"`
	Operator      string   `json:"operator"` // == != =~
	Value         string   `json:"value"`
	Actions       []string `json:"actions"`
	Inline        bool     `json:"inline"`
	InlineAction  string   `json:"inlineAction"`
	DefaultAction string   `json:"defaultAction"`
}

// ServiceRule mirrors ServiceRule in Profiles.tsx.
type ServiceRule struct {
	Service       string          `json:"service"`
	Actions       []string        `json:"actions"` // direct set actions (Juniper style)
	Conditions    []ConditionRule `json:"conditions"`
	DefaultAction string          `json:"defaultAction"`
}

type Profile struct {
	Name          string        `json:"name"`
	Services      []ServiceRule `json:"services"`
	DefaultAction string        `json:"defaultAction"`
}

// RuleCondition mirrors RuleCondition in Rulesets.tsx.
type RuleCondition struct {
	Attribute     string          `json:"attribute"`
	Operator      string          `json:"operator"`
	Value         string          `json:"value"`
	Actions       []string        `json:"actions"`
	Children      []RuleCondition `json:"children"`
	ElseActions   []string        `json:"elseActions"`
	ElseAction    string          `json:"elseAction"`
	DefaultAction string          `json:"defaultAction"`
}

// Rule is one rule {} block inside ruleset {}. Mirrors RuleForm in Rulesets.tsx.
type Rule struct {
	Enabled       bool            `json:"enabled"`
	Matches       []RuleCondition `json:"matches"`
	DefaultAction string          `json:"defaultAction"`
}

type LogEntry struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"` // authentication | authorization | accounting
	User      string `json:"user"`
	Device    string `json:"device"`
	DeviceIP  string `json:"deviceIp"`
	Result    string `json:"result"` // success | failure | error
	// Port is the NAS line/tty the session used (e.g. vty4, con0).
	Port string `json:"port,omitempty"`
	// Service is the TACACS+ service (shell, junos-exec, …) — authz/acct only.
	Service string `json:"service,omitempty"`
	// Command is the authorized/accounted command — authz/acct only.
	Command string `json:"command,omitempty"`
	Detail  string `json:"detail"`
}

// LoggingConfig models 01-logging.cfg. Daily file logs are always on
// (the web UI's log viewer reads them, fixed at RFC5424); remote syslog
// export is additive and its timestamp format is selectable.
type LoggingConfig struct {
	// FileLogEnabled controls the daily file logs (which the AAA Logs page
	// reads). Disabling it means logs go only to remote syslog.
	FileLogEnabled bool   `json:"fileLogEnabled"`
	SyslogEnabled  bool   `json:"syslogEnabled"`
	SyslogHost     string `json:"syslogHost"`
	SyslogPort     int    `json:"syslogPort"`
	// SyslogTimestamp is the wire format for the export block: "RFC3164"
	// (BSD syslog, what Wazuh prefers) or "RFC5424". Defaults to RFC3164.
	SyslogTimestamp string `json:"syslogTimestamp"`
}

type ConfigBackup struct {
	ID        string `json:"id"` // e.g. 20260706-193000
	Timestamp string `json:"timestamp"`
	Size      string `json:"size"`
	Files     int    `json:"files"`
}

type ConfigFile struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
}

// ServerSettings is the full set of TACACS+ server settings editable from
// the UI. Config-group fields (LDAP, DNS, shared key) apply live via a
// config reload; restart-group fields (listenPort, timezone, tls*,
// logrotate/monthlyArchive) require recreating the tac_plus container and
// are only applied when the user confirms the restart on commit.
type ServerSettings struct {
	// --- Config group (live via SIGHUP) ---
	SharedKey    string `json:"sharedKey,omitempty"` // write-only input
	SharedKeySet bool   `json:"sharedKeySet"`        // read-only marker

	LdapEnabled     bool   `json:"ldapEnabled"`
	LdapServerType  string `json:"ldapServerType"`
	LdapHosts       string `json:"ldapHosts"`
	LdapUser        string `json:"ldapUser"`
	LdapPassword    string `json:"ldapPassword,omitempty"` // write-only input
	LdapPasswordSet bool   `json:"ldapPasswordSet"`
	LdapBase        string `json:"ldapBase"`
	LdapFilter      string `json:"ldapFilter"`
	LdapBaseGroup   string `json:"ldapBaseGroup"`
	LdapFilterGroup string `json:"ldapFilterGroup"`
	LdapTacMember   string `json:"ldapTacMember"`
	LdapConnectTimeout string `json:"ldapConnectTimeout"`
	// LdapTLSMode is "none", "ldaps" or "starttls"; LdapTLSVerify enables
	// server-certificate validation against the uploaded CA.
	LdapTLSMode   string `json:"ldapTlsMode"`
	LdapTLSVerify bool   `json:"ldapTlsVerify"`

	DNSServer        string `json:"dnsServer"`
	DNSReverseLookup bool   `json:"dnsReverseLookup"`
	DNSTimeout       string `json:"dnsTimeout"`

	// --- Restart group (recreate required) ---
	ListenPort     string `json:"listenPort"`
	Timezone       string `json:"timezone"`
	TLSEnabled     bool   `json:"tlsEnabled"`
	TLSPort        string `json:"tlsPort"`
	Logrotate      bool   `json:"logrotate"`
	MonthlyArchive bool   `json:"monthlyArchive"`
}
