import { SEVERITY_ORDER } from '../lib/format';

const SEV_COLOR: Record<string, string> = { critical: 'var(--sev-critical)', high: 'var(--sev-high)', medium: 'var(--sev-medium)', low: 'var(--sev-low)', informational: 'var(--sev-info)' };

/** Flat donut of severity counts. Segments are separated by cream gaps; the centre shows the total. */
export function SeverityDonut({ counts, size = 168 }: { counts: Record<string, number>; size?: number }) {
  const total = SEVERITY_ORDER.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const r = 58;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox="0 0 160 160" role="img" aria-label={`${total} issues by severity`}>
      <circle cx="80" cy="80" r={r} fill="none" stroke="var(--cream-2)" strokeWidth="26" />
      {total > 0 &&
        SEVERITY_ORDER.map((s) => {
          const n = counts[s] ?? 0;
          if (!n) return null;
          const len = (n / total) * c;
          const el = <circle key={s} cx="80" cy="80" r={r} fill="none" stroke={SEV_COLOR[s]} strokeWidth="26" strokeDasharray={`${Math.max(0, len - 3)} ${c}`} strokeDashoffset={-offset} transform="rotate(-90 80 80)" />;
          offset += len;
          return el;
        })}
      <circle cx="80" cy="80" r="45" fill="var(--paper)" />
      <text x="80" y="82" textAnchor="middle" fontFamily="var(--font-display)" fontWeight="800" fontSize="34" fill="var(--ink)">{total}</text>
      <text x="80" y="102" textAnchor="middle" fontSize="11" fill="var(--ink-soft)" fontFamily="var(--font-body)">{total === 1 ? 'issue' : 'issues'}</text>
    </svg>
  );
}

export function Legend({ counts }: { counts: Record<string, number> }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
      {SEVERITY_ORDER.map((s) => (
        <li key={s} className="row" style={{ gap: 8 }}>
          <span className="pill-dot" style={{ ['--c' as string]: SEV_COLOR[s], borderRadius: 2, transform: 'rotate(45deg)' }} />
          <span style={{ textTransform: 'capitalize', minWidth: 90 }}>{s}</span>
          <b>{counts[s] ?? 0}</b>
        </li>
      ))}
    </ul>
  );
}

/** Horizontal bars for category counts. */
export function BarList({ items, color = 'var(--sage)' }: { items: Array<{ label: string; value: number }>; color?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.length === 0) return <p className="muted small">No data yet.</p>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {items.map((i) => (
        <div key={i.label} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 36px', alignItems: 'center', gap: 10 }}>
          <span className="small" style={{ textTransform: 'capitalize' }}>{i.label}</span>
          <div style={{ background: 'var(--cream-2)', height: 14, borderRadius: 7, overflow: 'hidden', border: '1.5px solid var(--sage-dark)' }}>
            <div style={{ width: `${(i.value / max) * 100}%`, height: '100%', background: color, transition: 'width .6s var(--ease)' }} />
          </div>
          <b className="small" style={{ textAlign: 'right' }}>{i.value}</b>
        </div>
      ))}
    </div>
  );
}

/** Column chart over days (tests per day etc). */
export function Columns({ data, series }: { data: Array<{ day: string; [k: string]: number | string }>; series: Array<{ key: string; color: string; label: string }> }) {
  const max = Math.max(1, ...data.map((d) => series.reduce((n, s) => n + Number(d[s.key] ?? 0), 0)));
  const W = 560;
  const H = 150;
  const bw = W / Math.max(1, data.length);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 24}`} width="100%" role="img" aria-label="Chart by day" style={{ overflow: 'visible' }}>
        <line x1="0" x2={W} y1={H} y2={H} stroke="var(--sage-dark)" strokeWidth="2" />
        {data.map((d, i) => {
          let y = H;
          return (
            <g key={d.day}>
              {series.map((s) => {
                const v = Number(d[s.key] ?? 0);
                const h = (v / max) * (H - 8);
                y -= h;
                return v > 0 ? <rect key={s.key} x={i * bw + bw * 0.18} y={y} width={bw * 0.64} height={h} fill={s.color} rx="3" /> : null;
              })}
              {(data.length <= 10 || i % Math.ceil(data.length / 7) === 0) && (
                <text x={i * bw + bw / 2} y={H + 16} textAnchor="middle" fontSize="10" fill="var(--ink-soft)">{d.day.slice(5)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="row" style={{ gap: 14, marginTop: 6 }}>
        {series.map((s) => (
          <span key={s.key} className="row small" style={{ gap: 6 }}>
            <span className="pill-dot" style={{ ['--c' as string]: s.color, borderRadius: 3 }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
