import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, FlaskConical, Link2Off, RotateCcw } from 'lucide-react';
import { Button, Field, InlineAlert, JourneyTrack } from './components';
import { EMPTY_FORM, FIELDS, SECTIONS, todayIso, toPayload, validate } from './fields';
import { registrationJourney } from './registrationJourney';
import { loadRegistration, registrationMode, submitRegistration } from './service/registrationService';

const INPUT = {
  name: { autoComplete: 'name' },
  email: { type: 'email', autoComplete: 'email', inputMode: 'email', placeholder: 'name@example.com' },
  phone: { type: 'tel', autoComplete: 'tel', inputMode: 'tel', placeholder: '+91 98765 43210' },
  serialNumber: { autoCapitalize: 'characters', spellCheck: false, className: 'mono', placeholder: 'e.g. F2LXK0ABCDEF' },
  purchaseDate: { type: 'date', min: '2000-01-01' },
  invoiceNumber: { spellCheck: false },
};
const HINTS = {
  serialNumber: 'Optional. Shown on the box, the invoice, or in Settings › General › About on the device.',
  purchaseDate: 'Optional.',
  purchaseLocation: 'The store name and city where you bought the device.',
  purchaseRegion: 'Optional. We confirm the region from our purchase records.',
  dealer: 'Optional, if you bought from an authorised dealer.',
  invoiceNumber: 'Optional, as printed on your invoice or order confirmation.',
};
const BLOCKED = {
  link_required: { icon: Link2Off, tone: 'warning', title: 'A registration link is required', text: 'Please open this page from the link in the registration email sent by our support team.' },
  invalid: { icon: AlertTriangle, tone: 'critical', title: 'This link is not valid', text: 'Please use the link in the most recent registration email from our support team. If you received more than one, only the latest link works.' },
  used: { icon: CheckCircle2, tone: 'success', title: 'Registration already received', text: 'This link has already been used. Our support team is processing your details, and you will hear from us by email.' },
  closed: { icon: CheckCircle2, tone: 'info', title: 'Registration is no longer needed', text: 'Our support team is already handling your request. You do not need to do anything further.' },
  processing: { icon: Clock, tone: 'info', title: 'Your details are being processed', text: 'Please wait a moment and refresh this page.' },
  expired: { icon: Clock, tone: 'warning', title: 'This link has expired', text: 'For your security, registration links expire after a limited time. Please reply to the support email to request a new link.' },
  rate_limited: { icon: Clock, tone: 'warning', title: 'Too many attempts', text: 'Please wait a few minutes and try again.' },
  error: { icon: AlertTriangle, tone: 'critical', title: 'Something went wrong', text: 'We could not load the registration form. Please try again later.' },
};
const blockedCode = error => (BLOCKED[error.code] ? error.code : error.status === 404 ? 'invalid' : 'error');

