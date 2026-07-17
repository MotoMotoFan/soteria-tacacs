package tacconfig

import (
	"fmt"
	"sort"
	"strings"

	"github.com/Pathfinder-Insights/soteria-agent/internal/model"
)

func banner(file, title string) string {
	line := strings.Repeat("=", 77)
	return fmt.Sprintf(`# %s
# %s - %s
# %s
# Company:    Pathfinder Insights
# Project:    Soteria AAA Infrastructure
# Managed by: soteria-agent - manual edits are overwritten on the next commit
# %s

`, line, file, title, line, line)
}

// RenderDevices writes 04-devices.cfg: device groups first (parents must
// exist before members reference them), then devices, catch-all last.
// Devices with keyType "global" get the literal shared key (envsubst only
// runs at container start, so placeholders written now would be read
// verbatim by tac_plus-ng on SIGHUP reload); keyType "group" devices write
// no key at all and inherit the parent group's. The catch-all block
// (address /0) is always rendered last: tac_plus-ng matches devices in
// order and a catch-all above a specific device would shadow its key.
func RenderDevices(devices []model.Device, groups []model.DeviceGroup, globalKey string) string {
	var b strings.Builder
	b.WriteString(banner("04-devices.cfg", "Network devices (NAS) definitions"))

	for _, g := range groups {
		key := g.Key
		if g.KeyType != "custom" {
			key = globalKey
		}
		b.WriteString(fmt.Sprintf("device %s {\n", g.Name))
		if g.Description != "" {
			b.WriteString(fmt.Sprintf("    # @description %s\n", g.Description))
		}
		b.WriteString(fmt.Sprintf("    key = \"%s\"\n", key))
		b.WriteString("}\n\n")
	}

	ordered := make([]model.Device, 0, len(devices))
	var catchAll []model.Device
	for _, d := range devices {
		if strings.HasSuffix(d.Address, "/0") {
			catchAll = append(catchAll, d)
		} else {
			ordered = append(ordered, d)
		}
	}
	ordered = append(ordered, catchAll...)

	for _, d := range ordered {
		b.WriteString(fmt.Sprintf("device %s {\n", d.Name))
		if d.Platform != "" {
			b.WriteString(fmt.Sprintf("    # @platform %s\n", d.Platform))
		}
		b.WriteString(fmt.Sprintf("    address = %s\n", d.Address))
		if d.Group != "" {
			b.WriteString(fmt.Sprintf("    parent  = %s\n", d.Group))
		}
		switch d.KeyType {
		case "custom":
			b.WriteString(fmt.Sprintf("    key     = \"%s\"\n", d.Key))
		case "group":
			// no key: inherited from parent
		default:
			b.WriteString(fmt.Sprintf("    key     = \"%s\"\n", globalKey))
		}
		b.WriteString("}\n\n")
	}
	return b.String()
}

// RenderUsers writes 05-local-users.cfg. Hashes must already be resolved
// (SHA-512 crypt); plaintext never reaches this function.
func RenderUsers(users []model.User) string {
	var b strings.Builder
	b.WriteString(banner("05-local-users.cfg", "Local fallback and service account users"))
	for _, u := range users {
		b.WriteString(fmt.Sprintf("user %s {\n", u.Name))
		if u.Status != "" && u.Status != "active" {
			b.WriteString(fmt.Sprintf("    # @status %s\n", u.Status))
		}
		b.WriteString(fmt.Sprintf("    password login = crypt \"%s\"\n", u.Hash))
		b.WriteString("    password pap   = login\n")
		if u.Group != "" {
			b.WriteString(fmt.Sprintf("    member         = %s\n", u.Group))
		}
		b.WriteString("}\n\n")
	}
	return b.String()
}

// RenderGroups writes 06-groups.cfg.
func RenderGroups(groups []model.Group) string {
	var b strings.Builder
	b.WriteString(banner("06-groups.cfg", "Group definitions"))
	width := 0
	for _, g := range groups {
		if len(g.Name) > width {
			width = len(g.Name)
		}
	}
	// LDAP-sourced groups keep their annotation so the source survives a
	// round trip; plain local groups stay one-liners.
	for _, g := range groups {
		if g.Source == "ldap" {
			b.WriteString(fmt.Sprintf("group %s {\n    # @source ldap\n}\n", g.Name))
		} else {
			b.WriteString(fmt.Sprintf("group %-*s { }\n", width, g.Name))
		}
	}
	b.WriteString("\n")
	return b.String()
}

