import { useMemo, useState } from 'react';
import { CheckCircle2, FileSpreadsheet, Plus, RefreshCcw, Upload } from 'lucide-react';
import { Shell } from './components';
import { confirmDeviceImport, createDevice, getDeviceRegistrationOptions, validateDeviceImport } from './api';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Field, InlineAlert, KPI, KPIGrid, PageHeader, PageSkeleton, TableCard, Tabs, formatDate, friendlyError, useAsync } from '../ui';

const emptyForm = { model: '', deviceType: '', serialNumber: '', assetId: '', location: '', deviceAllocationStatus: 'Unassigned', purchaseDate: '', warrantyExpiry: '', amcExpiry: '' };
const pluralDevices = count => `${count} device${count === 1 ? '' : 's'}`;

// Registers a corporate's existing devices, one at a time or from an Excel workbook.
// The server validates everything again; these checks only save a round trip.
function ManualForm({ options }) {
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const set = field => event => { setForm(current => ({ ...current, [field]: event.target.value })); setErrors(current => ({ ...current, [field]: undefined })); };

  const submit = async event => {
    event.preventDefault();
    const missing = Object.fromEntries([['model', 'Device model is required.'], ['deviceType', 'Device type is required.'], ['serialNumber', 'Serial number is required.']].filter(([field]) => !form[field].trim()));
    if (Object.keys(missing).length) { setErrors(missing); setMessage(''); return; }
    setSaving(true);
    setMessage('');
    try {
      const device = await createDevice(Object.fromEntries(Object.entries(form).filter(([, value]) => value !== '')));
      setSaved(device);
      setForm(emptyForm);
      setErrors({});
    } catch (error) {
      setMessage(friendlyError(error, 'The device could not be added. Please try again.'));
      setErrors(Object.fromEntries((error.body?.errors || []).map(item => [item.field, item.message])));
    } finally {
      setSaving(false);
    }
  };

  if (saved) return <Card><div className="success-panel" role="status">
    <span className="success-mark"><CheckCircle2 size={26} aria-hidden="true" /></span>
    <h2>{saved.model} added</h2>
    <p>Serial <span className="mono">{saved.serialNumber}</span> is now in your devices.</p>
    <div className="row" style={{ justifyContent: 'center' }}>
      <Button icon={Plus} onClick={() => setSaved(null)}>Add another device</Button>
      <Button to={`/corporate/devices/${saved._id}`}>View device</Button>
      <Button variant="primary" to="/corporate/devices">Back to devices</Button>
    </div>
  </div></Card>;

  const today = new Date().toISOString().slice(0, 10);
  return <Card title="Device details" description="Fields marked * are required. Leave warranty and AMC dates blank if you don't know them.">
    <form className="stack-24" onSubmit={submit} noValidate>
      <div className="form-grid">
        <Field label="Device model" required error={errors.model}>{props => <input {...props} value={form.model} onChange={set('model')} maxLength={80} placeholder="e.g. MacBook Air M3" data-autofocus />}</Field>
        <Field label="Device type" required error={errors.deviceType}>{props => <select {...props} value={form.deviceType} onChange={set('deviceType')}><option value="">Choose a type</option>{options.deviceTypes.map(type => <option key={type}>{type}</option>)}</select>}</Field>
        <Field label="Serial number" required hint="6 to 20 letters, digits or hyphens." error={errors.serialNumber}>{props => <input {...props} className="mono-input" value={form.serialNumber} onChange={set('serialNumber')} maxLength={20} autoComplete="off" placeholder="e.g. C02ZK3C1ABCD" />}</Field>
        <Field label="Asset ID" hint="Optional. Unique within your organization." error={errors.assetId}>{props => <input {...props} value={form.assetId} onChange={set('assetId')} maxLength={40} autoComplete="off" />}</Field>
        <Field label="Location" error={errors.location}>{props => <select {...props} value={form.location} onChange={set('location')}><option value="">{options.defaultLocation ? `Organization location (${options.defaultLocation})` : 'Not set'}</option>{options.locations.map(location => <option key={location}>{location}</option>)}</select>}</Field>
        <Field label="Assignment status" error={errors.deviceAllocationStatus}>{props => <select {...props} value={form.deviceAllocationStatus} onChange={set('deviceAllocationStatus')}>{options.assignmentStatuses.map(status => <option key={status}>{status}</option>)}</select>}</Field>
        <Field label="Purchase date" error={errors.purchaseDate}>{props => <input {...props} type="date" max={today} value={form.purchaseDate} onChange={set('purchaseDate')} />}</Field>
        <Field label="Warranty end date" hint="Warranty status is worked out from this date." error={errors.warrantyExpiry}>{props => <input {...props} type="date" value={form.warrantyExpiry} onChange={set('warrantyExpiry')} />}</Field>
        <Field label="AMC end date" hint="Leave blank if there is no AMC." error={errors.amcExpiry}>{props => <input {...props} type="date" value={form.amcExpiry} onChange={set('amcExpiry')} />}</Field>
      </div>
      {message && <InlineAlert title={message} />}
      <div className="form-actions"><Button to="/corporate/devices">Cancel</Button><Button variant="primary" type="submit" icon={Plus} disabled={saving}>{saving ? 'Adding…' : 'Add device'}</Button></div>
    </form>
  </Card>;
}

