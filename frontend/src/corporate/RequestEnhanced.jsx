import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Camera, CheckCircle2, FilePlus2, HeartPulse, ImagePlus, Pencil, Recycle, RefreshCcw, Search, Trash2, Wrench } from 'lucide-react';
import { Shell } from './components';
import { createTicket, getAiPreparedRequest, getDevices, getServiceRecommendation, getTickets, uploadAnnotatedImages, uploadImages } from './api';
import { ImageAnnotator } from './ImageAnnotator';
import { Badge, Button, Card, CoverageTiles, DeviceIcon, EmptyState, ErrorState, Field, InfoList, InlineAlert, PageHeader, Scanner, Skeleton, Stepper, canRespond, formatDate, friendlyError, idOf, isActiveTicket, useAIAssistant } from '../ui';
import { BUYBACK_EWASTE, LEGACY_BUYBACK_EWASTE, ON_SITE_LEAD_DAYS, ON_SITE_MAX_DEVICES, detailsErrors, earliestServiceDate as earliestFrom, isOnSite, nextStep, previousStep, requestPayload, requestSteps, stepLabels, stepValid } from './requestFlow';

const locations = ['Chennai', 'Coimbatore', 'Bengaluru', 'Madurai'];
const issueTypes = ['Screen / Display', 'Battery', 'Charging', 'Keyboard', 'Trackpad', 'Camera', 'Speaker', 'Software', 'Performance', 'Physical Damage', 'Other'];
const priorities = ['Low', 'Medium', 'High', 'Critical'];
const categories = [
  { value: 'Service', icon: Wrench, hint: 'Repair or diagnose a device' },
  { value: 'Health Camp', icon: HeartPulse, hint: 'On-site device health check' },
  { value: BUYBACK_EWASTE, icon: Recycle, hint: 'Trade in or responsibly dispose of devices' },
];
const stepTitles = { details: 'What do you need?', evidence: 'Show us the issue.', review: 'Review your request.' };
const stepDescriptions = {
  details: 'Choose the request type and describe what’s happening.',
  evidence: 'Add photos and mark the damaged area. This step is optional.',
  review: 'Check the details, then submit. You can edit any section.',
};

function todayInIndia() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
const earliestServiceDate = category => earliestFrom(category, todayInIndia());

const annotatedName = file => `annotated-${file.name}`;
// The server accepts up to 5 photos of 5 MB each per upload.
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
// Phone cameras name every capture "image.jpg". Photos are matched to their annotations by
// name, so a repeated name gets a numbered suffix instead of being dropped.
function withUniqueName(file, takenNames) {
  if (!takenNames.has(file.name)) return file;
  const dot = file.name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [file.name.slice(0, dot), file.name.slice(dot)] : [file.name, ''];
  let index = 2;
  while (takenNames.has(`${base}-${index}${ext}`)) index += 1;
  return new File([file], `${base}-${index}${ext}`, { type: file.type, lastModified: file.lastModified });
}

