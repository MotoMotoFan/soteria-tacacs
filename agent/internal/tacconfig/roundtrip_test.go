package tacconfig

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/Pathfinder-Insights/soteria-agent/internal/model"
)

// The shipped default configs (testdata/ mirrors soteria/config/conf.d)
// must survive parse -> render -> parse with identical entities. This is
// the contract that lets the agent take over hand-written config files.

func read(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func mustEqual(t *testing.T, what string, a, b any) {
	t.Helper()
	if !reflect.DeepEqual(a, b) {
		aj, _ := json.MarshalIndent(a, "", "  ")
		bj, _ := json.MarshalIndent(b, "", "  ")
		t.Fatalf("%s round trip mismatch:\nfirst parse:\n%s\nsecond parse:\n%s", what, aj, bj)
	}
}

const testGlobalKey = "test-global-key"

func TestDevicesRoundTrip(t *testing.T) {
	// The shipped file still has the ${TACACS_KEY} placeholder; the parser
	// treats it as the global key.
	first, err := ParseDevices(read(t, "04-devices.cfg"), testGlobalKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 || first[0].Name != "all" || first[0].KeyType != "global" || first[0].Address != "0.0.0.0/0" {
		t.Fatalf("unexpected parse of shipped devices: %+v", first)
	}
	second, err := ParseDevices(RenderDevices(first, nil, testGlobalKey), testGlobalKey)
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, "devices", first, second)
}

func TestDevicesCatchAllRenderedLast(t *testing.T) {
	devices := []model.Device{
		{Name: "all", Address: "0.0.0.0/0", KeyType: "global"},
		{Name: "core-sw-01", Address: "10.0.1.1/32", Platform: "Cisco IOS-XE", KeyType: "custom", Key: "secret1"},
	}
	parsed, err := ParseDevices(RenderDevices(devices, nil, testGlobalKey), testGlobalKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed) != 2 || parsed[1].Name != "all" {
		t.Fatalf("catch-all not rendered last: %+v", parsed)
	}
	if parsed[0].Platform != "Cisco IOS-XE" {
		t.Fatalf("platform annotation lost: %+v", parsed[0])
	}
	if parsed[0].KeyType != "custom" || parsed[0].Key != "secret1" {
		t.Fatalf("custom key lost: %+v", parsed[0])
	}
}

func TestDeviceGroupsRoundTrip(t *testing.T) {
	groups := []model.DeviceGroup{
		{Name: "core-switches", Description: "Core network", KeyType: "custom", Key: "coreKey"},
		{Name: "branch", KeyType: "global"},
	}
	devices := []model.Device{
		{Name: "core-sw-01", Address: "10.0.1.1/32", Group: "core-switches", KeyType: "group", LastSeen: "-", Status: "unknown"},
		{Name: "br-sw-01", Address: "10.1.0.1/32", Group: "branch", KeyType: "custom", Key: "brKey", LastSeen: "-", Status: "unknown"},
		{Name: "all", Address: "0.0.0.0/0", KeyType: "global", LastSeen: "-", Status: "unknown"},
	}
	rendered := RenderDevices(devices, groups, testGlobalKey)

	gotGroups, err := ParseDeviceGroups(rendered, testGlobalKey)
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, "device groups", groups, gotGroups)

	gotDevices, err := ParseDevices(rendered, testGlobalKey)
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, "devices with groups", devices, gotDevices)
}

func TestUsersRoundTrip(t *testing.T) {
	first, err := ParseUsers(read(t, "05-local-users.cfg"))
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].Name != "network_admin" || first[0].Group != "tacacs_admin" {
		t.Fatalf("unexpected parse of shipped users: %+v", first)
	}
	if first[0].Hash == "" || first[0].Hash[0] != '$' {
		t.Fatalf("hash not extracted: %+v", first[0])
	}
	second, err := ParseUsers(RenderUsers(first))
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, "users", first, second)
}

func TestGroupsRoundTrip(t *testing.T) {
	first, err := ParseGroups(read(t, "06-groups.cfg"))
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].Name != "tacacs_admin" {
		t.Fatalf("unexpected parse of shipped groups: %+v", first)
	}
	second, err := ParseGroups(RenderGroups(first))
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, "groups", first, second)
}

func TestProfilesRoundTrip(t *testing.T) {
	first, err := ParseProfiles(read(t, "07-profiles.cfg"))
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 {
		t.Fatalf("expected 2 profiles, got %d", len(first))
	}
	admin := first[0]
	if admin.Name != "tacacs_admin" || admin.DefaultAction != "deny" {
		t.Fatalf("unexpected admin profile: %+v", admin)
	}
	if len(admin.Services) != 1 || admin.Services[0].Service != "shell" || admin.Services[0].DefaultAction != "permit" {
		t.Fatalf("unexpected admin service: %+v", admin.Services)
	}
	conds := admin.Services[0].Conditions
	if len(conds) != 1 || conds[0].Attribute != "cmd" || conds[0].Value != "" || conds[0].DefaultAction != "permit" {
		t.Fatalf("unexpected admin condition: %+v", conds)
	}
	if len(conds[0].Actions) != 1 || conds[0].Actions[0] != "set priv-lvl = 15" {
		t.Fatalf("set action not preserved: %+v", conds[0].Actions)
	}
	second, err := ParseProfiles(RenderProfiles(first))
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, "profiles", first, second)
}

func TestProfilesInlineCondition(t *testing.T) {
	profiles := []model.Profile{{
		Name:          "ops",
		DefaultAction: "deny",
		Services: []model.ServiceRule{{
			Service: "shell",
			Actions: []string{},
			Conditions: []model.ConditionRule{{
				Attribute: "cmd", Operator: "=~", Value: "/show.*/",
				Actions: []string{}, Inline: true, InlineAction: "permit",
			}},
			DefaultAction: "deny",
		}},
	}}
	parsed, err := ParseProfiles(RenderProfiles(profiles))
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, "inline profiles", profiles, parsed)
}

func TestRulesetRoundTrip(t *testing.T) {
	first, err := ParseRuleset(read(t, "08-ruleset.cfg"))
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 {
		t.Fatalf("expected 1 rule block, got %d", len(first))
	}
	r := first[0]
	if !r.Enabled || r.DefaultAction != "deny" || len(r.Matches) != 2 {
		t.Fatalf("unexpected rule block: %+v", r)
	}
	m := r.Matches[0]
	if m.Attribute != "member" || m.Value != "tacacs_admin" || m.DefaultAction != "permit" {
		t.Fatalf("unexpected first match: %+v", m)
	}
	if len(m.Actions) != 1 || m.Actions[0] != "profile = tacacs_admin" {
		t.Fatalf("profile action not preserved: %+v", m.Actions)
	}
	second, err := ParseRuleset(RenderRuleset(first))
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, "ruleset", first, second)
}

func TestRulesetWithElseAndChildren(t *testing.T) {
	rules := []model.Rule{{
		Enabled:       true,
		DefaultAction: "deny",
		Matches: []model.RuleCondition{{
			Attribute: "member", Operator: "==", Value: "netops",
			Actions: []string{"profile = netops"},
			Children: []model.RuleCondition{{
				Attribute: "nas", Operator: "==", Value: "10.0.1.1",
				Actions: []string{}, Children: []model.RuleCondition{}, ElseActions: []string{},
				DefaultAction: "permit",
			}},
			ElseActions:   []string{"message = \"access denied\""},
			ElseAction:    "deny",
			DefaultAction: "permit",
		}},
	}}
	parsed, err := ParseRuleset(RenderRuleset(rules))
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, "nested ruleset", rules, parsed)
}
