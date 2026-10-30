import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, ShieldCheck } from 'lucide-react';
import { Button, Field, InlineAlert } from '../ui';
import { openRegistration, renewRegistration, submitRegistration } from './api';

// The page a customer reaches from the registration email. It is public: the token in the
// link is the only credential, and the server checks it on every request — this page never
// decides on its own that a link is valid. No staff navigation, session or data is used.

const EMPTY = { name: '', email: '', phone: '', alternatePhone: '', serialNumber: '', brand: '', model: '', purchaseDate: '', purchaseLocation: '', purchaseRegion: '', dealer: '', invoiceNumber: '', confirm: false };
const SECTIONS = [
  { title: 'Your details', fields: ['name', 'email', 'phone', 'alternatePhone'] },
  { title: 'Your mobile device', fields: ['serialNumber', 'brand', 'model'] },
  { title: 'Purchase details', fields: ['purchaseDate', 'purchaseLocation', 'purchaseRegion', 'dealer', 'invoiceNumber'] },
];
const INPUT = {
  name: { autoComplete: 'name' },
  email: { type: 'email', autoComplete: 'email', inputMode: 'email' },
  phone: { type: 'tel', autoComplete: 'tel', inputMode: 'tel', placeholder: '+91 98765 43210' },
  alternatePhone: { type: 'tel', inputMode: 'tel' },
  serialNumber: { autoCapitalize: 'characters', spellCheck: false, className: 'mono' },
  purchaseDate: { type: 'date' },
};
const HINTS = {
  serialNumber: 'Shown on the box, the invoice, or in Settings › General › About on the device.',
  purchaseLocation: 'The store name and city where you bought the device.',
  purchaseRegion: 'Optional. We confirm the region from our purchase records.',
  invoiceNumber: 'Optional, as printed on your invoice or order confirmation.',
};
const STATES = {
  invalid: { icon: AlertTriangle, tone: 'critical', title: 'This link is not valid', text: 'Please use the link in the most recent registration email from our support team. If you received more than one, only the latest link works.' },
  used: { icon: CheckCircle2, tone: 'success', title: 'Registration already received', text: 'This link has already been used. Our support team is processing your details, and you will hear from us by email.' },
  closed: { icon: CheckCircle2, tone: 'info', title: 'Registration is no longer needed', text: 'Our support team is already handling your request. You do not need to do anything further.' },
  processing: { icon: Clock, tone: 'info', title: 'Your details are being processed', text: 'Please wait a moment and refresh this page.' },
  expired: { icon: Clock, tone: 'warning', title: 'This link has expired', text: 'For your security, registration links expire after a limited time.' },
  rate_limited: { icon: Clock, tone: 'warning', title: 'Too many attempts', text: 'Please wait a few minutes and try again.' },
  error: { icon: AlertTriangle, tone: 'critical', title: 'Something went wrong', text: 'We could not load the registration form. Please try again later.' },
};

