package tacconfig

import (
	"fmt"
	"strings"
)

type nodeKind int

const (
	nBlock nodeKind = iota // device NAME { ... }, script { ... }, ruleset { ... }
	nAssign                // key = value        (multiword keys: "password login")
	nAction                // permit / deny / bare statement
	nIf                    // if (attr op value) { ... } [else { ... }]  |  inline
)

type node struct {
	kind      nodeKind
	name      string // block type or assign key
	label     string // block label (device NAME)
	value     string // assign value / action text
	cond      *cond
	children  []*node
	elseNodes []*node
	inline    bool
	startLine int
	endLine   int
}

type cond struct {
	attr   string
	op     string
	value  string
	quoted bool // value was double-quoted in source
}

// actionText reconstructs the flat action string for a statement node,
// e.g. `set priv-lvl = 15` or `profile = tacacs_admin` or `permit`.
func (n *node) actionText() string {
	if n.kind == nAssign {
		return n.name + " = " + n.value
	}
	return n.value
}

type parser struct {
	toks []token
	pos  int
}

// parse builds a node tree from tac_plus-ng config source.
func parse(src string) ([]*node, []comment, error) {
	toks, comments := lex(src)
	p := &parser{toks: toks}
	nodes, _, err := p.parseStmts(false)
	return nodes, comments, err
}

func (p *parser) peek() token  { return p.toks[p.pos] }
func (p *parser) next() token  { t := p.toks[p.pos]; p.pos++; return t }

func (p *parser) expect(k tokKind, what string) (token, error) {
	t := p.next()
	if t.kind != k {
		return t, fmt.Errorf("line %d: expected %s, got %q", t.line, what, t.text)
	}
	return t, nil
}

// parseStmts parses statements until EOF or (when untilRBrace) a closing brace.
// Returns the nodes and the line of the closing brace (0 at EOF).
func (p *parser) parseStmts(untilRBrace bool) ([]*node, int, error) {
	var nodes []*node
	for {
		t := p.peek()
		switch {
		case t.kind == tEOF:
			if untilRBrace {
				return nodes, 0, fmt.Errorf("line %d: unexpected end of file, missing '}'", t.line)
			}
			return nodes, 0, nil
		case t.kind == tRBrace:
			if untilRBrace {
				p.next()
				return nodes, t.line, nil
			}
			return nodes, 0, fmt.Errorf("line %d: unexpected '}'", t.line)
		default:
			n, err := p.parseStmt()
			if err != nil {
				return nodes, 0, err
			}
			nodes = append(nodes, n)
		}
	}
}

func (p *parser) parseStmt() (*node, error) {
	t := p.next()
	if t.kind != tWord && t.kind != tString {
		return nil, fmt.Errorf("line %d: unexpected token %q", t.line, t.text)
	}
	if t.text == "if" {
		return p.parseIf(t.line)
	}

	words := []string{tokenText(t)}
	for {
		nt := p.peek()
		switch {
		case nt.kind == tEquals:
			p.next()
			return &node{
				kind:      nAssign,
				name:      strings.Join(words, " "),
				value:     p.restOfLine(nt.line),
				startLine: t.line,
				endLine:   nt.line,
			}, nil
		case nt.kind == tLBrace:
			p.next()
			children, endLine, err := p.parseStmts(true)
			if err != nil {
				return nil, err
			}
			n := &node{kind: nBlock, name: words[0], children: children, startLine: t.line, endLine: endLine}
			if len(words) > 1 {
				n.label = strings.Join(words[1:], " ")
			}
			return n, nil
		case (nt.kind == tWord || nt.kind == tString) && nt.line == t.line:
			p.next()
			words = append(words, tokenText(nt))
		default:
			// New line or closing brace: current words form a bare action.
			return &node{kind: nAction, value: strings.Join(words, " "), startLine: t.line, endLine: t.line}, nil
		}
	}
}

func (p *parser) parseIf(line int) (*node, error) {
	if _, err := p.expect(tLParen, "'('"); err != nil {
		return nil, err
	}
	attrTok, err := p.expect(tWord, "condition attribute")
	if err != nil {
		return nil, err
	}
	opTok, err := p.expect(tWord, "condition operator")
	if err != nil {
		return nil, err
	}
	var parts []string
	quoted := false
	for p.peek().kind != tRParen && p.peek().kind != tEOF {
		vt := p.next()
		if vt.kind == tString {
			quoted = true
		}
		parts = append(parts, vt.text)
	}
	rp, err := p.expect(tRParen, "')'")
	if err != nil {
		return nil, err
	}

	n := &node{
		kind:      nIf,
		cond:      &cond{attr: attrTok.text, op: opTok.text, value: strings.Join(parts, " "), quoted: quoted},
		startLine: line,
	}

	if p.peek().kind == tLBrace {
		p.next()
		children, endLine, err := p.parseStmts(true)
		if err != nil {
			return nil, err
		}
		n.children = children
		n.endLine = endLine
		if p.peek().kind == tWord && p.peek().text == "else" {
			elseTok := p.next()
			if p.peek().kind == tLBrace {
				p.next()
				elseNodes, endLine, err := p.parseStmts(true)
				if err != nil {
					return nil, err
				}
				n.elseNodes = elseNodes
				n.endLine = endLine
			} else {
				n.elseNodes = []*node{{kind: nAction, value: p.restOfLine(elseTok.line), startLine: elseTok.line}}
			}
		}
	} else {
		// Inline form: if (cmd =~ /show.*/) permit
		n.inline = true
		n.children = []*node{{kind: nAction, value: p.restOfLine(rp.line), startLine: rp.line}}
		n.endLine = rp.line
	}
	return n, nil
}

// restOfLine consumes remaining tokens on the given line and joins them,
// re-quoting string tokens (used for assign values and inline actions).
func (p *parser) restOfLine(line int) string {
	var parts []string
	for {
		t := p.peek()
		if t.line != line {
			break
		}
		switch t.kind {
		case tWord:
			parts = append(parts, t.text)
		case tString:
			parts = append(parts, `"`+t.text+`"`)
		case tEquals:
			parts = append(parts, "=")
		default:
			return strings.Join(parts, " ")
		}
		p.next()
	}
	return strings.Join(parts, " ")
}

func tokenText(t token) string {
	if t.kind == tString {
		return `"` + t.text + `"`
	}
	return t.text
}
