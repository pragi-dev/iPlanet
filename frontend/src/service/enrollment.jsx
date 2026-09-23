import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Building2, Camera, CheckCircle2, Plus, ScanLine, Search, Warehouse } from 'lucide-react';
import { ServiceShell } from './components';
import { createCompany, createServiceCentre, enrollDevice, getCompanies, getDeviceMaster, getDeviceMasters, getServiceCentres } from './api';
import { Badge, Button, Card, DeviceIcon, EmptyState, Field, InfoList, InlineAlert, Modal, PageHeader, Scanner, SearchInput, Stepper, formatDate, friendlyError } from '../ui';

const steps = ['Identify', 'Verify', 'Assign'];
const typeLabel = type => type === 'corporate' ? 'Corporate' : 'Service Centre';

function AddEntry({ onClose, onSaved }) {
  const [type, setType] = useState('corporate');
  const [form, setForm] = useState({ name: '', location: '', status: 'Active', contactName: '', contactEmail: '', phone: '', address: '', contactNumber: '', email: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const update = event => setForm({ ...form, [event.target.name]: event.target.value });
  const submit = async event => {
    event.preventDefault();
    if (!form.name.trim() || !form.location.trim()) { setError('Name and location are required.'); return; }
    setSaving(true);
    setError('');
    try {
      const saved = type === 'corporate' ? await createCompany(form) : await createServiceCentre(form);
      onSaved({ type, entry: saved });
    } catch (saveError) {
      setError(friendlyError(saveError, 'Unable to save this entry.'));
      setSaving(false);
    }
  };
  const input = (name, label, extra = {}) => <Field label={label} required={extra.required}>{props => <input {...props} name={name} value={form[name]} onChange={update} {...extra} />}</Field>;
  return <Modal as="form" onSubmit={submit} onClose={onClose} eyebrow="Add new" title={`New ${typeLabel(type)}`} description="Saved entries are immediately available for enrollment."
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" icon={Plus} disabled={saving}>{saving ? 'Saving…' : `Add ${typeLabel(type)}`}</Button></>}>
    <div className="field"><span className="field-label">Entry type</span>
      <div className="segmented" role="group" aria-label="Entry type"><button type="button" aria-pressed={type === 'corporate'} onClick={() => setType('corporate')}>Corporate</button><button type="button" aria-pressed={type === 'service_centre'} onClick={() => setType('service_centre')}>Service Centre</button></div>
    </div>
    <div className="form-grid">
      {input('name', type === 'corporate' ? 'Company name' : 'Service centre name', { required: true, 'data-autofocus': true })}
      {input('location', 'Location', { required: true, placeholder: 'e.g. Chennai' })}
      {type === 'corporate' ? <>
        {input('contactName', 'Contact person')}
        {input('phone', 'Phone', { type: 'tel' })}
        <div className="span-2">{input('contactEmail', 'Contact email', { type: 'email' })}</div>
      </> : <>
        {input('contactNumber', 'Contact number', { type: 'tel' })}
        {input('email', 'Email', { type: 'email' })}
        <div className="span-2">{input('address', 'Address')}</div>
      </>}
      <Field label="Status">{props => <select {...props} name="status" value={form.status} onChange={update}><option>Active</option><option>Inactive</option></select>}</Field>
    </div>
    {error && <InlineAlert title={error} />}
  </Modal>;
}

export function DeviceEnrollment() {
  const [step, setStep] = useState(0);
  const [serial, setSerial] = useState('');
  const [device, setDevice] = useState(null);
  const [masters, setMasters] = useState([]);
  const [entries, setEntries] = useState([]);
  const [entriesError, setEntriesError] = useState('');
  const [selectedEntity, setSelectedEntity] = useState('');
  const [entitySearch, setEntitySearch] = useState('');
  const [error, setError] = useState('');
  const [looking, setLooking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const loadEntries = async () => {
    try {
      setEntriesError('');
      const [companies, centres] = await Promise.all([getCompanies(), getServiceCentres()]);
      setEntries([...companies.map(entry => ({ ...entry, entityType: 'corporate', label: entry.name })), ...centres.map(entry => ({ ...entry, entityType: 'service_centre', label: entry.name }))].sort((a, b) => a.label.localeCompare(b.label)));
    } catch (loadError) { setEntriesError(friendlyError(loadError, 'Unable to load corporates and service centres.')); }
  };
  useEffect(() => { void loadEntries(); getDeviceMasters().then(setMasters).catch(() => setMasters([])); }, []);

  const lookup = useCallback(async value => {
    const term = String(value).trim();
    setSerial(term);
    setError('');
    setDevice(null);
    if (!term) { setError('Enter a serial number.'); return; }
    setLooking(true);
    try { setDevice(await getDeviceMaster(term)); setStep(1); }
    catch (lookupError) { setError(friendlyError(lookupError, 'Device not found. Please verify the serial number.')); }
    finally { setLooking(false); }
  }, []);
  const detected = useCallback(value => { setScanOpen(false); void lookup(value); }, [lookup]);
  const closeScanner = useCallback(() => setScanOpen(false), []);

  const selected = entries.find(item => `${item.entityType}:${item._id}` === selectedEntity);
  const visibleEntries = useMemo(() => entries.filter(entry => `${entry.label} ${entry.location || ''} ${typeLabel(entry.entityType)}`.toLowerCase().includes(entitySearch.toLowerCase())), [entries, entitySearch]);

  const submit = async () => {
    if (!device || !selected) return;
    setSaving(true);
    setError('');
    try { setSaved({ result: await enrollDevice({ serialNumber: device.serialNumber, selectedEntityId: selected._id, selectedEntityType: selected.entityType }), entity: selected }); }
    catch (saveError) { setError(friendlyError(saveError, 'Unable to enroll this device.')); }
    finally { setSaving(false); }
  };
  const savedEntry = ({ type, entry }) => {
    const entity = { ...entry, entityType: type, label: entry.name };
    setEntries(current => [...current.filter(item => `${item.entityType}:${item._id}` !== `${type}:${entry._id}`), entity].sort((a, b) => a.label.localeCompare(b.label)));
    setSelectedEntity(`${type}:${entry._id}`);
    setAddOpen(false);
    void loadEntries();
  };
  const restart = () => { setSaved(null); setDevice(null); setSerial(''); setSelectedEntity(''); setEntitySearch(''); setError(''); setStep(0); };

  if (saved) return <ServiceShell title="Device Enrollment">
    <div className="card"><div className="success-panel">
      <span className="success-mark"><CheckCircle2 size={26} aria-hidden="true" /></span>
      <h2>Device enrolled</h2>
      <p>{saved.result.model || device.model} is now registered to {saved.entity.label} and marked as unassigned.{saved.entity.entityType === 'corporate' ? ' The corporate admins have been notified.' : ''}</p>
      <InfoList items={[['Device', saved.result.model || device.model], ['Serial number', <span className="mono">{saved.result.serialNumber || device.serialNumber}</span>], ['Assigned to', <span className="row">{saved.entity.label}<Badge tone="neutral">{typeLabel(saved.entity.entityType)}</Badge></span>], ['Status', <Badge dot>Unassigned</Badge>]]} />
      <Button variant="primary" icon={ScanLine} onClick={restart}>Enroll another device</Button>
    </div></div>
  </ServiceShell>;

  return <ServiceShell title="Device Enrollment">
    <PageHeader title="Device Enrollment" description="Identify a device from the device master, verify it, and assign it to a corporate customer or service centre." />
    <Stepper steps={steps} current={step} onStepClick={setStep} />
    <div className="wizard">
      <div className="wizard-main">
        {step === 0 && <Card className="wizard-card" title="Identify device" description="Scan the barcode or QR code, or type the serial number.">
          <form className="stack-16" onSubmit={event => { event.preventDefault(); void lookup(serial); }}>
            <div className="lookup-row">
              <Field label="Serial number" error={error || undefined}>{props => <div className="lookup-input"><Search size={17} aria-hidden="true" /><input {...props} className="mono-input" value={serial} onChange={event => setSerial(event.target.value)} placeholder="Enter device serial number" autoComplete="off" data-autofocus /></div>}</Field>
              <Button icon={Camera} className="btn-lg" onClick={() => setScanOpen(true)}>Scan barcode / QR</Button>
            </div>
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}><Button variant="primary" type="submit" icon={Search} disabled={looking || !serial.trim()}>{looking ? 'Looking up…' : 'Look up device'}</Button></div>
          </form>
          {masters.length > 0 && <div style={{ marginTop: 20 }}>
            <p className="subheading">Recent serials in the device master</p>
            <div className="chip-list">{masters.slice(0, 8).map(item => <button key={item._id} type="button" className="chip mono" style={{ border: 0, cursor: 'pointer' }} onClick={() => void lookup(item.serialNumber)}>{item.serialNumber}</button>)}</div>
          </div>}
        </Card>}

        {step === 1 && device && <Card className="wizard-card" title="Verify device" description="Confirm the device-master record before assigning it.">
          <div className="stack-16">
            <div className="device-card"><span className="device-card-icon"><DeviceIcon type={device.deviceType} model={device.model} /></span><div className="device-card-body"><strong>{device.model}</strong><span className="mono">{device.serialNumber}</span></div><Badge tone="success" dot>Verified</Badge></div>
            <InfoList columns={2} items={[['Device type', device.deviceType], ['Asset ID', device.assetId], ['Purchase date', formatDate(device.purchaseDate, '')], ['Warranty', <span className="row"><Badge>{device.warrantyStatus}</Badge><span className="text-muted text-small">until {formatDate(device.warrantyExpiry)}</span></span>], ['AMC', <span className="row"><Badge>{device.amcStatus}</Badge><span className="text-muted text-small">until {formatDate(device.amcExpiry)}</span></span>]]} />
          </div>
        </Card>}

        {step === 2 && <Card className="wizard-card" title="Assign to" description="Choose the corporate customer or service centre that will hold this device." actions={<Button size="sm" icon={Plus} onClick={() => setAddOpen(true)}>Add new</Button>}>
          <div className="stack-12">
            {entriesError ? <InlineAlert title={entriesError} action={<Button size="sm" onClick={loadEntries}>Retry</Button>} /> : <>
              <SearchInput value={entitySearch} onChange={setEntitySearch} placeholder="Search corporates and service centres" label="Search corporate or service centre" className="search-full" />
              <div className="entity-option-list" role="listbox" aria-label="Corporate / Service Centre">
                {visibleEntries.map(entry => { const key = `${entry.entityType}:${entry._id}`; return <button key={key} type="button" role="option" aria-selected={selectedEntity === key} className="entity-option" onClick={() => setSelectedEntity(key)}>
                  <span className="row" style={{ flexWrap: 'nowrap', minWidth: 0 }}>{entry.entityType === 'corporate' ? <Building2 size={16} aria-hidden="true" className="text-muted" /> : <Warehouse size={16} aria-hidden="true" className="text-muted" />}<span style={{ minWidth: 0 }}><strong>{entry.label}</strong>{entry.location && <small>{entry.location}</small>}</span></span>
                  <Badge tone={entry.entityType === 'corporate' ? 'info' : 'neutral'}>{typeLabel(entry.entityType)}</Badge>
                </button>; })}
                {!visibleEntries.length && <EmptyState compact title={entries.length ? 'No matches' : 'No corporates or service centres yet'} description="Use Add new to create one." action={<Button size="sm" icon={Plus} onClick={() => setAddOpen(true)}>Add new</Button>} />}
              </div>
            </>}
            {error && <InlineAlert title={error} />}
          </div>
        </Card>}

        <div className="card"><div className="wizard-footer" style={{ borderTop: 0, borderRadius: 'var(--radius-lg)' }}>
          {step > 0 ? <Button icon={ArrowLeft} onClick={() => { setError(''); setStep(step - 1); }} disabled={saving}>Back</Button> : <span />}
          <span className="spacer" />
          {step === 1 && <Button variant="primary" onClick={() => setStep(2)}>Continue<ArrowRight size={16} aria-hidden="true" /></Button>}
          {step === 2 && <Button variant="primary" icon={CheckCircle2} onClick={submit} disabled={!selected || saving}>{saving ? 'Enrolling…' : 'Enroll device'}</Button>}
        </div></div>
      </div>
      <aside className="wizard-aside">
        {device && <Card title="Device"><div className="person-cell"><span className="thumb thumb-lg"><DeviceIcon type={device.deviceType} model={device.model} /></span><div><strong>{device.model}</strong><span className="cell-sub mono">{device.serialNumber}</span></div></div></Card>}
        {selected && <Card title="Assigning to"><div className="stack-8"><strong>{selected.label}</strong><Badge tone={selected.entityType === 'corporate' ? 'info' : 'neutral'}>{typeLabel(selected.entityType)}</Badge></div></Card>}
        <Card title="One lookup path"><p className="text-muted text-small">Scanning and manual entry use the same device-master lookup. Enrolled devices start as unassigned so the corporate admin can allocate them to an employee.</p></Card>
      </aside>
    </div>
    {scanOpen && <Scanner onDetected={detected} onClose={closeScanner} title="Point the camera at the serial number" />}
    {addOpen && <AddEntry onClose={() => setAddOpen(false)} onSaved={savedEntry} />}
  </ServiceShell>;
}