// Which file column each field was read from. Columns matched by AI are flagged so the
// admin checks them before importing.
function ColumnMapping({ report }) {
  const mapping = report.columnMapping || [];
  if (!mapping.length) return null;
  const byAi = mapping.filter(item => item.source === 'ai');
  return <Card title="Columns used" description={`Read from the "${report.sheetName}" sheet, with headings on row ${report.headerRow}.`}>
    <div className="stack-16">
      {byAi.length > 0 && <InlineAlert tone="warning" title={`${byAi.length} column${byAi.length === 1 ? ' was' : 's were'} matched by AI`}>Check that the rows below show the right values for {byAi.map(item => item.label).join(', ')} before importing. If a column is wrong, rename it in your file to the name listed above and upload it again.</InlineAlert>}
      <ul className="row" style={{ flexWrap: 'wrap', gap: 8, margin: 0, padding: 0, listStyle: 'none' }}>
        {mapping.map(item => <li key={item.column} className="text-small">
          <Badge tone={item.source === 'ai' ? 'warning' : 'neutral'}>{item.label}</Badge> ← column {item.column}{item.heading ? ` “${item.heading}”` : ''}{item.source === 'ai' ? ' (AI)' : ''}
        </li>)}
      </ul>
    </div>
  </Card>;
}

function ImportPreview({ report, onlyProblems, setOnlyProblems }) {
  const rows = onlyProblems ? report.rows.filter(row => row.errors.length) : report.rows;
  // Valid values are shown as saved; a rejected value is shown as it was in the file.
  const shown = (row, field) => row.values[field] || row.input?.[field] || '';
  return <TableCard columns={7} isEmpty={!rows.length} empty={<p className="text-muted" style={{ padding: 24 }}>No rows with problems.</p>}
    toolbar={<div className="row-between" style={{ padding: '14px 24px' }}>
      <span className="text-small text-muted">{report.fileName}{report.ignoredColumns?.length ? ` · Ignored columns: ${report.ignoredColumns.join(', ')}` : ''}</span>
      {report.summary.invalid > 0 && <label className="row text-small"><input type="checkbox" checked={onlyProblems} onChange={event => setOnlyProblems(event.target.checked)} />Show only rows with problems</label>}
    </div>}>
    <table className="table">
      <thead><tr><th>Row</th><th>Device</th><th>Serial number</th><th>Asset ID</th><th>Location</th><th>Coverage</th><th>Result</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.row}>
        <td className="mono">{row.row}</td>
        <td>{shown(row, 'model') || '—'}<span className="cell-sub">{[shown(row, 'deviceType'), shown(row, 'deviceAllocationStatus')].filter(Boolean).join(' · ')}</span></td>
        <td className="mono cell-nowrap">{shown(row, 'serialNumber') || '—'}</td>
        <td>{shown(row, 'assetId') || '—'}</td>
        <td>{shown(row, 'location') || '—'}</td>
        <td className="cell-nowrap">{row.values.warrantyExpiry ? `Warranty to ${formatDate(row.values.warrantyExpiry)}` : 'Warranty unknown'}<span className="cell-sub">{row.values.amcExpiry ? `AMC to ${formatDate(row.values.amcExpiry)}` : 'No AMC date'}</span></td>
        <td style={{ minWidth: 220 }}>{row.errors.length
          ? <ul className="stack-8" style={{ margin: 0, paddingLeft: 16 }}>{row.errors.map((error, index) => <li key={index} className="text-small">{error.duplicate && <Badge tone="warning">{error.duplicate === 'file' ? 'Duplicate in file' : 'Already registered'}</Badge>} {error.message}</li>)}</ul>
          : <Badge tone="success" dot>Ready</Badge>}</td>
      </tr>)}</tbody>
    </table>
  </TableCard>;
}

