import { motion } from 'framer-motion';
import { Mail, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Mascot } from '../components/Mascot';
import { useDocumentTitle } from '../lib/ui';

type Page = 'about' | 'terms' | 'privacy' | 'contact';
const H = ({ children }: { children: ReactNode }) => <h2 style={{ fontSize: '1.35rem', marginTop: 28 }}>{children}</h2>;

function Shell({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <div className="wrap-narrow page">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="row" style={{ gap: 18, flexWrap: 'nowrap', alignItems: 'center' }}>
        <Mascot size={76} />
        <div><h1 style={{ fontSize: 'clamp(1.8rem,4.4vw,2.8rem)' }}>{title}</h1><p className="muted" style={{ margin: 0 }}>{lead}</p></div>
      </motion.div>
      <div className="prose">{children}</div>
    </div>
  );
}

export default function Static({ page }: { page: Page }) {
  if (page === 'about') {
    return (
      <Shell title="About NO BUGS ALLOWED" lead="Honest website testing, explained like a person would.">
        <p>NO BUGS ALLOWED drives a real browser against your website, checks what it finds, and hands you a report with evidence, severity and a recommended fix for each problem. BUGSY, our assistant, helps you understand the results.</p>
        <H>What we promise</H>
        <ul>
          <li><b>Real tests only.</b> Progress, counts and issues come from tests that actually ran. Nothing is made up to look impressive.</li>
          <li><b>Honest wording.</b> We say “no issues detected in the tests performed”, never “bug-free”. If a module was skipped or blocked, the report says so.</li>
          <li><b>Evidence first.</b> AI explanations are labelled and stored separately from the test evidence; they never change a finding’s severity or status.</li>
          <li><b>Safe by design.</b> Tests are passive and non-destructive, and private network addresses are blocked.</li>
        </ul>
        <H>What it tests</H>
        <p>Connectivity, page loading, console errors, functional behaviour, layout, responsive design, performance, accessibility, SEO, passive security checks, links and resources, API calls, visual changes and PWA signals.</p>
        <Link className="btn btn-yellow" to="/signup">Create a free account</Link>
      </Shell>
    );
  }
  if (page === 'terms') {
    return (
      <Shell title="Terms of Use" lead="Plain-language terms for using NO BUGS ALLOWED.">
        <p className="small muted">This is a starter template written for the project. Have it reviewed by a lawyer and adapted to your business before launch.</p>
        <H>1. Only test what you are allowed to test</H>
        <p>You may submit a website only if you own it or have the owner’s permission to test it. You confirm this each time you start a test. Tests are passive and non-destructive, but you are responsible for having authorisation.</p>
        <H>2. Acceptable use</H>
        <p>Do not use the service to attack, overload or probe systems you do not control, to bypass access controls, or to test internal networks. We block private and internal addresses and may suspend accounts that abuse the service.</p>
        <H>3. Results are informational</H>
        <p>Reports list what was detected in the tests performed. They do not certify that a website is secure, accessible or free of bugs. AI-generated explanations may be incomplete or wrong; verify before you change production systems.</p>
        <H>4. Your account</H>
        <p>Keep your credentials private. We may suspend or remove accounts that break these terms. You can stop using the service at any time.</p>
        <H>5. Availability and liability</H>
        <p>The service is provided “as is”. To the extent allowed by law we are not liable for indirect or consequential losses arising from its use.</p>
        <H>6. Changes</H>
        <p>We may update these terms; continued use means you accept the updated version.</p>
      </Shell>
    );
  }
  if (page === 'privacy') {
    return (
      <Shell title="Privacy Policy" lead="What we collect, why, and how it is protected.">
        <p className="small muted">This is a starter template written for the project. Have it reviewed by a lawyer and adapted to your jurisdiction before launch.</p>
        <H>What we collect</H>
        <ul>
          <li><b>Account data:</b> name, email, optional phone, and a password handled by our authentication provider (we never store plain-text passwords).</li>
          <li><b>Test data:</b> the URLs you test, results, logs, screenshots and the reports built from them.</li>
          <li><b>Security data:</b> sign-in attempts (time, IP address, browser) used to detect abuse and protect accounts.</li>
          <li><b>Chat data:</b> your conversations with BUGSY.</li>
        </ul>
        <H>How we use it</H>
        <p>To run your tests, show your reports, secure the service and send account emails such as verification codes. We do not sell your data.</p>
        <H>AI processing</H>
        <p>When AI is enabled, selected findings and BUGSY questions are sent to the configured AI provider to produce explanations. Secrets and credentials found in test data are redacted before being sent.</p>
        <H>Access and retention</H>
        <p>Your tests and reports are visible only to you (and administrators who operate the service). Contact us to export or delete your data.</p>
        <p className="row" style={{ gap: 8 }}><ShieldCheck size={18} /> Data is protected with row-level security, hashed one-time codes and encrypted connections.</p>
      </Shell>
    );
  }
  return (
    <Shell title="Contact" lead="Questions, feedback or a bug in our own bug-finder? Tell us.">
      <p>The fastest way to reach the team is by email. We read everything.</p>
      <div className="card" style={{ padding: 22 }}>
        <p className="row" style={{ gap: 10, margin: 0 }}><Mail size={20} /> <span>Send your message to the support address published by the site owner.</span></p>
        <p className="small muted" style={{ marginBottom: 0 }}>Site owners: set your support address in this page before launch (web/src/pages/Static.tsx). No contact form is shown because no mail endpoint is configured for public messages.</p>
      </div>
      <p>Found a security problem? Please report it privately rather than in public.</p>
    </Shell>
  );
}
