import { AnimatePresence, motion } from 'framer-motion';
import { History, Plus, Send, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, del, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useBugsy } from '../lib/bugsy';
import { Markdown } from './Markdown';
import { Mascot } from './Mascot';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  grounded?: boolean;
}
interface Conv {
  id: string;
  title: string;
  jobId: string | null;
  updatedAt: string;
}

export function BugsyWidget() {
  const { user } = useAuth();
  const { job, open, setOpen, pendingPrompt, clearPending } = useBugsy();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [seenJob, setSeenJob] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const jobId = job?.jobId ?? null;

  // Status is only requested for signed-in users (the endpoint needs auth).
  useEffect(() => {
    if (!user) return setConfigured(null);
    get<{ configured: boolean }>('/api/chat/status').then((s) => setConfigured(s.configured)).catch(() => setConfigured(null));
  }, [user]);

  useEffect(() => {
    if (!user || !jobId || job?.status !== 'completed') return setSuggestions([]);
    get<{ suggestions: string[] }>(`/api/chat/suggestions?jobId=${jobId}`).then((r) => setSuggestions(r.suggestions)).catch(() => setSuggestions([]));
  }, [user, jobId, job?.status]);

  const loadConvs = useCallback(async () => {
    try {
      const r = await get<{ items: Conv[] }>(`/api/chat/conversations${jobId ? `?jobId=${jobId}` : ''}`);
      setConvs(r.items);
      return r.items;
    } catch {
      return [];
    }
  }, [jobId]);

  const openConv = useCallback(async (id: string) => {
    const r = await get<{ conversation: Conv; messages: Msg[] }>(`/api/chat/conversations/${id}`);
    setConvId(id);
    setMsgs(r.messages);
    setShowHistory(false);
  }, []);

  // When the chat opens (or the report changes) resume the latest conversation for this report.
  useEffect(() => {
    if (!open || !user) return;
    loadConvs().then((items) => {
      if (!convId && items[0] && (!jobId || items[0].jobId === jobId)) void openConv(items[0].id).catch(() => undefined);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user, jobId]);

  useEffect(() => {
    setConvId(null);
    setMsgs([]);
    setError(null);
  }, [jobId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, sending, open]);

  const send = useCallback(
    async (content: string) => {
      const body = content.trim();
      if (!body || sending) return;
      setSending(true);
      setError(null);
      setText('');
      const tempId = `tmp-${Date.now()}`;
      setMsgs((m) => [...m, { id: tempId, role: 'user', content: body }]);
      try {
        let id = convId;
        if (!id) {
          const c = await post<{ conversation: Conv }>('/api/chat/conversations', { jobId });
          id = c.conversation.id;
          setConvId(id);
        }
        const r = await post<{ user: Msg; assistant: Msg }>(`/api/chat/conversations/${id}/messages`, { content: body });
        setMsgs((m) => [...m.filter((x) => x.id !== tempId), r.user, r.assistant]);
        void loadConvs();
      } catch (e) {
        setMsgs((m) => m.filter((x) => x.id !== tempId));
        setText(body);
        setError(e instanceof ApiError ? e.message : 'BUGSY could not answer. Please try again.');
        if (e instanceof ApiError && e.code === 'ai_not_configured') setConfigured(false);
      } finally {
        setSending(false);
      }
    },
    [convId, jobId, sending, loadConvs],
  );

  useEffect(() => {
    if (open && pendingPrompt && user && configured !== null) {
      const p = pendingPrompt;
      clearPending();
      if (configured) void send(p);
    }
  }, [open, pendingPrompt, user, configured, send, clearPending]);

  if (!user) {
    return null; // BUGSY needs a session; the landing page explains the assistant instead.
  }

  const hasNews = Boolean(job && job.status === 'completed' && seenJob !== job.jobId);
  const contextual = job && job.status === 'completed'
    ? job.bugs === 0
      ? `Your test of ${job.hostname} finished with no issues detected in the tests performed${job.incomplete ? ', though some modules were skipped' : ''}.`
      : `Your test of ${job.hostname} found ${job.bugs} issue${job.bugs === 1 ? '' : 's'}${job.critical + job.high > 0 ? `, ${job.critical + job.high} of them critical or high` : ''}.`
    : null;

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.section
            className="bugsy-panel"
            aria-label="BUGSY chat"
            initial={{ opacity: 0, y: 30, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 360, damping: 30 }}
          >
            <header className="bugsy-head">
              <Mascot size={44} mood={sending ? 'thinking' : 'idle'} />
              <div className="grow">
                <b style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem' }}>BUGSY</b>
                <div className="small" style={{ opacity: 0.85 }}>{job ? `Looking at ${job.hostname}` : 'Your testing assistant'}</div>
              </div>
              <button className="btn btn-ghost btn-icon btn-sm" style={{ color: 'var(--cream)' }} onClick={() => setShowHistory((s) => !s)} aria-label="Conversation history" aria-pressed={showHistory}><History size={18} /></button>
              <button className="btn btn-ghost btn-icon btn-sm" style={{ color: 'var(--cream)' }} onClick={() => { setConvId(null); setMsgs([]); setShowHistory(false); setError(null); }} aria-label="New conversation"><Plus size={18} /></button>
              <button className="btn btn-ghost btn-icon btn-sm" style={{ color: 'var(--cream)' }} onClick={() => setOpen(false)} aria-label="Close chat"><X size={18} /></button>
            </header>

            {showHistory ? (
              <div className="bugsy-body" style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
                <b>Conversations</b>
                {convs.length === 0 && <p className="muted small">No conversations yet.</p>}
                {convs.map((c) => (
                  <div key={c.id} className="row" style={{ flexWrap: 'nowrap' }}>
                    <button className="btn btn-ghost grow" style={{ justifyContent: 'flex-start', overflow: 'hidden', textOverflow: 'ellipsis' }} onClick={() => openConv(c.id)}>{c.title}</button>
                    <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Delete conversation ${c.title}`} onClick={async () => { await del(`/api/chat/conversations/${c.id}`).catch(() => undefined); if (c.id === convId) { setConvId(null); setMsgs([]); } void loadConvs(); }}><Trash2 size={16} /></button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bugsy-body" ref={scroller}>
                {msgs.length === 0 && (
                  <div className="bubble bubble-bot">
                    {configured === false ? (
                      <p>My AI is not switched on for this server yet, so I can’t chat. Your report, evidence and recommended fixes are all still available on the report page.</p>
                    ) : (
                      <>
                        <p>Hi, I’m BUGSY. {contextual ?? 'Open a report and I’ll help you understand what was found.'}</p>
                        {job && configured && <p style={{ marginTop: 6 }}>I only use the results of your real test, so I’ll tell you when something wasn’t tested.</p>}
                      </>
                    )}
                  </div>
                )}
                {msgs.map((m) => (
                  <motion.div key={m.id} className={`bubble ${m.role === 'user' ? 'bubble-me' : 'bubble-bot'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                    {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
                  </motion.div>
                ))}
                {sending && (
                  <div className="bubble bubble-bot" aria-live="polite"><span className="dots"><i /><i /><i /></span><span className="sr-only">BUGSY is thinking</span></div>
                )}
                {error && <div className="notice notice-error small" role="alert">{error}</div>}
              </div>
            )}

            {!showHistory && configured !== false && msgs.length === 0 && suggestions.length > 0 && (
              <div className="bugsy-chips">
                {suggestions.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
              </div>
            )}
            <form className="bugsy-form" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
              <input className="input" aria-label="Message BUGSY" placeholder={configured === false ? 'Chat is unavailable' : 'Ask about your results…'} value={text} maxLength={2000} disabled={configured === false || sending} onChange={(e) => setText(e.target.value)} />
              <button className="btn btn-icon" aria-label="Send" disabled={!text.trim() || sending || configured === false}><Send size={18} /></button>
            </form>
          </motion.section>
        )}
      </AnimatePresence>

      <motion.button
        className="bugsy-fab"
        onClick={() => { setOpen(!open); if (job) setSeenJob(job.jobId); }}
        aria-label={open ? 'Close BUGSY chat' : 'Open BUGSY chat'}
        aria-expanded={open}
        whileHover={{ scale: 1.06, rotate: -4 }}
        whileTap={{ scale: 0.94 }}
      >
        <Mascot size={54} mood={hasNews ? 'alert' : 'idle'} />
        {hasNews && !open && <span className="bugsy-dot" aria-label="New message from BUGSY" />}
      </motion.button>
      {hasNews && !open && (
        <motion.div className="bugsy-nudge" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.6 }}>
          {contextual}
          <div><Link to="#" onClick={(e) => { e.preventDefault(); setOpen(true); if (job) setSeenJob(job.jobId); }}>Ask BUGSY</Link></div>
        </motion.div>
      )}
    </>
  );
}
