import { useMemo, useRef, useState } from 'react';
import type { LogEntry } from '../lib/api';

// Hourly success vs failure line chart for today's AAA events, scoped to one
// log type (authentication or authorization). Colors come from
// --s-chart-success / --s-chart-failure (validated per theme); identity is
// never color-alone: legend + tooltip carry labels.

const W = 720;
const H = 220;
const PAD = { left: 40, right: 16, top: 14, bottom: 26 };
const PW = W - PAD.left - PAD.right;
const PH = H - PAD.top - PAD.bottom;

function hourOf(ts: string): number | null {
  const d = new Date(ts);
  if (!Number.isNaN(d.getTime())) return d.getHours();
  const m = /[T ](\d{2}):/.exec(ts);
  return m ? parseInt(m[1], 10) : null;
}

export default function AuthActivityChart({
  logs,
  loading,
  type = 'authentication',
  title = 'Authentication Activity Today',
  successLabel = 'Success',
  failureLabel = 'Failed',
}: {
  logs: LogEntry[];
  loading: boolean;
  type?: 'authentication' | 'authorization';
  title?: string;
  successLabel?: string;
  failureLabel?: string;
}) {
  const [hoverHour, setHoverHour] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const { success, failure, total } = useMemo(() => {
    const success = new Array<number>(24).fill(0);
    const failure = new Array<number>(24).fill(0);
    let total = 0;
    for (const log of logs) {
      if (log.type !== type) continue;
      const h = hourOf(log.timestamp);
      if (h === null) continue;
      if (log.result === 'success') success[h]++;
      else failure[h]++;
      total++;
    }
    return { success, failure, total };
  }, [logs, type]);

  const yMax = Math.max(4, ...success, ...failure);
  const x = (h: number) => PAD.left + (h / 23) * PW;
  const y = (v: number) => PAD.top + PH - (v / yMax) * PH;

  const linePath = (data: number[]) => data.map((v, h) => `${h === 0 ? 'M' : 'L'}${x(h).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const areaPath = (data: number[]) => `${linePath(data)} L${x(23).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;

  // Recessive grid: 4 horizontal lines with round y steps.
  const yTicks = useMemo(() => {
    const step = Math.max(1, Math.ceil(yMax / 4));
    const ticks: number[] = [];
    for (let v = 0; v <= yMax; v += step) ticks.push(v);
    return ticks;
  }, [yMax]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const h = Math.round(((px - PAD.left) / PW) * 23);
    setHoverHour(h >= 0 && h <= 23 ? h : null);
  };

  const legend = (
    <div className="flex items-center gap-4 text-xs" style={{ color: 'var(--s-text)' }}>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: 'var(--s-chart-success)' }} />
        {successLabel} ({success.reduce((a, b) => a + b, 0)})
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: 'var(--s-chart-failure)' }} />
        {failureLabel} ({failure.reduce((a, b) => a + b, 0)})
      </span>
    </div>
  );

  return (
    <div className="glass-card overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--s-border)' }}>
        <h3 className="text-sm font-semibold heading">{title}</h3>
        {legend}
      </div>

      {total === 0 ? (
        <div className="px-5 py-12 text-center text-sm" style={{ color: 'var(--s-muted)' }}>
          {loading ? 'Loading…' : `No ${type} events today yet.`}
        </div>
      ) : (
        <div className="relative px-2 py-3">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-auto block"
            onMouseMove={onMove}
            onMouseLeave={() => setHoverHour(null)}
          >
            {/* Grid + y labels */}
            {yTicks.map(v => (
              <g key={v}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--s-border)" strokeWidth="1" />
                <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--s-muted)">{v}</text>
              </g>
            ))}
            {/* X labels every 4 hours */}
            {[0, 4, 8, 12, 16, 20, 23].map(h => (
              <text key={h} x={x(h)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--s-muted)">
                {String(h).padStart(2, '0')}h
              </text>
            ))}

            {/* Areas (subtle) then lines (2px) */}
            <path d={areaPath(success)} fill="var(--s-chart-success)" fillOpacity="0.08" />
            <path d={areaPath(failure)} fill="var(--s-chart-failure)" fillOpacity="0.08" />
            <path d={linePath(success)} fill="none" stroke="var(--s-chart-success)" strokeWidth="2" strokeLinejoin="round" />
            <path d={linePath(failure)} fill="none" stroke="var(--s-chart-failure)" strokeWidth="2" strokeLinejoin="round" />

            {/* Crosshair + hover markers (2px surface ring separates overlaps) */}
            {hoverHour !== null && (
              <g>
                <line x1={x(hoverHour)} x2={x(hoverHour)} y1={PAD.top} y2={PAD.top + PH} stroke="var(--s-muted)" strokeWidth="1" strokeDasharray="3 3" />
                <circle cx={x(hoverHour)} cy={y(success[hoverHour])} r="4" fill="var(--s-chart-success)" stroke="var(--s-card)" strokeWidth="2" />
                <circle cx={x(hoverHour)} cy={y(failure[hoverHour])} r="4" fill="var(--s-chart-failure)" stroke="var(--s-card)" strokeWidth="2" />
              </g>
            )}
          </svg>

          {hoverHour !== null && (
            <div
              className="absolute pointer-events-none z-10 px-3 py-2 rounded-lg shadow-xl text-xs"
              style={{
                backgroundColor: 'var(--s-surface)',
                border: '1px solid var(--s-border)',
                left: `${(x(hoverHour) / W) * 100}%`,
                top: 8,
                transform: hoverHour > 16 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
              }}
            >
              <p className="font-semibold mb-1 heading">{String(hoverHour).padStart(2, '0')}:00 – {String(hoverHour).padStart(2, '0')}:59</p>
              <p className="flex items-center gap-1.5" style={{ color: 'var(--s-text)' }}>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--s-chart-success)' }} />
                {successLabel}: <span className="font-mono">{success[hoverHour]}</span>
              </p>
              <p className="flex items-center gap-1.5" style={{ color: 'var(--s-text)' }}>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--s-chart-failure)' }} />
                {failureLabel}: <span className="font-mono">{failure[hoverHour]}</span>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