function ExcelImport({ options }) {
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const maxMb = Math.round(options.maxImportBytes / 1024 / 1024);

  const reset = () => { setFile(null); setReport(null); setResult(null); setError(''); setOnlyProblems(false); };
  const choose = event => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    setReport(null); setResult(null); setError('');
    if (!chosen) return;
    if (!/\.xlsx$/i.test(chosen.name)) { setFile(null); setError('Choose an Excel workbook saved as .xlsx.'); return; }
    if (chosen.size > options.maxImportBytes) { setFile(null); setError(`The file must be ${maxMb} MB or smaller.`); return; }
    setFile(chosen);
  };
  const check = async () => {
    setBusy('check'); setError('');
    try { const next = await validateDeviceImport(file); setReport(next); setOnlyProblems(next.summary.invalid > 0); }
    catch (checkError) { setError(checkError.message); }
    finally { setBusy(''); }
  };
  const confirm = async () => {
    setBusy('import'); setError('');
    try { const done = await confirmDeviceImport(report.importId); setResult(done.result); setConfirming(false); }
    catch (importError) {
      setConfirming(false);
      setError(importError.message);
      // The server re-checked the rows; show what changed since the preview.
      if (importError.body?.rows) { setReport(current => ({ ...current, rows: importError.body.rows, summary: importError.body.summary })); setOnlyProblems(true); }
    } finally { setBusy(''); }
  };

  if (result) return <Card><div className="success-panel" role="status">
    <span className="success-mark"><CheckCircle2 size={26} aria-hidden="true" /></span>
    <h2>{pluralDevices(result.imported)} imported</h2>
    <p>Every row in {report.fileName} was added to your devices.</p>
    <div className="row" style={{ justifyContent: 'center' }}><Button icon={RefreshCcw} onClick={reset}>Import another file</Button><Button variant="primary" to="/corporate/devices">View devices</Button></div>
  </div></Card>;

  return <div className="stack-16">
    <Card title="Upload and check" description={`One device per row, up to ${options.maxImportRows} rows. Nothing is saved until you review the rows and confirm the import.`}>
      <div className="stack-16">
        <label className="dropzone">
          <span className="dropzone-icon" aria-hidden="true"><FileSpreadsheet size={20} /></span>
          <strong>{file ? file.name : 'Choose an Excel file'}</strong>
          <span>{file ? `${Math.max(1, Math.round(file.size / 1024))} KB · choose again to replace it` : `.xlsx, up to ${maxMb} MB`}</span>
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={choose} aria-label="Upload device workbook" />
        </label>
        <div className="row"><Button variant="primary" icon={Upload} onClick={check} disabled={!file || busy === 'check'}>{busy === 'check' ? 'Checking…' : 'Check file'}</Button>{report && <Button variant="ghost" onClick={reset}>Start over</Button>}</div>
      </div>
    </Card>
    {error && <InlineAlert title={error} />}
    {report && <>
      <KPIGrid columns={4}>
        <KPI label="Rows" value={report.summary.total} />
        <KPI label="Ready to import" value={report.summary.valid} tone={report.summary.invalid ? undefined : 'success'} />
        <KPI label="Rows with problems" value={report.summary.invalid} tone={report.summary.invalid ? 'critical' : undefined} />
        <KPI label="Duplicates" value={report.summary.duplicates} hint="In the file or already registered" tone={report.summary.duplicates ? 'warning' : undefined} />
      </KPIGrid>
      {report.summary.invalid > 0
        ? <InlineAlert tone="warning" title={`Fix ${report.summary.invalid} row${report.summary.invalid === 1 ? '' : 's'} before importing`}>Files are imported all at once, so nothing is added until every row is valid. Correct the rows below in your file and upload it again.</InlineAlert>
        : <InlineAlert tone="info" title={`All ${pluralDevices(report.summary.valid)} are ready`} action={<Button variant="primary" onClick={() => setConfirming(true)} disabled={busy === 'import'}>Import {pluralDevices(report.summary.valid)}</Button>}>Review the rows, then confirm the import.</InlineAlert>}
      <ColumnMapping report={report} />
      <ImportPreview report={report} onlyProblems={onlyProblems} setOnlyProblems={setOnlyProblems} />
    </>}
    {confirming && <ConfirmDialog title={`Import ${pluralDevices(report.summary.valid)}?`} description="They will be added to your organization's devices. Existing devices are never changed." confirmLabel="Import devices" busy={busy === 'import'} onConfirm={confirm} onClose={() => setConfirming(false)} />}
  </div>;
}

export function AddDevices() {
  const options = useAsync(getDeviceRegistrationOptions, []);
  const [tab, setTab] = useState('manual');
  const crumbs = useMemo(() => [{ label: 'Devices', to: '/corporate/devices' }, { label: 'Add devices' }], []);
  return <Shell title="Add devices" crumbs={crumbs}>
    <PageHeader title="Add devices" description="Register devices your organization already owns, one at a time or from an Excel file." back={{ to: '/corporate/devices', label: 'Devices' }} />
    {options.loading && !options.data ? <PageSkeleton variant="detail" kpis={0} />
      : options.error ? <div className="card"><ErrorState title="Unable to load the device form" message={friendlyError(options.error)} onRetry={options.reload} /></div>
      : <>
        <Tabs label="How to add devices" value={tab} onChange={setTab} tabs={[{ value: 'manual', label: 'Add manually' }, { value: 'excel', label: 'Import from Excel' }]} />
        {tab === 'manual' ? <ManualForm options={options.data} /> : <ExcelImport options={options.data} />}
      </>}
  </Shell>;
}
