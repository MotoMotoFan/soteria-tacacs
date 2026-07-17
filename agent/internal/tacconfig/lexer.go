package tacconfig

import "strings"

type tokKind int

const (
	tEOF tokKind = iota
	tWord
	tString // was double-quoted in source
	tLBrace
	tRBrace
	tLParen
	tRParen
	tEquals
)

type token struct {
	kind tokKind
	text string
	line int
}

type comment struct {
	text string
	line int
}

// lex tokenizes a tac_plus-ng config source. Comments are collected separately
// (they carry @annotations like "@platform Cisco IOS-XE").
// Known limitation: regex literals containing parentheses, e.g. =~ /(a|b)/,
// confuse the tokenizer; the config validator catches anything mis-rendered.
func lex(src string) ([]token, []comment) {
	var toks []token
	var comments []comment
	line := 1
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == '\n':
			line++
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '#':
			j := i
			for j < len(src) && src[j] != '\n' {
				j++
			}
			text := strings.TrimSpace(strings.TrimLeft(src[i:j], "#"))
			comments = append(comments, comment{text: text, line: line})
			i = j
		case c == '"':
			j := i + 1
			for j < len(src) && src[j] != '"' {
				if src[j] == '\\' && j+1 < len(src) {
					j++
				}
				j++
			}
			toks = append(toks, token{tString, src[i+1 : min(j, len(src))], line})
			i = j + 1
		case c == '{':
			toks = append(toks, token{tLBrace, "{", line})
			i++
		case c == '}':
			toks = append(toks, token{tRBrace, "}", line})
			i++
		case c == '(':
			toks = append(toks, token{tLParen, "(", line})
			i++
		case c == ')':
			toks = append(toks, token{tRParen, ")", line})
			i++
		case c == '=':
			if i+1 < len(src) && (src[i+1] == '=' || src[i+1] == '~') {
				toks = append(toks, token{tWord, src[i : i+2], line})
				i += 2
			} else {
				toks = append(toks, token{tEquals, "=", line})
				i++
			}
		case c == '!' && i+1 < len(src) && src[i+1] == '=':
			toks = append(toks, token{tWord, "!=", line})
			i += 2
		default:
			j := i
			for j < len(src) && !strings.ContainsRune(" \t\r\n#\"{}()=", rune(src[j])) {
				j++
			}
			toks = append(toks, token{tWord, src[i:j], line})
			i = j
		}
	}
	toks = append(toks, token{tEOF, "", line})
	return toks, comments
}
