import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { registerAccount } from '../corporate/api';
import { InlineAlert } from '../ui';
import { AuthLayout, WorkspaceSwitch } from './AuthLayout';
import { workspaceFrom } from './workspace';
import { passwordChecks, validateSignup } from './signupValidation';

const emptyForm = { name: '', email: '', phone: '', organization: '', gstNumber: '', password: '', confirmPassword: '' };
const fieldOrder = ['name', 'email', 'phone', 'organization', 'gstNumber', 'password', 'confirmPassword'];

// One floating-label input in the sign-up card, with its error tied to the input.
function SignupField({ name, label, required = false, error, value, onChange, onBlur, children, inputRef, ...inputProps }) {
  const id = `signup-${name}`;
  const describedBy = [error && `${id}-error`, inputProps['aria-describedby']].filter(Boolean).join(' ') || undefined;
  return <div className="login-field" data-invalid={error ? 'true' : undefined}>
    <label className="login-float" htmlFor={id}>
      <input id={id} ref={inputRef} name={name} placeholder=" " value={value} onChange={event => onChange(name, event.target.value)} onBlur={() => onBlur(name)} required={required} {...inputProps} aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      <span>{label}{required ? <span className="login-required" aria-hidden="true"> *</span> : <span className="login-optional"> (optional)</span>}</span>
      {children}
    </label>
    {error && <p className="login-field-error" id={`${id}-error`}>{error}</p>}
  </div>;
}

export function SignUp() {
  const [searchParams, setSearchParams] = useSearchParams();
  const workspace = workspaceFrom(searchParams);
  const [form, setForm] = useState(emptyForm);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const inputs = useRef({});
  const doneHeading = useRef(null);
  useEffect(() => { document.title = 'Sign up · iPlanet Self-care Portal'; }, []);
  useEffect(() => { if (result) doneHeading.current?.focus(); }, [result]);

  const clientErrors = validateSignup(form);
  const visibleErrors = Object.fromEntries(fieldOrder.map(field => [field, serverErrors[field] || ((submitted || touched[field]) ? clientErrors[field] : '')]).filter(([, message]) => message));
  const update = (field, value) => { setForm(current => ({ ...current, [field]: value })); setServerErrors(current => ({ ...current, [field]: '' })); };
  const blur = field => setTouched(current => ({ ...current, [field]: true }));
  const selectWorkspace = next => { setSearchParams(next === 'service' ? { workspace: 'service' } : {}, { replace: true }); setError(''); };
  const signInLink = `/login${workspace === 'service' ? '?workspace=service' : ''}`;
  const field = (name, label, props) => <SignupField name={name} label={label} error={visibleErrors[name]} value={form[name]} onChange={update} onBlur={blur} inputRef={element => { inputs.current[name] = element; }} {...props} />;

  const submit = async event => {
    event.preventDefault();
    setSubmitted(true);
    setError('');
    const firstInvalid = fieldOrder.find(name => clientErrors[name]);
    if (firstInvalid) { inputs.current[firstInvalid]?.focus(); return; }
    setBusy(true);
    try {
      setResult(await registerAccount({ accountType: workspace === 'service' ? 'service' : 'corporate', ...form }));
    } catch (registerError) {
      const fieldErrors = registerError.body?.errors || {};
      setServerErrors(fieldErrors);
      setError(registerError.message || 'We could not submit your request. Please try again.');
      const firstServerInvalid = fieldOrder.find(name => fieldErrors[name]);
      if (firstServerInvalid) inputs.current[firstServerInvalid]?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (result?.status === 'active') return <AuthLayout>
    <section className="login-card" aria-labelledby="signup-done-title">
      <div className="login-card-head">
        <span className="login-done-icon" aria-hidden="true"><CheckCircle2 size={28} /></span>
        <h2 id="signup-done-title" tabIndex={-1} ref={doneHeading}>Account created</h2>
        <p>{result.message}</p>
      </div>
      <Link className="login-submit" to="/login?workspace=service">Sign in to iPlanet Service<ArrowRight size={17} aria-hidden="true" /></Link>
    </section>
  </AuthLayout>;

  if (result) return <AuthLayout>
    <section className="login-card" aria-labelledby="signup-done-title">
      <div className="login-card-head">
        <span className="login-done-icon" aria-hidden="true"><CheckCircle2 size={28} /></span>
        <h2 id="signup-done-title" tabIndex={-1} ref={doneHeading}>Request submitted</h2>
        <p>{result.message}</p>
      </div>
      <ol className="login-steps">
        <li>An iPlanet administrator checks your details and links your account to your organization.</li>
        <li>Once approved, sign in with the email address and password you just chose.</li>
      </ol>
      <p className="login-note"><span>Your account is not active until it has been approved.</span></p>
      <Link className="login-submit" to="/login">Back to sign in<ArrowRight size={17} aria-hidden="true" /></Link>
    </section>
  </AuthLayout>;

  const checks = passwordChecks(form.password);
  return <AuthLayout>
    <form className="login-card" onSubmit={submit} noValidate aria-labelledby="signup-title">
      <div className="login-card-head">
        <h2 id="signup-title">Create account</h2>
        <p>{workspace === 'service' ? 'Create your iPlanet Service account with your iPlanet work email. You can sign in straight away.' : 'Request access for your organisation. An iPlanet administrator approves each new account.'}</p>
      </div>
      <WorkspaceSwitch value={workspace} onChange={selectWorkspace} />
      <div className="login-fields">
        {field('name', 'Full name', { required: true, autoComplete: 'name', maxLength: 100 })}
        {field('email', 'Work email address', { required: true, type: 'email', autoComplete: 'email', maxLength: 254 })}
        {field('phone', 'Mobile number', { required: true, type: 'tel', autoComplete: 'tel', inputMode: 'tel', maxLength: 20 })}
        {field('organization', 'Organization', { required: true, autoComplete: 'organization', maxLength: 120 })}
        {field('gstNumber', 'GSTIN', { required: true, autoComplete: 'off', autoCapitalize: 'characters', spellCheck: false, maxLength: 15 })}
      </div>
      <div className="login-fields">
        {field('password', 'Password', { required: true, type: showPassword ? 'text' : 'password', autoComplete: 'new-password', maxLength: 128, 'aria-describedby': 'signup-password-rules',
          children: <button type="button" className="login-reveal" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}</button> })}
        {field('confirmPassword', 'Confirm password', { required: true, type: showPassword ? 'text' : 'password', autoComplete: 'new-password', maxLength: 128 })}
      </div>
      <ul className="login-rules" id="signup-password-rules" aria-label="Password requirements">
        {checks.map(check => <li key={check.key} data-met={check.met ? 'true' : undefined}><Check size={14} aria-hidden="true" />{check.label}<span className="sr-only">{check.met ? ' (met)' : ' (not yet met)'}</span></li>)}
      </ul>
      {error && <InlineAlert title={workspace === 'service' ? 'Account not created' : 'Request not submitted'}>{error}</InlineAlert>}
      <button className="login-submit" type="submit" disabled={busy}>{busy ? <><span className="login-spinner" aria-hidden="true" />Creating account…</> : <>Create account<ArrowRight size={17} aria-hidden="true" /></>}</button>
      <p className="login-switch">Already have an account? <Link to={signInLink}>Sign in</Link></p>
    </form>
  </AuthLayout>;
}
