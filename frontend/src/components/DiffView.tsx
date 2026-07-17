/** Colored unified-diff renderer (green +, red -, muted @@ hunk headers). */
export default function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="config-preview whitespace-pre overflow-x-auto text-xs leading-5">
      {diff.split('\n').map((line, i) => {
        const color = line.startsWith('+') ? '#34d399' : line.startsWith('-') ? '#f87171' : line.startsWith('@@') ? 'var(--s-muted)' : undefined;
        return <div key={i} style={color ? { color } : undefined}>{line || ' '}</div>;
      })}
    </pre>
  );
}
