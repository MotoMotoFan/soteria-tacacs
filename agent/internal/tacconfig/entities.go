package tacconfig

import (
	"fmt"
	"strings"

	"github.com/Pathfinder-Insights/soteria-agent/internal/model"
)

// Annotation comments carry UI metadata the tac_plus-ng grammar has no field
// for (e.g. device platform). They live INSIDE the entity block:
//
//	device core-sw-01 {
//	    # @platform Cisco IOS-XE
//	    address = 10.0.1.1/32
//	    ...
//	}
func annotation(comments []comment, startLine, endLine int, key string) string {
	prefix := "@" + key + " "
	for _, c := range comments {
		if c.line >= startLine && (endLine == 0 || c.line <= endLine) && strings.HasPrefix(c.text, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(c.text, prefix))
		}
	}
	return ""
}

func stripQuotes(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`) {
		return s[1 : len(s)-1]
	}
	return s
}

func isTerminalAction(s string) bool { return s == "permit" || s == "deny" }

func assignValue(children []*node, key string) string {
	for _, c := range children {
		if c.kind == nAssign && c.name == key {
			return c.value
		}
	}
	return ""
}

// ParseDevices reads 04-devices.cfg content. globalKey is the shared
// TACACS_KEY from the environment; a device whose key matches it is
// reported as keyType "global". Device blocks WITHOUT an address are
// device groups (parents), not devices — see ParseDeviceGroups.
func ParseDevices(src, globalKey string) ([]model.Device, error) {
	nodes, comments, err := parse(src)
	if err != nil {
		return nil, err
	}
	devices := []model.Device{}
	for _, n := range nodes {
		if n.kind != nBlock || n.name != "device" {
			continue
		}
		address := assignValue(n.children, "address")
		if address == "" {
			continue // group block
		}
		key := stripQuotes(assignValue(n.children, "key"))
		d := model.Device{
			Name:     n.label,
			Address:  address,
			Platform: annotation(comments, n.startLine, n.endLine, "platform"),
			Group:    assignValue(n.children, "parent"),
			KeyType:  "custom",
			Key:      key,
			LastSeen: "-",
			Status:   "unknown",
		}
		switch {
		case key == globalKey || key == "${TACACS_KEY}":
			d.KeyType = "global"
			d.Key = ""
		case key == "" && d.Group != "":
			d.KeyType = "group" // inherits the parent group's key
		}
		devices = append(devices, d)
	}
	return devices, nil
}

// ParseDeviceGroups reads the address-less device blocks from
// 04-devices.cfg. Member counts are filled in by the API layer.
func ParseDeviceGroups(src, globalKey string) ([]model.DeviceGroup, error) {
	nodes, comments, err := parse(src)
	if err != nil {
		return nil, err
	}
	groups := []model.DeviceGroup{}
	for _, n := range nodes {
		if n.kind != nBlock || n.name != "device" {
			continue
		}
		if assignValue(n.children, "address") != "" {
			continue // real device
		}
		key := stripQuotes(assignValue(n.children, "key"))
		g := model.DeviceGroup{
			Name:        n.label,
			Description: annotation(comments, n.startLine, n.endLine, "description"),
			KeyType:     "custom",
			Key:         key,
		}
		if key == globalKey || key == "${TACACS_KEY}" {
			g.KeyType = "global"
			g.Key = ""
		}
		groups = append(groups, g)
	}
	return groups, nil
}

// ParseUsers reads 05-local-users.cfg content. Hashes are kept internally
// (model.User.Hash is never serialized to JSON).
func ParseUsers(src string) ([]model.User, error) {
	nodes, comments, err := parse(src)
	if err != nil {
		return nil, err
	}
	users := []model.User{}
	for _, n := range nodes {
		if n.kind != nBlock || n.name != "user" {
			continue
		}
		u := model.User{
			Name:       n.label,
			Group:      assignValue(n.children, "member"),
			AuthSource: "local",
			LastLogin:  "-",
			Status:     "active",
		}
		// password login = crypt "$6$..."
		login := assignValue(n.children, "password login")
		if fields := strings.Fields(login); len(fields) == 2 && fields[0] == "crypt" {
			u.Hash = stripQuotes(fields[1])
		}
		if s := annotation(comments, n.startLine, n.endLine, "status"); s != "" {
			u.Status = s
		}
		users = append(users, u)
	}
	return users, nil
}

// ParseGroups reads 06-groups.cfg content. Members count and profile mapping
// are filled in by the API layer from users + ruleset.
func ParseGroups(src string) ([]model.Group, error) {
	nodes, comments, err := parse(src)
	if err != nil {
		return nil, err
	}
	groups := []model.Group{}
	for _, n := range nodes {
		if n.kind != nBlock || n.name != "group" {
			continue
		}
		g := model.Group{Name: n.label, Source: "local"}
		if s := annotation(comments, n.startLine, n.endLine, "source"); s == "ldap" {
			g.Source = "ldap"
		}
		groups = append(groups, g)
	}
	return groups, nil
}

// ParseProfiles reads 07-profiles.cfg content into the nested structure the
// frontend's Profiles page edits (services -> actions/conditions).
func ParseProfiles(src string) ([]model.Profile, error) {
	nodes, _, err := parse(src)
	if err != nil {
		return nil, err
	}
	profiles := []model.Profile{}
	for _, n := range nodes {
		if n.kind != nBlock || n.name != "profile" {
			continue
		}
		p := model.Profile{Name: n.label, Services: []model.ServiceRule{}}
		script := findBlock(n.children, "script")
		if script == nil {
			profiles = append(profiles, p)
			continue
		}
		for _, st := range script.children {
			switch {
			case st.kind == nIf && st.cond != nil && st.cond.attr == "service":
				p.Services = append(p.Services, serviceFromNode(st))
			case st.kind == nAction || st.kind == nAssign:
				if isTerminalAction(st.actionText()) {
					p.DefaultAction = st.actionText()
				}
			}
		}
		profiles = append(profiles, p)
	}
	return profiles, nil
}

func serviceFromNode(n *node) model.ServiceRule {
	svc := model.ServiceRule{
		Service:    n.cond.value,
		Actions:    []string{},
		Conditions: []model.ConditionRule{},
	}
	var actions []string
	for _, st := range n.children {
		if st.kind == nIf {
			svc.Conditions = append(svc.Conditions, conditionFromNode(st))
			continue
		}
		actions = append(actions, st.actionText())
	}
	// A trailing bare permit/deny is the service default action.
	if len(actions) > 0 && isTerminalAction(actions[len(actions)-1]) {
		svc.DefaultAction = actions[len(actions)-1]
		actions = actions[:len(actions)-1]
	}
	svc.Actions = append(svc.Actions, actions...)
	return svc
}

func conditionFromNode(n *node) model.ConditionRule {
	c := model.ConditionRule{
		Attribute: n.cond.attr,
		Operator:  n.cond.op,
		Value:     condValue(n.cond),
		Actions:   []string{},
	}
	if n.inline {
		c.Inline = true
		if len(n.children) == 1 {
			c.InlineAction = n.children[0].actionText()
		}
		return c
	}
	var actions []string
	for _, st := range n.children {
		actions = append(actions, st.actionText())
	}
	if len(actions) > 0 && isTerminalAction(actions[len(actions)-1]) {
		c.DefaultAction = actions[len(actions)-1]
		actions = actions[:len(actions)-1]
	}
	c.Actions = append(c.Actions, actions...)
	return c
}

// ParseRuleset reads 08-ruleset.cfg content into rule blocks matching the
// frontend's Rulesets page structure. Never flattened: each rule {} block
// keeps its own conditions.
func ParseRuleset(src string) ([]model.Rule, error) {
	nodes, _, err := parse(src)
	if err != nil {
		return nil, err
	}
	rules := []model.Rule{}
	rs := findBlock(nodes, "ruleset")
	if rs == nil {
		return rules, nil
	}
	for _, rn := range rs.children {
		if rn.kind != nBlock || rn.name != "rule" {
			continue
		}
		r := model.Rule{
			Enabled: assignValue(rn.children, "enabled") != "no",
			Matches: []model.RuleCondition{},
		}
		script := findBlock(rn.children, "script")
		if script != nil {
			for _, st := range script.children {
				switch {
				case st.kind == nIf:
					r.Matches = append(r.Matches, ruleConditionFromNode(st))
				case st.kind == nAction || st.kind == nAssign:
					if isTerminalAction(st.actionText()) {
						r.DefaultAction = st.actionText()
					}
				}
			}
		}
		rules = append(rules, r)
	}
	return rules, nil
}

func ruleConditionFromNode(n *node) model.RuleCondition {
	rc := model.RuleCondition{
		Attribute:   n.cond.attr,
		Operator:    n.cond.op,
		Value:       condValue(n.cond),
		Actions:     []string{},
		Children:    []model.RuleCondition{},
		ElseActions: []string{},
	}
	var actions []string
	for _, st := range n.children {
		if st.kind == nIf {
			rc.Children = append(rc.Children, ruleConditionFromNode(st))
			continue
		}
		actions = append(actions, st.actionText())
	}
	if len(actions) > 0 && isTerminalAction(actions[len(actions)-1]) {
		rc.DefaultAction = actions[len(actions)-1]
		actions = actions[:len(actions)-1]
	}
	rc.Actions = append(rc.Actions, actions...)

	var elseActions []string
	for _, st := range n.elseNodes {
		elseActions = append(elseActions, st.actionText())
	}
	if len(elseActions) > 0 && isTerminalAction(elseActions[len(elseActions)-1]) {
		rc.ElseAction = elseActions[len(elseActions)-1]
		elseActions = elseActions[:len(elseActions)-1]
	}
	rc.ElseActions = append(rc.ElseActions, elseActions...)
	return rc
}

func condValue(c *cond) string {
	if c.quoted {
		return stripQuotes(c.value)
	}
	return c.value
}

func findBlock(nodes []*node, name string) *node {
	for _, n := range nodes {
		if n.kind == nBlock && n.name == name {
			return n
		}
	}
	return nil
}

// ValidateEntityName rejects names that would break the config grammar.
func ValidateEntityName(kind, name string) error {
	if name == "" {
		return fmt.Errorf("%s name must not be empty", kind)
	}
	if strings.ContainsAny(name, " \t\n\"{}()=#") {
		return fmt.Errorf("%s name %q contains characters not allowed in config identifiers", kind, name)
	}
	return nil
}