// Checks before sending, so obvious mistakes are shown at once. The server repeats every check.
function checkLocally(form, fields) {
  const errors = {};
  for (const field of fields) {
    const value = String(form[field.key] ?? '').trim();
    if (field.required && !value) errors[field.key] = `${field.label} is required.`;
    else if (value.length > field.maxLength) errors[field.key] = `${field.label} must be ${field.maxLength} characters or fewer.`;
  }
  if (!errors.email && form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = 'Enter a valid email address.';
  if (!errors.phone && form.phone && form.phone.replace(/\D/g, '').length < 10) errors.phone = 'Enter a valid mobile number, e.g. +91 98765 43210.';
  if (!form.confirm) errors.confirm = 'Confirm that the details are accurate.';
  return errors;
}

export function CustomerRegistration() {
  const { token } = useParams();
  const [state, setState] = useState({ phase: 'loading' });
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  // The token is in the address bar: keep it out of referrers and search engines.
  useEffect(() => {
    const metas = [['referrer', 'no-referrer'], ['robots', 'noindex, nofollow']].map(([name, content]) => {
      const meta = Object.assign(document.createElement('meta'), { name, content });
      document.head.appendChild(meta);
      return meta;
    });
    const title = document.title;
    document.title = 'Customer registration';
    return () => { metas.forEach(meta => meta.remove()); document.title = title; };
  }, []);

  useEffect(() => {
    let active = true;
    openRegistration(token)
      .then(data => active && setState({ phase: 'form', data }))
      .catch(error => active && setState({ phase: 'blocked', code: STATES[error.code] ? error.code : error.status === 429 ? 'rate_limited' : error.status === 404 ? 'invalid' : 'error', canRenew: error.canRenew }));
    return () => { active = false; };
  }, [token]);

  const set = (key, value) => {
    setForm(current => ({ ...current, [key]: value }));
    if (errors[key]) setErrors(current => { const next = { ...current }; delete next[key]; return next; });
  };

  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    const local = checkLocally(form, state.data.fields);
    setErrors(local);
    setNotice('');
    if (Object.keys(local).length) { setNotice('Please correct the highlighted fields.'); return; }
    setBusy(true);
    try {
      const result = await submitRegistration(token, { ...form, confirm: form.confirm === true });
      setForm(EMPTY);
      setState({ phase: 'submitted', reference: result.reference });
      window.scrollTo?.({ top: 0 });
    } catch (error) {
      if (error.code === 'validation') { setErrors(error.fields || {}); setNotice('Please correct the highlighted fields.'); }
      else if (STATES[error.code] || error.status === 404) setState({ phase: 'blocked', code: error.code || 'invalid', canRenew: error.canRenew });
      else setNotice(error.status === 429 ? STATES.rate_limited.text : 'We could not submit your details. Please try again.');
    } finally { setBusy(false); }
  };

  const renew = async () => {
    setBusy(true);
    try { await renewRegistration(token); setState(current => ({ ...current, renewed: true })); }
    catch (error) { setState(current => ({ ...current, renewError: error.status === 429 ? STATES.rate_limited.text : 'We could not request a new link. Please try again later.' })); }
    finally { setBusy(false); }
  };

  return <main className="b2c-register">
    <header className="b2c-register-top">
      <img className="brand-logo" src="/brand/iplanet-logo.png" alt="iPlanet, Apple Premium Partner" width="297" height="49" />
      <span>Support</span>
    </header>
    <div className="b2c-register-body">
      {state.phase === 'loading' && <div className="b2c-register-card" role="status" aria-live="polite"><p className="text-muted">Checking your registration link…</p></div>}
      {state.phase === 'blocked' && <Outcome {...STATES[state.code]}>
        {state.code === 'expired' && (state.renewed
          ? <InlineAlert tone="success" title="Request received">If this link can be renewed, a new link has been sent to the email address the original was sent to.</InlineAlert>
          : state.canRenew === false
            ? <p className="text-muted">Please contact our support team to continue with your request.</p>
            : <>{state.renewError && <InlineAlert title={state.renewError} />}<Button variant="primary" disabled={busy} onClick={renew}>{busy ? 'Requesting…' : 'Email me a new link'}</Button></>)}
      </Outcome>}
      {state.phase === 'submitted' && <Outcome icon={CheckCircle2} tone="success" title="Thank you — your details have been received">
        <p>We will check your details against our purchase records and continue processing your support request{state.reference ? <> <span className="mono">{state.reference}</span></> : null}. You will receive an email from us once your request has been registered.</p>
        <p className="text-muted text-small">You can close this page. The link cannot be used again.</p>
      </Outcome>}
      {state.phase === 'form' && <form className="b2c-register-card" onSubmit={submit} noValidate>
        <div className="b2c-register-intro">
          <p className="b2c-register-eyebrow"><ShieldCheck size={16} aria-hidden="true" />Secure registration{state.data.reference ? <> · <span className="mono">{state.data.reference}</span></> : null}</p>
          <h1>Complete your registration</h1>
          <p>We could not match your email with our customer records. Please enter your details and the details of your mobile purchase so that we can identify your device and send your request to the right regional support team.</p>
          <p className="text-muted text-small">Fields marked * are required. If you believe you are already registered, please contact our support team instead of submitting duplicate details.{state.data.expiresAt ? ` This link expires on ${new Date(state.data.expiresAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.` : ''}</p>
        </div>
        {notice && <InlineAlert title={notice} />}
        {SECTIONS.map(section => <fieldset key={section.title} className="b2c-register-section">
          <legend>{section.title}</legend>
          <div className="b2c-register-grid">
            {section.fields.map(key => {
              const field = state.data.fields.find(item => item.key === key);
              if (!field) return null;
              return <Field key={key} label={field.label} required={field.required} hint={HINTS[key]} error={errors[key]}>{props => key === 'purchaseRegion'
                ? <select {...props} value={form.purchaseRegion} onChange={event => set('purchaseRegion', event.target.value)}>
                  <option value="">Not sure</option>
                  {state.data.regions.map(region => <option key={region} value={region}>{region}</option>)}
                </select>
                : <input {...props} {...INPUT[key]} required={field.required} maxLength={field.maxLength} value={form[key]} onChange={event => set(key, event.target.value)} />}</Field>;
            })}
          </div>
        </fieldset>)}
        <div className={`field ${errors.confirm ? 'field-invalid' : ''}`}>
          <label className="b2c-register-confirm"><input type="checkbox" checked={form.confirm} onChange={event => set('confirm', event.target.checked)} aria-describedby={errors.confirm ? 'confirm-error' : undefined} />I confirm that these details are accurate and belong to me or the person I am contacting support for.</label>
          {errors.confirm && <p className="field-error" id="confirm-error">{errors.confirm}</p>}
        </div>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit registration'}</Button>
      </form>}
    </div>
  </main>;
}

function Outcome({ icon: Icon = AlertTriangle, tone = 'info', title, text, children }) {
  return <section className={`b2c-register-card b2c-register-outcome b2c-register-${tone}`} aria-live="polite">
    <span className="b2c-register-outcome-icon" aria-hidden="true"><Icon size={28} /></span>
    <h1>{title}</h1>
    {text && <p>{text}</p>}
    {children}
  </section>;
}
