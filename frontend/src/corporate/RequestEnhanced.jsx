import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Camera, CheckCircle2, FilePlus2, HeartPulse, ImagePlus, Pencil, Recycle, RefreshCcw, Search, Trash2, Wrench, BadgeIndianRupee } from 'lucide-react';
import { Shell } from './components';
import { createTicket, getAiPreparedRequest, getDevices, uploadAnnotatedImages, uploadImages } from './api';
import { ImageAnnotator } from './ImageAnnotator';
import { Badge, Button, Card, DeviceIcon, EmptyState, ErrorState, Field, InfoList, InlineAlert, PageHeader, Scanner, Skeleton, Stepper, formatDate, friendlyError, useAIAssistant } from '../ui';

const locations = ['Chennai', 'Coimbatore', 'Bengaluru', 'Madurai'];
const issueTypes = ['Screen / Display', 'Battery', 'Charging', 'Keyboard', 'Trackpad', 'Camera', 'Speaker', 'Software', 'Performance', 'Physical Damage', 'Other'];
const priorities = ['Low', 'Medium', 'High', 'Critical'];
const categories = [
  { value: 'Service', icon: Wrench, hint: 'Repair or diagnose a device' },
  { value: 'Health Camp', icon: HeartPulse, hint: 'On-site device health check' },
  { value: 'Buyback', icon: BadgeIndianRupee, hint: 'Trade in a device' },
  { value: 'E-Waste', icon: Recycle, hint: 'Responsible disposal' },
];
const steps = ['Identify', 'Details', 'Evidence', 'Review'];

function todayInIndia() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const annotatedName = file => `annotated-${file.name}`;

