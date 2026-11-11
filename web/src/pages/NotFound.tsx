import { Link } from 'react-router-dom';
import { Mascot } from '../components/Mascot';
import { useDocumentTitle } from '../lib/ui';

export default function NotFound() {
  useDocumentTitle('Page not found');
  return (
    <div className="wrap-narrow page" style={{ textAlign: 'center' }}>
      <div className="empty">
        <Mascot size={120} mood="alert" />
        <h1 style={{ fontSize: '2.4rem' }}>404 — we squashed this page</h1>
        <p className="muted">The page you are looking for does not exist or has moved.</p>
        <Link className="btn btn-yellow" to="/">Back to home</Link>
      </div>
    </div>
  );
}
