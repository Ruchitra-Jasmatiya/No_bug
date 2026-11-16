import { Fragment, type ReactNode } from 'react';

/** Small, safe renderer for BUGSY's answers: fenced code, headings, rules, lists, **bold** and `code`. No raw HTML is ever injected. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('`') ? <code key={i++} className="ic">{tok.slice(1, -1)}</code> : <strong key={i++}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST = /^\s*([-*•]|\d+[.)])\s+/;

export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <div className="md">
      {parts.map((part, idx) => {
        if (idx % 2 === 1) {
          const body = part.replace(/^[a-z0-9+-]*\n/i, '');
          return <pre key={idx} className="code">{body.trim()}</pre>;
        }
        const blocks = part.split(/\n{2,}/).filter((b) => b.trim());
        return (
          <Fragment key={idx}>
            {blocks.map((b, j) => {
              const lines = b.split('\n');
              if (/^\s*(-{3,}|\*{3,})\s*$/.test(b)) return <hr key={j} />;
              if (/^#{1,4}\s+/.test(lines[0]!) && lines.length === 1) return <h4 key={j}>{inline(lines[0]!.replace(/^#{1,4}\s+/, ''))}</h4>;
              if (lines.every((l) => LIST.test(l))) {
                const ordered = /^\s*\d/.test(lines[0]!);
                const items = lines.map((l, k) => <li key={k}>{inline(l.replace(LIST, ''))}</li>);
                return ordered ? <ol key={j}>{items}</ol> : <ul key={j}>{items}</ul>;
              }
              return <p key={j}>{lines.map((l, k) => <Fragment key={k}>{k > 0 && <br />}{inline(l)}</Fragment>)}</p>;
            })}
          </Fragment>
        );
      })}
    </div>
  );
}