function PhotoCard({ file, annotation, onAnnotate, onRemove }) {
  const url = useMemo(() => URL.createObjectURL(annotation || file), [file, annotation]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <article className="photo-card">
    <div className="photo-card-image"><img src={url} alt={`Issue photo ${file.name}`} />{annotation && <Badge tone="warning">Annotated</Badge>}</div>
    <div className="photo-card-body">
      <span title={file.name}>{file.name}</span>
      <div className="photo-card-actions">
        <Button size="sm" icon={Pencil} onClick={onAnnotate}>{annotation ? 'Edit' : 'Mark damage'}</Button>
        <button type="button" className="icon-button" aria-label={`Remove ${file.name}`} title="Remove photo" onClick={onRemove}><Trash2 size={16} /></button>
      </div>
    </div>
  </article>;
}

export function RequestEnhanced() {
  const route = useLocation();
  const ai = useAIAssistant();
  const presetDevice = new URLSearchParams(route.search).get('device');
  const [aiRequest, setAiRequest] = useState(route.state?.aiRequest || null);
  const [devices, setDevices] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [device, setDevice] = useState(null);
  const [serial, setSerial] = useState('');
  const [files, setFiles] = useState([]);
  const [annotated, setAnnotated] = useState([]);
  const [editing, setEditing] = useState(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [form, setForm] = useState({ category: 'Service', issueType: 'Screen / Display', description: '', location: 'Chennai', preferredServiceDate: todayInIndia(), priority: 'Medium', deviceId: '' });
  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');

  const loadDevices = () => { setLoadError(null); getDevices().then(setDevices).catch(setLoadError); };
  useEffect(() => { loadDevices(); }, []);
  useEffect(() => { const id = new URLSearchParams(route.search).get('conversationId'); if (!aiRequest && id) getAiPreparedRequest(id).then(result => setAiRequest(result.requestData)).catch(() => setError('The AI-prepared request is unavailable. You can continue manually.')); }, [aiRequest, route.search]);
  useEffect(() => {
    if (!aiRequest || !devices) return;
    const match = devices.find(item => item._id === aiRequest.deviceId);
    if (!match) return;
    setDevice(match);
    setSerial(match.serialNumber);
    setForm(current => ({ ...current, ...aiRequest, deviceId: match._id, preferredServiceDate: aiRequest.preferredServiceDate || '' }));
    setStep(1);
  }, [aiRequest, devices]);
  useEffect(() => {
    if (!presetDevice || !devices || aiRequest) return;
    const match = devices.find(item => item._id === presetDevice);
    if (match) { setDevice(match); setSerial(match.serialNumber); setForm(current => ({ ...current, deviceId: match._id, location: locations.includes(match.location) ? match.location : current.location })); }
  }, [presetDevice, devices, aiRequest]);

  const selectDevice = match => {
    setDevice(match || null);
    setForm(current => ({ ...current, deviceId: match?._id || '', ...(match && locations.includes(match.location) ? { location: match.location } : {}) }));
  };
  const lookup = value => {
    setSerial(value);
    selectDevice(devices?.find(item => item.serialNumber.toLowerCase() === value.trim().toLowerCase()));
  };
  const onScanned = useCallback(value => {
    setScanOpen(false);
    setSerial(value);
    const match = devices?.find(item => item.serialNumber.toLowerCase() === value.trim().toLowerCase());
    setDevice(match || null);
    setForm(current => ({ ...current, deviceId: match?._id || '', ...(match && locations.includes(match.location) ? { location: match.location } : {}) }));
  }, [devices]);
  const closeScanner = useCallback(() => setScanOpen(false), []);
  const suggestions = useMemo(() => {
    const term = serial.trim().toLowerCase();
    if (!devices || device || term.length < 2) return [];
    return devices.filter(item => [item.serialNumber, item.model, item.assetId, item.employeeName].some(value => String(value || '').toLowerCase().includes(term))).slice(0, 6);
  }, [devices, serial, device]);

  const chooseFiles = event => { const next = [...event.target.files]; setFiles(current => [...current, ...next.filter(file => !current.some(item => item.name === file.name))]); event.target.value = ''; };
  const removeFile = file => { setFiles(current => current.filter(item => item !== file)); setAnnotated(current => current.filter(item => item.name !== annotatedName(file))); };
  const saveAnnotation = file => { setAnnotated(current => [...current.filter(item => item.name !== file.name), file]); setEditing(null); };

  const canContinue = [Boolean(form.deviceId), Boolean(form.description.trim()), true, Boolean(form.deviceId && form.description.trim())];
  const next = () => { if (!canContinue[step]) { setTouched(true); return; } setTouched(false); setStep(current => Math.min(steps.length - 1, current + 1)); };
  const back = () => setStep(current => Math.max(0, current - 1));

  const submit = async () => {
    if (!form.deviceId || !form.description.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    let ticket;
    try {
      ticket = await createTicket(form);
    } catch (submitError) {
      setError(friendlyError(submitError, 'Unable to submit your request. Please try again.'));
      setSubmitting(false);
      return;
    }
    // The request exists at this point; an upload failure must not trigger a
    // duplicate submission, so it is reported on the confirmation instead.
    let uploadError = '';
    try {
      await uploadImages(ticket._id, files);
      await uploadAnnotatedImages(ticket._id, annotated);
    } catch (imageError) {
      uploadError = friendlyError(imageError, 'Photos could not be uploaded.');
    }
    setDone({ ticket, uploadError });
    setSubmitting(false);
  };

  const reset = () => { setDone(null); setDevice(null); setSerial(''); setFiles([]); setAnnotated([]); setForm(current => ({ ...current, description: '', deviceId: '', preferredServiceDate: todayInIndia() })); setStep(0); setAiRequest(null); };

  if (done) return <Shell title="Raise Request" crumbs={[{ label: 'Raise Request' }]}>
    <div className="card"><div className="success-panel">
      <span className="success-mark"><CheckCircle2 size={26} aria-hidden="true" /></span>
      <h2>Service request submitted</h2>
      <p>iPlanet Service has received your request and will review it shortly. You'll be notified as it progresses.</p>
      <InfoList items={[['Request ID', <span className="mono">{done.ticket.ticketId}</span>], ['Device', device?.model], ['Category', form.category], ['Status', <Badge dot>Open</Badge>]]} />
      {done.uploadError && <InlineAlert tone="warning" title="Photos were not attached">{done.uploadError} You can share them with the service team when they contact you.</InlineAlert>}
      <div className="row" style={{ justifyContent: 'center' }}>
        <Button icon={FilePlus2} onClick={reset}>Raise another request</Button>
        <Button variant="primary" to={`/corporate/service-requests/${done.ticket._id}`}>View request</Button>
      </div>
    </div></div>
  </Shell>;

  const annotationFor = file => annotated.find(item => item.name === annotatedName(file));

  return <Shell title="Raise Request">
    <PageHeader title="Raise Request" description="Tell us which device needs attention and what's happening." />
    {aiRequest && <InlineAlert tone="info" title="Prepared from your AI Support conversation">Review the details before submitting.</InlineAlert>}
    <Stepper steps={steps} current={step} onStepClick={setStep} />
    {error && <InlineAlert title={error} />}

    <div className="wizard">
      <div className="wizard-main">
        <Card className="wizard-card" title={[
          'Which device needs attention?',
          'What do you need?',
          'Show us the issue.',
          'Review your request.',
        ][step]} description={[
          'Enter or scan the serial number. Device details fill in automatically.',
          'Choose the request type and describe what’s happening.',
          'Add photos and mark the damaged area. This step is optional.',
          'Check the details before submitting.',
        ][step]}>
          {step === 0 && (loadError ? <ErrorState compact title="Unable to load your devices" message={friendlyError(loadError)} onRetry={loadDevices} />
            : !devices ? <div className="stack-12"><Skeleton height={46} /><Skeleton height={80} /></div>
            : <div className="stack-24">
              <div className="lookup-row">
                <Field label="Serial number" hint="You can also search by model, asset ID or employee." error={touched && !form.deviceId ? 'Select a device to continue.' : undefined}>
                  {props => <div className="lookup-input"><Search size={17} aria-hidden="true" /><input {...props} className="mono-input" value={serial} onChange={event => lookup(event.target.value)} placeholder="e.g. C02ZK3C1ABCD" autoComplete="off" data-autofocus /></div>}
                </Field>
                <Button icon={Camera} className="btn-lg" onClick={() => setScanOpen(true)}>Scan</Button>
              </div>
              {device ? <div className="stack-16">
                <div className="device-card">
                  <span className="device-card-icon"><DeviceIcon type={device.deviceType} model={device.model} /></span>
                  <div className="device-card-body"><strong>{device.model}</strong><span className="mono">{device.serialNumber}</span></div>
                  <Button size="sm" variant="ghost" icon={RefreshCcw} onClick={() => lookup('')}>Change</Button>
                </div>
                <InfoList columns={2} items={[['Device type', device.deviceType], ['Asset ID', device.assetId], ['Employee', device.employeeName || 'Unassigned'], ['Location', device.location], ['Warranty', <Badge>{device.warrantyStatus}</Badge>], ['AMC', <Badge>{device.amcStatus}</Badge>]]} />
              </div> : suggestions.length > 0 ? <div className="stack-8">
                <p className="subheading" style={{ margin: 0 }}>Matching devices</p>
                <div className="device-options" role="listbox" aria-label="Matching devices">{suggestions.map(item => <button type="button" role="option" aria-selected="false" key={item._id} className="device-option" onClick={() => { setSerial(item.serialNumber); selectDevice(item); }}>
                  <span><strong>{item.model}</strong><span><span className="mono">{item.serialNumber}</span> · {item.employeeName || 'Unassigned'}</span></span><ArrowRight size={16} aria-hidden="true" />
                </button>)}</div>
              </div> : serial.trim().length >= 2 ? <EmptyState compact icon={Search} title="No device found" description="Check the serial number, or scan the barcode on the device." /> : null}
            </div>)}

          {step === 1 && <div className="stack-24">
            <div className="field"><span className="field-label">Request type</span>
              <div className="choice-grid" role="group" aria-label="Request type">{categories.map(item => <button type="button" key={item.value} className="choice" aria-pressed={form.category === item.value} onClick={() => setForm({ ...form, category: item.value })}><item.icon size={20} aria-hidden="true" /><strong>{item.value}</strong><span>{item.hint}</span></button>)}</div>
            </div>
            <div className="form-grid">
              <Field label="Issue type">{props => <select {...props} value={form.issueType} onChange={event => setForm({ ...form, issueType: event.target.value })}>{issueTypes.map(item => <option key={item}>{item}</option>)}</select>}</Field>
              <Field label="Priority" hint="Sets the resolution target.">{props => <select {...props} value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value })}>{priorities.map(item => <option key={item}>{item}</option>)}</select>}</Field>
              <Field className="span-2" label="Description" required hint="What is happening, when it started, and anything you've tried." error={touched && !form.description.trim() ? 'Describe the issue to continue.' : undefined}>
                {props => <textarea {...props} required maxLength={4000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder="e.g. The display flickers after waking from sleep. Started last week." />}
              </Field>
              <Field label="Service location">{props => <select {...props} value={form.location} onChange={event => setForm({ ...form, location: event.target.value })}>{locations.map(item => <option key={item}>{item}</option>)}</select>}</Field>
              <Field label="Preferred service date">{props => <input {...props} type="date" min={todayInIndia()} value={form.preferredServiceDate} onChange={event => setForm({ ...form, preferredServiceDate: event.target.value })} />}</Field>
            </div>
          </div>}

          {step === 2 && <div className="stack-16">
            <label className="dropzone">
              <span className="dropzone-icon" aria-hidden="true"><ImagePlus size={20} /></span>
              <strong>Add photos</strong>
              <span>PNG, JPG or WebP, up to 5 MB each.</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={chooseFiles} aria-label="Upload issue photos" />
            </label>
            {files.length > 0 && <div className="photo-grid">{files.map(file => <PhotoCard key={file.name} file={file} annotation={annotationFor(file)} onAnnotate={() => setEditing(file)} onRemove={() => removeFile(file)} />)}</div>}
          </div>}

          {step === 3 && <div className="review-summary">
            <div className="review-section"><div className="review-section-head"><h3>Device</h3><Button size="sm" variant="ghost" onClick={() => setStep(0)}>Edit</Button></div>
              <InfoList columns={2} items={[['Device', device?.model], ['Serial number', <span className="mono">{device?.serialNumber}</span>], ['Employee', device?.employeeName || 'Unassigned'], ['Coverage', device ? `${device.warrantyStatus} warranty · ${device.amcStatus} AMC` : '']]} /></div>
            <div className="review-section"><div className="review-section-head"><h3>Details</h3><Button size="sm" variant="ghost" onClick={() => setStep(1)}>Edit</Button></div>
              <InfoList columns={2} items={[['Request type', form.category], ['Issue type', form.issueType], ['Priority', <Badge>{form.priority}</Badge>], ['Location', form.location], ['Preferred date', formatDate(form.preferredServiceDate, 'No preference')]]} />
              <p className="description-text" style={{ marginTop: 8 }}>{form.description}</p></div>
            <div className="review-section"><div className="review-section-head"><h3>Evidence</h3><Button size="sm" variant="ghost" onClick={() => setStep(2)}>Edit</Button></div>
              <p className="text-muted">{files.length ? `${files.length} photo${files.length === 1 ? '' : 's'}${annotated.length ? `, ${annotated.length} marked` : ''}` : 'No photos attached'}</p></div>
          </div>}
        </Card>

        <div className="wizard-footer">
          {step > 0 ? <Button icon={ArrowLeft} onClick={back} disabled={submitting}>Back</Button> : <Button to="/corporate/service-requests" variant="ghost">Cancel</Button>}
          <span className="spacer" />
          {step < 2 && <Button variant="primary" onClick={next}>Continue<ArrowRight size={16} aria-hidden="true" /></Button>}
          {step === 2 && <Button variant="primary" onClick={next}>Review request<ArrowRight size={16} aria-hidden="true" /></Button>}
          {step === 3 && <Button variant="primary" icon={CheckCircle2} onClick={submit} disabled={submitting || !canContinue[3]}>{submitting ? 'Submitting…' : 'Submit request'}</Button>}
        </div>
      </div>

      <aside className="wizard-aside">
        {device && <Card title="Selected device"><div className="stack-12">
          <div className="person-cell"><span className="thumb thumb-lg"><DeviceIcon type={device.deviceType} model={device.model} /></span><div><strong>{device.model}</strong><span className="cell-sub mono">{device.serialNumber}</span></div></div>
          <div className="row"><Badge>{`Warranty ${device.warrantyStatus || '—'}`}</Badge><Badge>{`AMC ${device.amcStatus || '—'}`}</Badge></div>
        </div></Card>}
        <Card title="What happens next"><ol className="guide-list">
          <li className="guide-item"><span className="num">1</span><div><strong>iPlanet Service reviews it</strong>With the device and coverage record attached.</div></li>
          <li className="guide-item"><span className="num">2</span><div><strong>An engineer is assigned</strong>Targets are set by priority.</div></li>
          <li className="guide-item"><span className="num">3</span><div><strong>You're kept informed</strong>Every update appears in Notifications.</div></li>
        </ol></Card>
        <p className="text-muted text-small" style={{ padding: '0 4px' }}>Not sure what's wrong? <button type="button" className="btn-link" onClick={ai.open}>Ask AI Support</button> first.</p>
      </aside>
    </div>
    {scanOpen && <Scanner onDetected={onScanned} onClose={closeScanner} />}
    {editing && <ImageAnnotator file={editing} onSave={saveAnnotation} onCancel={() => setEditing(null)} />}
  </Shell>;
}
