import { ChevronDown, LayoutDashboard, LogOut, MessageCircle, Phone, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../lib/auth';

const initials = (u: User) => (u.fullName || u.email).split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

/** Avatar button with the signed-in user's details, shortcuts and Log out. */
export function ProfileMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="profile" ref={box}>
      <button className="profile-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="profile-avatar" aria-hidden>{initials(user)}</span>
        <span className="profile-name hide-mobile">{user.fullName || user.email}</span>
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          <div className="profile-head">
            <span className="profile-avatar profile-avatar-lg" aria-hidden>{initials(user)}</span>
            <div style={{ minWidth: 0 }}>
              <b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.fullName || 'Your account'}</b>
              <span className="small muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.email}</span>
              {user.role === 'admin' && <span className="tag" style={{ marginTop: 6 }}><ShieldCheck size={13} /> Admin</span>}
            </div>
          </div>
          {(user.phone || user.whatsappNumber) && (
            <div className="profile-meta small">
              {user.phone && <span className="row" style={{ gap: 8 }}><Phone size={14} aria-hidden /> {user.phone}</span>}
              {user.whatsappNumber && <span className="row" style={{ gap: 8 }}><MessageCircle size={14} aria-hidden /> {user.whatsappNumber}</span>}
            </div>
          )}
          <Link role="menuitem" className="profile-item" to="/dashboard" onClick={() => setOpen(false)}><LayoutDashboard size={16} aria-hidden /> Dashboard</Link>
          {user.role === 'admin' && <Link role="menuitem" className="profile-item" to="/admin" onClick={() => setOpen(false)}><ShieldCheck size={16} aria-hidden /> Admin panel</Link>}
          <button role="menuitem" className="profile-item" onClick={() => { setOpen(false); onLogout(); }}><LogOut size={16} aria-hidden /> Log out</button>
        </div>
      )}
    </div>
  );
}
