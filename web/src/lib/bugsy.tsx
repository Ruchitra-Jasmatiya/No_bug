import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface BugsyJobContext {
  jobId: string;
  hostname: string;
  status: string;
  bugs: number;
  critical: number;
  high: number;
  incomplete: boolean;
}

interface BugsyState {
  job: BugsyJobContext | null;
  setJob(j: BugsyJobContext | null): void;
  open: boolean;
  setOpen(o: boolean): void;
  /** Opens the panel and sends this prompt as soon as the chat is ready. */
  ask(prompt: string): void;
  pendingPrompt: string | null;
  clearPending(): void;
}

const Ctx = createContext<BugsyState | null>(null);

export function BugsyProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<BugsyJobContext | null>(null);
  const [open, setOpen] = useState(false);
  const [pendingPrompt, setPending] = useState<string | null>(null);
  const ask = useCallback((p: string) => {
    setPending(p);
    setOpen(true);
  }, []);
  const value = useMemo<BugsyState>(() => ({ job, setJob, open, setOpen, ask, pendingPrompt, clearPending: () => setPending(null) }), [job, open, ask, pendingPrompt]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBugsy(): BugsyState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBugsy outside BugsyProvider');
  return v;
}