// Starting text for a request raised from a preventive-service recommendation.
// The customer can edit all of it before submitting.
function recommendationDescription(item) {
  const coverage = [
    `Warranty: ${item.coverage.warrantyStatus || 'not on record'}${item.coverage.warrantyExpiry ? ` (until ${formatDate(item.coverage.warrantyExpiry)})` : ''}`,
    `AMC: ${item.coverage.amcStatus || 'not on record'}${item.coverage.amcExpiry ? ` (until ${formatDate(item.coverage.amcExpiry)})` : ''}`,
  ];
  return [
    'Preventive service requested following the iPlanet service recommendation.',
    `Recommended service date: ${formatDate(item.nextServiceDate)}.${item.scheduledDate ? ` Scheduled with iPlanet Service for ${formatDate(item.scheduledDate)}.` : ''}`,
    `Last service: ${formatDate(item.lastServiceDate, 'none recorded')}.`,
    `${coverage.join('. ')}.`,
  ].join('\n');
}

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
  const navigate = useNavigate();
  const ai = useAIAssistant();
  const presetDevice = new URLSearchParams(route.search).get('device');
  const followUpId = new URLSearchParams(route.search).get('serviceFollowUp');
  const [recommendation, setRecommendation] = useState(null);
  const [aiRequest, setAiRequest] = useState(route.state?.aiRequest || null);
  const [devices, setDevices] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [device, setDevice] = useState(null);
  const [serial, setSerial] = useState('');
  const [files, setFiles] = useState([]);
  const [annotated, setAnnotated] = useState([]);
  const [editing, setEditing] = useState(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [form, setForm] = useState({ category: 'Service', issueType: 'Screen / Display', description: '', location: 'Chennai', preferredServiceDate: todayInIndia(), priority: 'Medium', deviceId: '', deviceCount: '' });
  const [step, setStep] = useState('details');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');

  const [openTickets, setOpenTickets] = useState([]);
  const loadDevices = () => {
    setLoadError(null);
    getDevices().then(setDevices).catch(setLoadError);
    // Only used to warn about an existing open request for the chosen device.
    getTickets().then(tickets => setOpenTickets(tickets.filter(isActiveTicket))).catch(() => setOpenTickets([]));
  };
  useEffect(() => { loadDevices(); }, []);
  useEffect(() => { const id = new URLSearchParams(route.search).get('conversationId'); if (!aiRequest && id) getAiPreparedRequest(id).then(result => setAiRequest(result.requestData)).catch(() => setError('The AI-prepared request is unavailable. You can continue manually.')); }, [aiRequest, route.search]);
  useEffect(() => {
    if (!aiRequest || !devices) return;
    const match = devices.find(item => item._id === aiRequest.deviceId);
    if (!match) return;
    setDevice(match);
    setSerial(match.serialNumber);
    setForm(current => ({ ...current, ...aiRequest, ...(LEGACY_BUYBACK_EWASTE.includes(aiRequest.category) ? { category: BUYBACK_EWASTE } : {}), deviceId: match._id, preferredServiceDate: aiRequest.preferredServiceDate || '', location: locations.includes(aiRequest.location) ? aiRequest.location : current.location }));
  }, [aiRequest, devices]);
  useEffect(() => {
    if (!followUpId) return;
    getServiceRecommendation(followUpId).then(setRecommendation).catch(loadFailure => setError(friendlyError(loadFailure, 'This service recommendation is no longer available. You can still raise a request manually.')));
  }, [followUpId]);
  // A recommendation pre-fills the normal request; nothing is submitted until the customer reviews it.
  useEffect(() => {
    if (!recommendation || !devices || aiRequest) return;
    const match = devices.find(item => item._id === recommendation.deviceId);
    if (!match) return;
    const today = todayInIndia();
    const preferred = recommendation.scheduledDate || (recommendation.nextServiceDate && recommendation.nextServiceDate > today ? recommendation.nextServiceDate : today);
    setDevice(match);
    setSerial(match.serialNumber);
    setForm(current => ({ ...current, deviceId: match._id, category: 'Service', issueType: 'Other', description: recommendationDescription(recommendation), preferredServiceDate: preferred, ...(locations.includes(match.location) ? { location: match.location } : {}) }));
  }, [recommendation, devices, aiRequest]);
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
    return devices.filter(item => [item.serialNumber, item.model, item.assetId].some(value => String(value || '').toLowerCase().includes(term))).slice(0, 6);
  }, [devices, serial, device]);

  const chooseFiles = event => {
    const chosen = [...event.target.files];
    event.target.value = '';
    const tooLarge = chosen.filter(file => file.size > MAX_PHOTO_BYTES);
    const accepted = [];
    const taken = new Set(files.map(file => file.name));
    for (const file of chosen.filter(item => item.size <= MAX_PHOTO_BYTES)) {
      if (files.length + accepted.length >= MAX_PHOTOS) break;
      // The same photo picked twice is skipped; a different photo with the same name is kept.
      if (files.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) continue;
      const unique = withUniqueName(file, taken);
      taken.add(unique.name);
      accepted.push(unique);
    }
    const skipped = chosen.length - tooLarge.length - accepted.length;
    setError([tooLarge.length ? `${tooLarge.length} photo${tooLarge.length === 1 ? ' is' : 's are'} larger than 5 MB and ${tooLarge.length === 1 ? 'was' : 'were'} not added.` : '', skipped > 0 && files.length + accepted.length >= MAX_PHOTOS ? `Up to ${MAX_PHOTOS} photos can be attached.` : ''].filter(Boolean).join(' '));
    setFiles(current => [...current, ...accepted]);
  };
  const removeFile = file => { setFiles(current => current.filter(item => item !== file)); setAnnotated(current => current.filter(item => item.name !== annotatedName(file))); };
  const saveAnnotation = file => { setAnnotated(current => [...current.filter(item => item.name !== file.name), file]); setEditing(null); };

  // Health Camp and Buyback / E-Waste skip Identify device and Evidence. A device or photos
  // chosen earlier are kept in case the request type is changed back, but not submitted.
  const isOnSiteRequest = isOnSite(form.category);
  const today = todayInIndia();
  const steps = stepLabels(form.category);
  const stepIndex = Math.max(0, requestSteps(form.category).indexOf(step));
  const minServiceDate = earliestServiceDate(form.category);
  const errors = detailsErrors(form, today);
  const deviceCountError = errors.deviceCount;
  const serviceDateError = errors.preferredServiceDate && `${errors.preferredServiceDate} Choose ${formatDate(minServiceDate)} or later.`;
  const chooseCategory = category => setForm(current => {
    const earliest = earliestServiceDate(category);
    return { ...current, category, preferredServiceDate: current.preferredServiceDate && current.preferredServiceDate >= earliest ? current.preferredServiceDate : earliest };
  });
  const goTo = key => { setTouched(false); setStep(key); };
  const next = () => { if (!stepValid(step, form, today)) { setTouched(true); return; } goTo(nextStep(step, form.category)); };
  const existingRequest = device ? openTickets.find(ticket => idOf(ticket.deviceId) === String(device._id)) : null;
  const linkedRecommendation = !isOnSiteRequest && recommendation && canRespond(recommendation) && form.deviceId === recommendation.deviceId ? recommendation : null;
  const back = () => goTo(previousStep(step, form.category));
  const canSubmit = stepValid('review', form, today);

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError('');
    let ticket;
    try {
      // The recommendation link is only sent while the request is still for the recommended device.
      ticket = await createTicket(requestPayload(form, { serviceFollowUpId: linkedRecommendation?._id }));
    } catch (submitError) {
      setError(friendlyError(submitError, 'Unable to submit your request. Please try again.'));
      setSubmitting(false);
      return;
    }
    // The request exists at this point; an upload failure must not trigger a
    // duplicate submission, so it is reported on the confirmation instead.
    let uploadError = '';
    // Photos belong to the Evidence step, which on-site requests don't have.
    const [photos, markedUp] = isOnSiteRequest ? [[], []] : [files, annotated];
    // Uploaded separately, so a problem with the marked-up copies doesn't lose the original photos.
    try { await uploadImages(ticket._id, photos); }
    catch (imageError) { uploadError = friendlyError(imageError, 'Photos could not be uploaded.'); }
    try { await uploadAnnotatedImages(ticket._id, markedUp); }
    catch (imageError) { uploadError = [uploadError, friendlyError(imageError, 'Marked-up photos could not be uploaded.')].filter(Boolean).join(' '); }
    setDone({ ticket, uploadError });
    setSubmitting(false);
  };

  const reset = () => { setDone(null); setDevice(null); setSerial(''); setFiles([]); setAnnotated([]); setForm(current => ({ ...current, description: '', deviceId: '', deviceCount: '', preferredServiceDate: earliestServiceDate(current.category) })); setStep('details'); setAiRequest(null); setRecommendation(null); setError('');
    // Drop ?conversationId / ?serviceFollowUp, or the previous draft would be loaded again.
    navigate('/corporate/raise-request', { replace: true, state: null });
  };

  if (done) return <Shell title="Raise Request" crumbs={[{ label: 'Raise Request' }]}>
    <Stepper steps={steps} current={steps.length} />
    <div className="card" role="status"><div className="success-panel">
      <span className="success-mark"><CheckCircle2 size={26} aria-hidden="true" /></span>
      <h2>Service request submitted</h2>
      <p>iPlanet Service has received your request and will review it shortly. You'll be notified as it progresses.</p>
      <InfoList items={[['Request ID', <span className="mono">{done.ticket.ticketId}</span>], ...(isOnSiteRequest ? [['Number of devices', done.ticket.deviceCount]] : [['Device', device?.model]]), ['Category', form.category], ...(done.ticket.serviceFollowUpId ? [['Service type', 'Preventive service']] : []), ['Status', <Badge dot>Open</Badge>]]} />
      {done.uploadError && <InlineAlert tone="warning" title="Photos were not attached">{done.uploadError} You can share them with the service team when they contact you.</InlineAlert>}
      <div className="row" style={{ justifyContent: 'center' }}>
        <Button icon={FilePlus2} onClick={reset}>Raise another request</Button>
        <Button variant="primary" to={`/corporate/service-requests/${done.ticket._id}`}>View request</Button>
      </div>
    </div></div>
  </Shell>;

  const annotationFor = file => annotated.find(item => item.name === annotatedName(file));

  return <Shell title="Raise Request">
    <PageHeader title="Raise Request" description="Tell us what you need and, for a repair, which device needs attention." />
    {aiRequest && <InlineAlert tone="info" title="Prepared from your AI Support conversation">Review the details before submitting.</InlineAlert>}
    {linkedRecommendation && <InlineAlert tone="info" title="Prepared from a service recommendation">Preventive service for {recommendation.device.model} was recommended for {formatDate(recommendation.nextServiceDate)}. Review and edit the details before submitting.</InlineAlert>}
    {recommendation && !canRespond(recommendation) && <InlineAlert tone="warning" title="This recommendation has already been handled">You can still raise a request, but it won't be linked to the recommendation.</InlineAlert>}
    <Stepper steps={steps} current={stepIndex} onStepClick={index => goTo(requestSteps(form.category)[index])} />
    {error && <InlineAlert title={error} />}

    <div className="wizard">
      <div className="wizard-main">
        <Card className="wizard-card" title={stepTitles[step]} description={step === 'details' && !isOnSiteRequest ? 'Choose the request type, find the device by serial number, model or asset ID, and describe what’s happening.' : stepDescriptions[step]}>
          {step === 'details' && <div className="stack-24">
            <div className="field"><span className="field-label">Request type</span>
              <div className="choice-grid" role="group" aria-label="Request type">{categories.map(item => <button type="button" key={item.value} className="choice" aria-pressed={form.category === item.value} onClick={() => chooseCategory(item.value)}><item.icon size={20} aria-hidden="true" /><strong>{item.value}</strong><span>{item.hint}</span></button>)}</div>
            </div>
            {/* A Service request is for one device, identified here; on-site requests have none. */}
            {!isOnSiteRequest && (loadError ? <ErrorState compact title="Unable to load your devices" message={friendlyError(loadError)} onRetry={loadDevices} />
              : !devices ? <div className="stack-12"><Skeleton height={46} /><Skeleton height={80} /></div>
              : <div className="stack-24">
                <Field label="Serial number" required hint="You can also search by model or asset ID." error={touched ? errors.deviceId : undefined}>
                  {props => <div className="lookup-control">
                    <div className="lookup-input"><Search size={17} aria-hidden="true" /><input {...props} className="mono-input" value={serial} onChange={event => lookup(event.target.value)} placeholder="e.g. C02ZK3C1ABCD" autoComplete="off" /></div>
                    <Button icon={Camera} className="btn-lg" onClick={() => setScanOpen(true)}>Scan</Button>
                  </div>}
                </Field>
                {device ? <div className="stack-16">
                  <div className="device-card">
                    <span className="device-card-icon"><DeviceIcon type={device.deviceType} model={device.model} /></span>
                    <div className="device-card-body"><strong>{device.model}</strong><span className="mono">{device.serialNumber}</span></div>
                    <Button size="sm" variant="ghost" icon={RefreshCcw} onClick={() => lookup('')}>Change</Button>
                  </div>
                  {existingRequest && <InlineAlert tone="warning" title={`This device already has an open request: ${existingRequest.ticketId}`} action={<Link className="btn btn-secondary btn-sm" to={`/corporate/service-requests/${existingRequest._id}`}>View request</Link>}>
                    {existingRequest.issueType} · {existingRequest.status}. You can still raise a separate request if this is a different issue.
                  </InlineAlert>}
                  <InfoList columns={2} items={[['Device type', device.deviceType], ['Asset ID', device.assetId], ['Location', device.location]]} />
                  <CoverageTiles device={device} />
                </div> : suggestions.length > 0 ? <div className="stack-8">
                  <p className="subheading" style={{ margin: 0 }}>Matching devices</p>
                  <div className="device-options" role="listbox" aria-label="Matching devices">{suggestions.map(item => <button type="button" role="option" aria-selected="false" key={item._id} className="device-option" onClick={() => { setSerial(item.serialNumber); selectDevice(item); }}>
                    <span><strong>{item.model}</strong><span><span className="mono">{item.serialNumber}</span>{item.location ? ` · ${item.location}` : ''}</span></span><ArrowRight size={16} aria-hidden="true" />
                  </button>)}</div>
                </div> : serial.trim().length >= 2 ? <EmptyState compact icon={Search} title="No device found" description="Check the serial number, or scan the barcode on the device." /> : null}
              </div>)}
            <div className="form-grid">
              {isOnSiteRequest ? <Field label="Number of devices" required hint={form.category === 'Health Camp' ? 'How many devices should be checked at the camp.' : 'How many devices to trade in or dispose of.'} error={touched ? deviceCountError : undefined}>
                {props => <input {...props} type="number" inputMode="numeric" min={1} max={ON_SITE_MAX_DEVICES} step={1} required value={form.deviceCount} onChange={event => setForm({ ...form, deviceCount: event.target.value })} placeholder="e.g. 25" />}
              </Field> : <Field label="Issue type">{props => <select {...props} value={form.issueType} onChange={event => setForm({ ...form, issueType: event.target.value })}>{issueTypes.map(item => <option key={item}>{item}</option>)}</select>}</Field>}
              {!isOnSiteRequest && <Field label="Priority" hint="Sets the resolution target.">{props => <select {...props} value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value })}>{priorities.map(item => <option key={item}>{item}</option>)}</select>}</Field>}
              <Field label="Service location">{props => <select {...props} value={form.location} onChange={event => setForm({ ...form, location: event.target.value })}>{locations.map(item => <option key={item}>{item}</option>)}</select>}</Field>
              <Field label="Preferred service date" required={isOnSiteRequest} hint={isOnSiteRequest ? `${form.category} requests need ${ON_SITE_LEAD_DAYS[form.category]} days' notice.` : undefined} error={touched ? serviceDateError : undefined}>{props => <input {...props} type="date" min={minServiceDate} value={form.preferredServiceDate} onChange={event => setForm({ ...form, preferredServiceDate: event.target.value })} />}</Field>
              <Field className="span-2" label="Description" required hint="What is happening, when it started, and anything you've tried." error={touched && !form.description.trim() ? 'Describe the issue to continue.' : undefined}>
                {props => <textarea {...props} required maxLength={4000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder="e.g. The display flickers after waking from sleep. Started last week." />}
              </Field>
            </div>
          </div>}

          {step === 'evidence' && <div className="stack-16">
            <label className="dropzone">
              <span className="dropzone-icon" aria-hidden="true"><ImagePlus size={20} /></span>
              <strong>Add photos</strong>
              <span>PNG, JPG or WebP, up to 5 MB each.</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={chooseFiles} aria-label="Upload issue photos" />
            </label>
            {files.length > 0 && <div className="photo-grid">{files.map(file => <PhotoCard key={file.name} file={file} annotation={annotationFor(file)} onAnnotate={() => setEditing(file)} onRemove={() => removeFile(file)} />)}</div>}
          </div>}

          {step === 'review' && <div className="review-summary">
            <div className="review-section"><div className="review-section-head"><h3>Details</h3><Button size="sm" variant="ghost" onClick={() => goTo('details')}>Edit</Button></div>
              <InfoList columns={2} items={[['Request type', form.category], ...(isOnSiteRequest ? [['Number of devices', form.deviceCount]] : [['Issue type', form.issueType], ['Priority', <Badge>{form.priority}</Badge>]]), ['Location', form.location], ['Preferred date', formatDate(form.preferredServiceDate, 'No preference')]]} />
              <p className="description-text" style={{ marginTop: 8 }}>{form.description}</p></div>
            {!isOnSiteRequest && <>
              <div className="review-section"><div className="review-section-head"><h3>Device</h3><Button size="sm" variant="ghost" onClick={() => goTo('details')}>Edit</Button></div>
                <InfoList columns={2} items={[['Device', device?.model], ['Serial number', <span className="mono">{device?.serialNumber}</span>], ['Location', device?.location], ['Coverage', device ? `${device.warrantyStatus || 'Unknown'} warranty · ${device.amcStatus || 'No'} AMC` : '']]} /></div>
              <div className="review-section"><div className="review-section-head"><h3>Evidence</h3><Button size="sm" variant="ghost" onClick={() => goTo('evidence')}>Edit</Button></div>
                <p className="text-muted">{files.length ? `${files.length} photo${files.length === 1 ? '' : 's'}${annotated.length ? `, ${annotated.length} marked` : ''}` : 'No photos attached'}</p></div>
            </>}
          </div>}
        </Card>

        <div className="wizard-footer">
          {stepIndex > 0 ? <Button icon={ArrowLeft} onClick={back} disabled={submitting}>Back</Button> : <Button to="/corporate/service-requests" variant="ghost">Cancel</Button>}
          <span className="spacer" />
          {step !== 'review' && <Button variant="primary" onClick={next}>{nextStep(step, form.category) === 'review' ? 'Review request' : 'Continue'}<ArrowRight size={16} aria-hidden="true" /></Button>}
          {step === 'review' && <Button variant="primary" icon={CheckCircle2} onClick={submit} disabled={submitting || !canSubmit}>{submitting ? 'Submitting…' : 'Submit request'}</Button>}
        </div>
      </div>

      <aside className="wizard-aside">
        {device && !isOnSiteRequest && <Card title="Selected device"><div className="stack-12">
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
