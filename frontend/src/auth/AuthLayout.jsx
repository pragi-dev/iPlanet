import { Laptop, ShieldCheck, Wrench } from 'lucide-react';

const highlights = [
  { icon: Wrench, title: 'Raise & track service', text: 'Log a repair and follow it to resolution.' },
  { icon: ShieldCheck, title: 'Manage coverage', text: 'Warranty and AMC status for every device.' },
  { icon: Laptop, title: 'Run operations', text: 'Queues, engineers and reports in one view.' },
];

// The page around the Sign in and Sign up cards: brand bar, introduction and footer.
export function AuthLayout({ children }) {
  return <main className="login">
    <header className="login-top">
      <div className="login-brand"><span className="login-brand-mark" aria-hidden="true">i</span><span><strong>iPlanet</strong> Self-care Portal</span></div>
    </header>

    <div className="login-main">
      <section className="login-intro">
        <p className="login-eyebrow">Self-Care &amp; Service Operations</p>
        <h1>Device care, handled.</h1>
        <p className="login-lede">Raise and track service, manage coverage, and run service operations — all from one place.</p>
        <ul className="login-highlights">
          {highlights.map(({ icon: Icon, title, text }) => <li key={title}>
            <span className="login-highlight-icon" aria-hidden="true"><Icon size={18} /></span>
            <span className="login-highlight-text"><strong>{title}</strong><span>{text}</span></span>
          </li>)}
        </ul>
      </section>

      {children}
    </div>

    <footer className="login-foot">
      <span>Copyright © {new Date().getFullYear()} iPlanet. All rights reserved.</span>
      <span>Corporate Self-Care · iPlanet Service · B2C Escalations</span>
    </footer>
  </main>;
}

// Corporate Self-Care / iPlanet Service switch shared by both cards; Sign in adds B2C Escalations.
export function WorkspaceSwitch({ value, onChange, includeB2C = false }) {
  return <div className="login-segmented" role="group" aria-label="Workspace" data-active={value} data-count={includeB2C ? 3 : 2}>
    <span className="login-segmented-thumb" aria-hidden="true" />
    <button type="button" aria-pressed={value === 'corporate'} onClick={() => onChange('corporate')}>Corporate Self-Care</button>
    <button type="button" aria-pressed={value === 'service'} onClick={() => onChange('service')}>iPlanet Service</button>
    {includeB2C && <button type="button" aria-pressed={value === 'b2c'} onClick={() => onChange('b2c')}>B2C Escalations</button>}
  </div>;
}
