import { Fragment, type ReactNode } from 'react';

/** Minimal, safe renderer for BUGSY's answers: fenced code, lists, **bold** and `code`. No raw HTML is ever injected. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('`') ? <code key={i++} className="mono" style={{ background: 'var(--butter)', padding: '1px 6px', borderRadius: 5 }}>{tok.slice(1, -1)}</code> : <strong key={i++}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, idx) => {
        if (idx % 2 === 1) {
          const body = part.replace(/^[a-z0-9+-]*\n/i, '');
          return <pre key={idx} className="code" style={{ margin: '8px 0' }}>{body.trim()}</pre>;
        }
        const blocks = part.split(/\n{2,}/).filter((b) => b.trim());
        return (
          <Fragment key={idx}>
            {blocks.map((b, j) => {
              const lines = b.split('\n');
              if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
                const ordered = /^\s*\d/.test(lines[0]!);
                const items = lines.map((l, k) => <li key={k}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>);
                return ordered ? <ol key={j} style={{ margin: '6px 0', paddingLeft: 22 }}>{items}</ol> : <ul key={j} style={{ margin: '6px 0', paddingLeft: 22 }}>{items}</ul>;
              }
              return <p key={j} style={{ margin: '6px 0' }}>{lines.map((l, k) => <Fragment key={k}>{k > 0 && <br />}{inline(l)}</Fragment>)}</p>;
            })}
          </Fragment>
        );
      })}
    </>
  );
}