export default function App() {
  const [state, setState] = useState({ phase: 'loading' });
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const formRef = useRef(null);
  // A synchronous guard as well as the disabled button, so a double click cannot submit twice.
  const submitting = useRef(false);

  useEffect(() => {
    let active = true;
    loadRegistration()
      .then(data => active && setState({ phase: 'form', data }))
      .catch(error => active && setState({ phase: 'blocked', code: blockedCode(error) }));
    return () => { active = false; };
  }, []);

  const set = (key, value) => {
    setForm(current => ({ ...current, [key]: value }));
    if (errors[key]) setErrors(current => { const next = { ...current }; delete next[key]; return next; });
  };

  const focusFirstError = found => {
    const first = [...SECTIONS.flatMap(section => section.fields), 'confirm'].find(key => found[key]);
    if (first) requestAnimationFrame(() => formRef.current?.querySelector(`#reg-${first}`)?.focus());
  };

  const reset = () => { setForm(EMPTY_FORM); setErrors({}); setNotice(''); };

  const submit = async event => {
    event.preventDefault();
    if (submitting.current) return;
    const found = validate(form, { regions: state.data.regions });
    setErrors(found);
    setNotice('');
    if (Object.keys(found).length) { setNotice('Please correct the highlighted fields.'); focusFirstError(found); return; }
    submitting.current = true;
    setBusy(true);
    try {
      const result = await submitRegistration(toPayload(form));
      setForm(EMPTY_FORM);
      setState(current => ({ ...current, phase: 'submitted', result, submittedAt: new Date() }));
      window.scrollTo?.({ top: 0 });
    } catch (error) {
      if (error.code === 'validation') { setErrors(error.fields || {}); setNotice('Please correct the highlighted fields.'); focusFirstError(error.fields || {}); }
      else if (['invalid', 'used', 'closed', 'expired', 'processing'].includes(error.code) || error.status === 404) setState({ phase: 'blocked', code: blockedCode(error) });
      else setNotice(error.code === 'rate_limited' ? BLOCKED.rate_limited.text : error.code === 'network' ? 'We could not reach the registration service. Check your connection and try again.' : 'We could not submit your details. Please try again.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const demo = registrationMode === 'demo';

  return <div className="reg-page">
    <header className="reg-top">
      <img className="brand-logo" src="/brand/iplanet-logo.png" alt="iPlanet, Apple Premium Partner" width="297" height="49" />
      {demo && <span className="badge badge-warning reg-mode-badge"><i className="badge-dot" aria-hidden="true" />Demo mode</span>}
    </header>

    <main className={`reg-body${state.phase === 'submitted' ? ' reg-body-wide' : ''}`}>
      {state.phase === 'loading' && <section className="reg-card" role="status" aria-live="polite"><p className="text-muted">Loading the registration form…</p></section>}

      {state.phase === 'blocked' && <Outcome {...BLOCKED[state.code]} />}

      {state.phase === 'submitted' && <div className="reg-confirmation">
      {state.result.mode === 'demo'
        ? <Outcome icon={FlaskConical} tone="warning" title="Demo submission complete">
          <p>The form passed every check. <strong>This was a simulation: nothing was saved, no email was sent and no support ticket was created.</strong></p>
          <p className="text-muted text-small">Simulated reference <span className="mono">{state.result.reference}</span> — not a real registration number.</p>
          <Button variant="secondary" icon={RotateCcw} onClick={() => setState(current => ({ ...current, phase: 'form' }))}>Fill in the form again</Button>
        </Outcome>
        : <Outcome icon={CheckCircle2} tone="success" title="Thank you — your details have been received">
          <p>We will check your details against our purchase records and continue processing your support request{state.result.reference ? <> <span className="mono">{state.result.reference}</span></> : null}. You will receive an email from us once your request has been registered.</p>
          <p className="text-muted text-small">You can close this page. The link cannot be used again.</p>
        </Outcome>}
        <aside className="reg-card reg-journey" aria-labelledby="reg-journey-title">
          <h2 className="reg-journey-title" id="reg-journey-title">Service journey</h2>
          <JourneyTrack steps={registrationJourney({ submittedAt: state.submittedAt })} label="Service journey" />
          <p className="text-muted text-small">{demo ? 'Demo: these steps illustrate what happens next. Nothing was submitted.' : 'We will email you your ticket number once your request is created.'}</p>
        </aside>
      </div>}

      {state.phase === 'form' && <form ref={formRef} className="reg-card" onSubmit={submit} noValidate aria-busy={busy}>
        <h1 className="reg-title">Customer Registration</h1>

        {demo && <InlineAlert tone="warning" title="Demo mode — data is simulated">Submissions are checked in your browser only. Nothing is saved to a database, no email is sent and no ticket is created.</InlineAlert>}
        {notice && <InlineAlert title={notice} />}

        {SECTIONS.map(section => <fieldset key={section.title} className="reg-section" disabled={busy}>
          <legend>{section.title}</legend>
          <p className="reg-section-description">{section.description}</p>
          <div className="reg-grid">
            {section.fields.map(key => {
              const field = FIELDS[key];
              return <Field key={key} id={`reg-${key}`} label={field.label} required={field.required} hint={HINTS[key]} error={errors[key]}>{props => key === 'purchaseRegion'
                ? <select {...props} value={form.purchaseRegion} onChange={event => set('purchaseRegion', event.target.value)}>
                  <option value="">Not sure</option>
                  {state.data.regions.map(region => <option key={region} value={region}>{region}</option>)}
                </select>
                : <input {...props} {...INPUT[key]} name={key} required={field.required} maxLength={field.max} max={key === 'purchaseDate' ? todayIso() : undefined} value={form[key]} onChange={event => set(key, event.target.value)} />}</Field>;
            })}
          </div>
        </fieldset>)}

        <div className={`field reg-confirm-field ${errors.confirm ? 'field-invalid' : ''}`}>
          <label className="reg-confirm"><input id="reg-confirm" type="checkbox" checked={form.confirm} disabled={busy} onChange={event => set('confirm', event.target.checked)} aria-invalid={errors.confirm ? true : undefined} aria-describedby={errors.confirm ? 'reg-confirm-error' : undefined} />I confirm that these details are accurate and belong to me or the person I am contacting support for.<span className="field-required" aria-hidden="true"> *</span></label>
          {errors.confirm && <p className="field-error" id="reg-confirm-error">{errors.confirm}</p>}
        </div>

        <div className="form-actions reg-actions">
          <Button variant="secondary" icon={RotateCcw} onClick={reset} disabled={busy}>Reset</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? <><span className="reg-spinner" aria-hidden="true" />Submitting…</> : 'Submit Registration'}</Button>
        </div>
      </form>}
    </main>

    <footer className="reg-footer text-small">Your details are used only to verify your device and continue your support request.</footer>
  </div>;
}

function Outcome({ icon: Icon = AlertTriangle, tone = 'info', title, text, children }) {
  return <section className={`reg-card reg-outcome reg-outcome-${tone}`} aria-live="polite">
    <span className="reg-outcome-icon" aria-hidden="true"><Icon size={28} /></span>
    <h1>{title}</h1>
    {text && <p>{text}</p>}
    {children}
  </section>;
}