// RenderProfiles writes 07-profiles.cfg in the same shape the frontend's
// live preview builds (Profiles.tsx buildProfileConfig).
func RenderProfiles(profiles []model.Profile) string {
	var b strings.Builder
	b.WriteString(banner("07-profiles.cfg", "Authorization profiles"))
	for _, p := range profiles {
		b.WriteString(fmt.Sprintf("profile %s {\n    script {\n", p.Name))
		for _, svc := range p.Services {
			b.WriteString(fmt.Sprintf("        if (service == %s) {\n", svc.Service))
			for _, a := range svc.Actions {
				if strings.TrimSpace(a) != "" {
					b.WriteString("            " + a + "\n")
				}
			}
			for _, c := range svc.Conditions {
				renderCondition(&b, c, "            ")
			}
			if svc.DefaultAction != "" {
				b.WriteString("            " + svc.DefaultAction + "\n")
			}
			b.WriteString("        }\n")
		}
		if p.DefaultAction != "" {
			b.WriteString("        " + p.DefaultAction + "\n")
		}
		b.WriteString("    }\n}\n\n")
	}
	return b.String()
}

func renderCondition(b *strings.Builder, c model.ConditionRule, indent string) {
	condStr := fmt.Sprintf("%s %s %s", c.Attribute, c.Operator, renderCondValue(c.Operator, c.Value))
	if c.Inline {
		b.WriteString(fmt.Sprintf("%sif (%s) %s\n", indent, condStr, c.InlineAction))
		return
	}
	b.WriteString(fmt.Sprintf("%sif (%s) {\n", indent, condStr))
	for _, a := range c.Actions {
		if strings.TrimSpace(a) != "" {
			b.WriteString(indent + "    " + a + "\n")
		}
	}
	if c.DefaultAction != "" {
		b.WriteString(indent + "    " + c.DefaultAction + "\n")
	}
	b.WriteString(indent + "}\n")
}

// RenderRuleset writes 08-ruleset.cfg. Structure is always
// ruleset { rule { ... } rule { ... } } - one script per rule block.
func RenderRuleset(rules []model.Rule) string {
	var b strings.Builder
	b.WriteString(banner("08-ruleset.cfg", "Authorization ruleset (top-down, first match wins)"))
	b.WriteString("ruleset {\n")
	for _, r := range rules {
		enabled := "yes"
		if !r.Enabled {
			enabled = "no"
		}
		b.WriteString("    rule {\n")
		b.WriteString(fmt.Sprintf("        enabled = %s\n", enabled))
		b.WriteString("        script {\n")
		for _, m := range r.Matches {
			renderRuleCondition(&b, m, "            ")
		}
		if r.DefaultAction != "" {
			b.WriteString("            " + r.DefaultAction + "\n")
		}
		b.WriteString("        }\n    }\n")
	}
	b.WriteString("}\n")
	return b.String()
}

func renderRuleCondition(b *strings.Builder, rc model.RuleCondition, indent string) {
	condStr := fmt.Sprintf("%s %s %s", rc.Attribute, rc.Operator, renderCondValue(rc.Operator, rc.Value))
	b.WriteString(fmt.Sprintf("%sif (%s) {\n", indent, condStr))
	for _, a := range rc.Actions {
		if strings.TrimSpace(a) != "" {
			b.WriteString(indent + "    " + a + "\n")
		}
	}
	for _, child := range rc.Children {
		renderRuleCondition(b, child, indent+"    ")
	}
	if rc.DefaultAction != "" {
		b.WriteString(indent + "    " + rc.DefaultAction + "\n")
	}
	if len(rc.ElseActions) > 0 || rc.ElseAction != "" {
		b.WriteString(indent + "} else {\n")
		for _, a := range rc.ElseActions {
			if strings.TrimSpace(a) != "" {
				b.WriteString(indent + "    " + a + "\n")
			}
		}
		if rc.ElseAction != "" {
			b.WriteString(indent + "    " + rc.ElseAction + "\n")
		}
	}
	b.WriteString(indent + "}\n")
}

// renderCondValue decides quoting: regex matches stay bare (/show.*/),
// empty strings and values with whitespace are quoted, identifiers stay bare.
func renderCondValue(op, v string) string {
	if op == "=~" {
		return v
	}
	if v == "" || strings.ContainsAny(v, " \t") {
		return `"` + v + `"`
	}
	return v
}

// SortDevicesForDisplay returns devices in render order (catch-all last)
// without mutating the input.
func SortDevicesForDisplay(devices []model.Device) []model.Device {
	out := append([]model.Device(nil), devices...)
	sort.SliceStable(out, func(i, j int) bool {
		return !strings.HasSuffix(out[i].Address, "/0") && strings.HasSuffix(out[j].Address, "/0")
	})
	return out
}
