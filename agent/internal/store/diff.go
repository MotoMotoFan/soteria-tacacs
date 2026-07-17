package store

import (
	"fmt"
	"strings"
)

// UnifiedDiff returns a unified diff (3 lines of context) between two
// texts, or "" when they are identical. Config files are small, so a
// plain LCS table is fine.
func UnifiedDiff(aText, bText string) string {
	if aText == bText {
		return ""
	}
	a := splitLines(aText)
	b := splitLines(bText)

	ops := diffOps(a, b)

	const context = 3
	var out strings.Builder
	i := 0
	for i < len(ops) {
		// Skip runs of equal lines to find the next hunk.
		if ops[i].kind == ' ' {
			i++
			continue
		}
		// Hunk start: back up for leading context.
		start := i - context
		if start < 0 {
			start = 0
		}
		// Extend hunk until a gap of > 2*context equal lines.
		end := i
		equal := 0
		for end < len(ops) {
			if ops[end].kind == ' ' {
				equal++
				if equal > 2*context {
					break
				}
			} else {
				equal = 0
			}
			end++
		}
		// Trim trailing context to at most `context` lines.
		trail := end
		if equal > context {
			trail = end - (equal - context)
		}

		aStart, aCount, bStart, bCount := hunkRange(ops, start, trail)
		out.WriteString(fmt.Sprintf("@@ -%d,%d +%d,%d @@\n", aStart, aCount, bStart, bCount))
		for _, op := range ops[start:trail] {
			out.WriteByte(byte(op.kind))
			out.WriteString(op.text)
			out.WriteByte('\n')
		}
		i = end
	}
	return out.String()
}

type diffOp struct {
	kind rune // ' ' equal, '-' removed, '+' added
	text string
	aIdx int // 1-based line number in a (for '-' and ' ')
	bIdx int // 1-based line number in b (for '+' and ' ')
}

func diffOps(a, b []string) []diffOp {
	n, m := len(a), len(b)
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	var ops []diffOp
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			ops = append(ops, diffOp{' ', a[i], i + 1, j + 1})
			i++
			j++
		case lcs[i+1][j] >= lcs[i][j+1]:
			ops = append(ops, diffOp{'-', a[i], i + 1, 0})
			i++
		default:
			ops = append(ops, diffOp{'+', b[j], 0, j + 1})
			j++
		}
	}
	for ; i < n; i++ {
		ops = append(ops, diffOp{'-', a[i], i + 1, 0})
	}
	for ; j < m; j++ {
		ops = append(ops, diffOp{'+', b[j], 0, j + 1})
	}
	return ops
}

func hunkRange(ops []diffOp, start, end int) (aStart, aCount, bStart, bCount int) {
	for _, op := range ops[start:end] {
		switch op.kind {
		case ' ':
			if aCount == 0 {
				aStart = op.aIdx
			}
			if bCount == 0 {
				bStart = op.bIdx
			}
			aCount++
			bCount++
		case '-':
			if aCount == 0 {
				aStart = op.aIdx
			}
			aCount++
		case '+':
			if bCount == 0 {
				bStart = op.bIdx
			}
			bCount++
		}
	}
	if aCount == 0 {
		aStart = 0
	}
	if bCount == 0 {
		bStart = 0
	}
	return
}

func splitLines(s string) []string {
	s = strings.TrimSuffix(s, "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}
