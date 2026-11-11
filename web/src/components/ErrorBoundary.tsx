import { Component, type ReactNode } from 'react';
import { Mascot } from './Mascot';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error('UI error', error);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="wrap-narrow page" style={{ textAlign: 'center' }}>
        <div className="empty">
          <Mascot size={110} mood="alert" />
          <h1 style={{ fontSize: '2rem' }}>This page hit a bug</h1>
          <p className="muted">Nothing you did caused this, and your test progress is saved. Reload the page to continue.</p>
          <button className="btn" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </div>
    );
  }
}
