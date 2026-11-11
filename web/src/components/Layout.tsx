import { AnimatePresence, motion } from 'framer-motion';
import { LogOut, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { BrandMark } from './Mascot';
import { BugsyWidget } from './BugsyWidget';
import { ActiveTestBanner } from './ActiveTestBanner';

export function Layout() {
  const { user, logout, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    window.scrollTo({ top: loc.hash ? undefined : 0 });
    if (loc.hash) document.querySelector(loc.hash)?.scrollIntoView();
  }, [loc.pathname, loc.hash]);

  const links = (
    <>
      <NavLink className="nav-link" to="/" end>Home</NavLink>
      <Link className="nav-link" to="/#how">How it works</Link>
      <NavLink className="nav-link" to="/about">About</NavLink>
      {user && <NavLink className="nav-link" to="/dashboard">Dashboard</NavLink>}
      {user?.role === 'admin' && <NavLink className="nav-link" to="/admin">Admin</NavLink>}
      <NavLink className="nav-link" to="/contact">Contact</NavLink>
    </>
  );
  const doLogout = async () => {
    await logout();
    nav('/');
  };

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="nav">
        <div className="wrap nav-inner">
          <Link to="/" className="brand" aria-label="NO BUGS ALLOWED home">
            <BrandMark />
            NO BUGS ALLOWED
          </Link>
          <nav className="nav-links" aria-label="Main">{links}</nav>
          <div className="nav-actions">
            {loading ? null : user ? (
              <>
                <span className="small muted hide-mobile" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.fullName || user.email}</span>
                {user.role === 'admin' && <span className="tag"><ShieldCheck size={14} /> Admin</span>}
                <button className="btn btn-ghost btn-sm" onClick={doLogout}><LogOut size={16} /> Log out</button>
              </>
            ) : (
              <>
                <Link className="btn btn-ghost btn-sm" to="/login">Log in</Link>
                <Link className="btn btn-yellow btn-sm" to="/signup">Create account</Link>
              </>
            )}
          </div>
          <button className="burger" aria-label="Menu" aria-expanded={open} aria-controls="drawer" onClick={() => setOpen((o) => !o)}>
            <span /><span /><span />
          </button>
        </div>
      </header>
      <AnimatePresence>
        {open && (
          <motion.div id="drawer" className="drawer" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.25 }}>
            {links}
            <hr className="divider" />
            {user ? (
              <button className="btn" onClick={doLogout}><LogOut size={16} /> Log out</button>
            ) : (
              <div className="stack" style={{ ['--gap' as string]: '10px' }}>
                <Link className="btn btn-yellow" to="/signup">Create account</Link>
                <Link className="btn btn-ghost" to="/login">Log in</Link>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <ActiveTestBanner />
      <main id="main" tabIndex={-1} style={{ outline: 'none' }}>
        <Outlet />
      </main>
      <Footer />
      <BugsyWidget />
    </>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-grid">
        <div className="stack">
          <div className="brand" style={{ color: 'var(--cream)' }}><BrandMark />NO BUGS ALLOWED</div>
          <p style={{ maxWidth: 360, opacity: 0.85 }}>Find the bugs. Fix the problems. Launch with confidence.</p>
          <p className="small" style={{ opacity: 0.7, maxWidth: 420 }}>Reports list what was found in the tests performed. They never claim a website is bug-free.</p>
        </div>
        <div>
          <h4>Product</h4>
          <ul>
            <li><Link to="/#how">How it works</Link></li>
            <li><Link to="/#modules">What gets tested</Link></li>
            <li><Link to="/dashboard">Dashboard</Link></li>
          </ul>
        </div>
        <div>
          <h4>Company</h4>
          <ul>
            <li><Link to="/about">About</Link></li>
            <li><Link to="/contact">Contact</Link></li>
            <li><Link to="/terms">Terms</Link></li>
            <li><Link to="/privacy">Privacy</Link></li>
          </ul>
        </div>
      </div>
      <div className="wrap small" style={{ marginTop: 36, opacity: 0.7 }}>© {new Date().getFullYear()} NO BUGS ALLOWED</div>
    </footer>
  );
}
