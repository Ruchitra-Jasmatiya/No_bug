/**
 * Finds WHERE a problem is, using only what the test actually recorded: stack traces, console sources with
 * line/column, element selectors and URLs. Nothing is guessed: when the evidence holds no file or line, the
 * result says so and callers must not invent one.
 */

export interface SourceLocation {
  /** Short display name, for example "app.js". */
  file: string;
  /** Full URL of the script, when known. */
  url: string;
  line: number | null;
  column: number | null;
  /** Function name from a stack frame, when present. */
  func: string | null;
  from: 'stack trace' | 'console message' | 'failed request';
}

export interface ElementRef {
  selector: string;
  html: string | null;
  note: string | null;
}

export interface Located {
  locations: SourceLocation[];
  elements: ElementRef[];
  /** Other URLs named in the evidence (broken links, missing images, paginated pages ...). */
  urls: string[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

function baseName(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.host;
  } catch {
    return url.split(/[\\/]/).pop() || url;
  }
}

// "at fn (https://x/app.js:12:5)", "at https://x/app.js:12:5", "fn@https://x/app.js:12:5"
const FRAME = /(?:at\s+(?:async\s+)?(?:(?<fn>[^\s(]+)\s+\()?|(?<fn2>[^\s@]*)@)(?<url>(?:https?|file):\/\/[^\s)]+?):(?<line>\d+):(?<col>\d+)\)?/g;

export function parseStack(stack: string): SourceLocation[] {
  const out: SourceLocation[] = [];
  for (const m of stack.matchAll(FRAME)) {
    const g = m.groups!;
    const url = g.url!;
    out.push({ file: baseName(url), url, line: Number(g.line), column: Number(g.col), func: (g.fn || g.fn2 || '') || null, from: 'stack trace' });
  }
  return out;
}

const ELEMENT_ARRAYS = ['elements', 'overflowingElements', 'targets', 'pairs', 'images', 'nodes', 'samples'] as const;
const URL_ARRAYS = ['urls', 'pages', 'images', 'hops', 'broken'] as const;

function pushElement(list: ElementRef[], item: unknown): void {
  if (typeof item === 'string') {
    if (item.trim()) list.push({ selector: item.slice(0, 200), html: null, note: null });
    return;
  }
  if (!isRec(item)) return;
  const selector = str(item.selector) || str(item.target) || str(item.sel) || str(item.a) || str(item.el) || str(item.tag);
  const html = str(item.html) || null;
  const note = str(item.summary) || str(item.reason) || str(item.text) || null;
  if (selector || html) list.push({ selector: (selector || '(element)').slice(0, 200), html: html ? html.slice(0, 240) : null, note: note ? note.slice(0, 240) : null });
}

function pushUrl(list: string[], item: unknown): void {
  const s = typeof item === 'string' ? item : isRec(item) ? str(item.url) || str(item.href) || str(item.src) || str(item.to) : '';
  if (/^https?:\/\//i.test(s) && !list.includes(s)) list.push(s);
}

export function locateEvidence(evidence: Rec | null | undefined, affectedUrl: string | null = null): Located {
  const out: Located = { locations: [], elements: [], urls: [] };
  const ev = isRec(evidence) ? evidence : {};

  const stack = str(ev.stack);
  if (stack) out.locations.push(...parseStack(stack).slice(0, 4));

  const source = str(ev.source);
  const line = num(ev.line);
  if (source && /^(https?|file):/i.test(source)) {
    out.locations.push({ file: baseName(source), url: source, line, column: num(ev.column), func: null, from: 'console message' });
  }

  const resourceType = str(ev.resourceType);
  const reqUrl = str(ev.url);
  if (/^(script|stylesheet|fetch|xhr|document)$/.test(resourceType) && /^https?:/i.test(reqUrl)) {
    out.locations.push({ file: baseName(reqUrl), url: reqUrl, line: null, column: null, func: null, from: 'failed request' });
  }

  for (const key of ELEMENT_ARRAYS) {
    const v = ev[key];
    if (Array.isArray(v)) for (const item of v.slice(0, 5)) pushElement(out.elements, item);
  }
  for (const key of URL_ARRAYS) {
    const v = ev[key];
    if (Array.isArray(v)) for (const item of v.slice(0, 8)) pushUrl(out.urls, item);
  }
  if (reqUrl) pushUrl(out.urls, reqUrl);
  if (affectedUrl) pushUrl(out.urls, affectedUrl);

  // De-duplicate locations (same file, line and column).
  const seen = new Set<string>();
  out.locations = out.locations.filter((l) => {
    const k = `${l.url}:${l.line}:${l.column}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  out.elements = out.elements.slice(0, 5);
  out.urls = out.urls.slice(0, 8);
  return out;
}

/** "app.js:128:19" (plain text, safe to place inside inline code). */
export function describeLocation(l: SourceLocation): string {
  return l.line ? `${l.file}:${l.line}${l.column ? `:${l.column}` : ''}` : l.file;
}
