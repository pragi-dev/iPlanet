import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, BellRing, CalendarCheck2, CalendarClock, CircleSlash, Laptop, PhoneCall, Search, X } from 'lucide-react';
import { ServiceShell } from './components';
import { getProactiveFollowUp, getProactiveFollowUps, proactiveFollowUpAction, updateDeviceServicePlan } from './api';
import {
  Badge, Button, Drawer, EmptyState, ErrorState, Field, FilterSelect, InfoList, InlineAlert, PageHeader, ProactiveStatus, SearchInput, ServiceLifecycle,
  Skeleton, TableCard, dueLabel, formatDate, formatDateTime, friendlyError, pluralize, useAsync,
} from '../ui';

const FILTER_KEYS = ['status', 'companyId', 'serviceCentreId', 'location', 'dueWithin', 'deviceType', 'warranty', 'amc'];
const STATUS_OPTIONS = ['Needs action', 'Overdue', 'Due', 'Upcoming', 'Reminder Due', 'Awaiting customer', 'Remind Later', 'Scheduled', 'In Service'];
const COVERAGE_OPTIONS = ['Active', 'Expiring Soon', 'Expired'];
const DUE_OPTIONS = [{ value: 'overdue', label: 'Past due date' }, { value: '7', label: 'Due within 7 days' }, { value: '14', label: 'Due within 14 days' }, { value: '30', label: 'Due within 30 days' }];

// Today in India as YYYY-MM-DD, for date-picker minimums.
function indiaDay(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Colour the due date only while the service team still has to act on it.
const dueTone = item => (!item.actionable ? '' : item.timing === 'Overdue' ? 'critical' : item.timing === 'Due' ? 'warning' : '');
const reasonText = item => (item.timing === 'Overdue' ? `Preventive service is overdue for this device — the recommended date was ${formatDate(item.nextServiceDate)}.`
  : item.timing === 'Due' ? 'Preventive service is due for this device.'
  : item.timing === 'Upcoming' ? `Preventive service is recommended on ${formatDate(item.nextServiceDate)} (${dueLabel(item.daysUntil).toLowerCase()}).`
  : 'Preventive service follow-up for this device.');

export function ProactiveService() {
  const [params, setParams] = useSearchParams();
  const readFilters = () => Object.fromEntries(FILTER_KEYS.map(key => [key, params.get(key) || 'All']));
  const [filters, setFilters] = useState(readFilters);
  const [searchText, setSearchText] = useState(params.get('search') || '');
  const [search, setSearch] = useState(searchText);
  const view = params.get('view') === 'completed' ? 'completed' : 'active';
  const openId = params.get('followUp');
  useEffect(() => { setFilters(readFilters()); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = window.setTimeout(() => setSearch(searchText), 300); return () => window.clearTimeout(timer); }, [searchText]);

  const request = { ...filters, search, view };
  const state = useAsync(() => getProactiveFollowUps(request), [JSON.stringify(request)]);
  const setParam = (changes) => setParams(current => {
    const next = new URLSearchParams(current);
    Object.entries(changes).forEach(([key, value]) => (value && value !== 'All' ? next.set(key, value) : next.delete(key)));
    return next;
  }, { replace: true });
  const update = (key, value) => { setFilters(current => ({ ...current, [key]: value })); setParam({ [key]: value }); };
  const active = FILTER_KEYS.some(key => filters[key] !== 'All') || search;
  const clear = () => { setFilters(Object.fromEntries(FILTER_KEYS.map(key => [key, 'All']))); setSearchText(''); setSearch(''); setParams(view === 'completed' ? { view } : {}, { replace: true }); };

  const data = state.data;
  const summary = data?.summary;
  const facets = data?.facets || { companies: [], serviceCentres: [], locations: [], deviceTypes: [] };
  const chips = summary ? [
    { key: 'Needs action', label: 'Needs action', value: summary.needsAction },
    { key: 'Overdue', label: 'Overdue', value: summary.overdue, tone: 'critical' },
    { key: 'Due', label: 'Due', value: summary.due, tone: 'warning' },
    { key: 'Upcoming', label: 'Upcoming', value: summary.upcoming },
    { key: 'Reminder Due', label: 'Reminder due', value: summary.reminderDue, tone: 'warning' },
    { key: 'Awaiting customer', label: 'Awaiting customer', value: summary.awaitingCustomer },
    { key: 'Scheduled', label: 'Scheduled', value: summary.scheduled },
    { key: 'In Service', label: 'In service', value: summary.inService },
  ] : [];

  return <ServiceShell title="Proactive Service">
    <PageHeader
      title="Proactive Service"
      description={data ? (view === 'completed' ? 'Follow-ups completed or closed in the last 30 days.' : summary.needsAction ? `${pluralize(summary.needsAction, 'device')} ${summary.needsAction === 1 ? 'requires' : 'require'} proactive follow-up. Contact the customer before raising a request.` : 'No devices need follow-up right now. Devices appear here as they approach their recommended service date.') : 'Devices approaching or past their recommended service date.'}
      actions={<Button variant={view === 'completed' ? 'secondary' : 'ghost'} onClick={() => setParams(view === 'completed' ? {} : { view: 'completed' }, { replace: true })}>{view === 'completed' ? 'Back to active follow-ups' : 'Recently completed'}</Button>} />

    {view === 'active' && summary && <div className="pro-summary" role="group" aria-label="Filter by follow-up status">
      {chips.map(chip => <button key={chip.key} type="button" className={`pro-chip ${chip.value && chip.tone ? `pro-chip-${chip.tone}` : ''}`} aria-pressed={filters.status === chip.key} onClick={() => update('status', filters.status === chip.key ? 'All' : chip.key)}>
        {chip.label}<strong>{chip.value}</strong>
      </button>)}
    </div>}

    <TableCard
      columns={8}
      loading={state.loading && !data}
      error={state.error && friendlyError(state.error)}
      errorTitle="Unable to load proactive follow-ups"
      onRetry={state.reload}
      toolbar={<div className="pro-toolbar">
        <div className="pro-toolbar-top">
        <SearchInput className="pro-search" value={searchText} onChange={value => { setSearchText(value); setParam({ search: value }); }} placeholder="Search device, serial, corporate, employee or location" label="Search follow-ups" />
          {data && <span className="pro-toolbar-count">{state.loading && <span className="text-muted">Updating…</span>}{pluralize(data.items.length, 'device')}{active && <Button size="sm" variant="ghost" icon={X} onClick={clear}>Clear filters</Button>}</span>}
        </div>
        <div className="pro-filter-grid">
        {view === 'active' && <FilterSelect label="Status" value={filters.status} onChange={value => update('status', value)} options={STATUS_OPTIONS} allLabel="All statuses" />}
        <FilterSelect label="Corporate" value={filters.companyId} onChange={value => update('companyId', value)} options={facets.companies.map(company => ({ value: company._id, label: company.name }))} allLabel="All corporates" />
        <FilterSelect label="Service centre" value={filters.serviceCentreId} onChange={value => update('serviceCentreId', value)} options={facets.serviceCentres.map(centre => ({ value: centre._id, label: centre.name }))} allLabel="All service centres" />
        <FilterSelect label="Location" value={filters.location} onChange={value => update('location', value)} options={facets.locations} allLabel="All locations" />
        {view === 'active' && <FilterSelect label="Due date" value={filters.dueWithin} onChange={value => update('dueWithin', value)} options={DUE_OPTIONS} allLabel="Any due date" />}
        <FilterSelect label="Device type" value={filters.deviceType} onChange={value => update('deviceType', value)} options={facets.deviceTypes} allLabel="All device types" />
        <FilterSelect label="Warranty" value={filters.warranty} onChange={value => update('warranty', value)} options={COVERAGE_OPTIONS} allLabel="Any warranty" />
        <FilterSelect label="AMC" value={filters.amc} onChange={value => update('amc', value)} options={COVERAGE_OPTIONS} allLabel="Any AMC" />
        </div>
      </div>}
      isEmpty={!data?.items.length}
      empty={active ? <EmptyState icon={Search} title="No follow-ups match these filters" description="Try a different search term or clear the filters." action={<Button size="sm" onClick={clear}>Clear filters</Button>} />
        : <EmptyState icon={CalendarCheck2} title={view === 'completed' ? 'Nothing completed in the last 30 days' : "You're all caught up."} description={view === 'completed' ? 'Completed and declined follow-ups will be listed here.' : `Devices appear here ${data?.config?.upcomingDays || 30} days before their recommended service date.`} />}
    >
      <table className="table table-compact pro-table">
        <thead><tr><th>Device</th><th>Corporate</th><th className="pro-col-optional">Location</th><th>Service due</th><th className="pro-col-optional">Coverage</th><th>Status</th><th className="pro-col-optional pro-col-wide">Last contact</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{(data?.items || []).map(item => <tr key={item._id} className="row-clickable" onClick={event => { if (!event.target.closest('button, a')) setParam({ followUp: item._id }); }}>
          <td className="pro-cell-device"><span className="cell-primary">{item.device.model}</span><span className="cell-sub mono">{item.device.serialNumber}</span></td>
          <td data-label="Corporate">{item.company?.name || '—'}<span className="cell-sub">{item.device.employeeName || 'Unassigned'}</span></td>
          <td className="pro-col-optional pro-nowrap" data-label="Location">{item.device.location || '—'}<span className="cell-sub">{item.serviceCentre?.name || 'No service centre'}</span></td>
          <td data-label="Service due"><span className={`pro-due pro-due-${dueTone(item)}`}><strong>{dueLabel(item.daysUntil)}</strong><small>{formatDate(item.nextServiceDate)}</small></span></td>
          <td className="pro-col-optional" data-label="Coverage"><span className="pro-coverage"><span>Warranty · {item.coverage.warrantyStatus || '—'}</span><span>AMC · {item.coverage.amcStatus || '—'}</span></span></td>
          <td className="pro-cell-status"><ProactiveStatus status={item.status} /></td>
          <td className="pro-col-optional pro-col-wide pro-cell-wide" data-label="Last contact">{item.lastContact ? <>{item.lastContact.outcome}<span className="cell-sub">{formatDate(item.lastContact.at)}{item.lastContact.byName ? ` · ${item.lastContact.byName}` : ''}</span></> : <span className="text-muted">Not contacted</span>}</td>
          <td className="pro-cell-actions"><div className="pro-actions"><Button size="sm" variant={item.actionable ? "primary" : "secondary"} icon={item.actionable ? PhoneCall : undefined} onClick={() => setParam({ followUp: item._id })}>{item.actionable ? "Contact" : "Review"}</Button></div></td>
        </tr>)}</tbody>
      </table>
    </TableCard>

    {openId && <FollowUpDrawer id={openId} onClose={() => setParam({ followUp: null })} onChanged={state.reload} />}
  </ServiceShell>;
}

// ---------------------------------------------------------------------------
// Detail drawer: device + coverage context, contact history, and actions.
// ---------------------------------------------------------------------------
const ACTIONS = [
  { key: 'contact', label: 'Contact Corporate', icon: PhoneCall, primary: true },
  { key: 'schedule', label: 'Schedule Service', icon: CalendarCheck2 },
  { key: 'remind-later', label: 'Remind Later', icon: CalendarClock },
  { key: 'mark-not-required', label: 'Mark Not Required', icon: CircleSlash },
];
const DONE_MESSAGES = { contact: 'Contact recorded.', schedule: 'Service scheduled. The corporate admin has been notified.', 'remind-later': 'Reminder set. The device leaves the action queue until then.', 'mark-not-required': 'Marked not required. The next service cycle has been set.' };

function FollowUpDrawer({ id, onClose, onChanged }) {
  const state = useAsync(() => getProactiveFollowUp(id), [id]);
  const [mode, setMode] = useState(null);
  const [done, setDone] = useState('');
  const item = state.data;
  const canAct = item && ['Open', 'Contacted', 'Remind Later', 'Scheduled'].includes(item.stage);
  const afterAction = (action, result) => { state.setData(result); setMode(null); setDone(DONE_MESSAGES[action]); onChanged(); };

  return <Drawer title={item ? item.device.model : 'Service follow-up'} eyebrow={item ? [item.device.serialNumber, item.company?.name].filter(Boolean).join(' · ') : undefined} icon={<Laptop size={18} />} onClose={onClose} width={560}>
    {state.loading && !item ? <div className="stack-12"><Skeleton height={60} /><Skeleton height={160} /><Skeleton height={80} /></div>
      : state.error ? <ErrorState compact title="Unable to load this follow-up" message={friendlyError(state.error)} onRetry={state.reload} />
      : <>
        <div className="pro-drawer-section">
          <div className="row-between"><ProactiveStatus status={item.status} />{item.ticket?.ticketId && <Badge>{item.ticket.ticketId}</Badge>}</div>
          <p className="pro-reason"><AlertTriangle size={16} aria-hidden="true" /><span>{reasonText(item)}</span></p>
          {done && <InlineAlert tone="success" title={done} />}
          {item.stage === 'Scheduled' && <InlineAlert tone="info" title={`Scheduled for ${formatDate(item.scheduledDate)}`}>The corporate admin confirms by raising the service request; it then follows the normal ticket workflow.</InlineAlert>}
          {item.stage === 'Remind Later' && <InlineAlert tone="info" title={`Reminder on ${formatDate(item.followUpDate)}`}>{item.followUpSetBy === 'corporate_admin' ? 'Requested by the corporate admin.' : 'Set by the service team.'}</InlineAlert>}
        </div>

        <div className="pro-drawer-section">
          <p className="pro-drawer-title">Service lifecycle</p>
          <ServiceLifecycle plan={item} />
        </div>

        <div className="pro-drawer-section">
          <p className="pro-drawer-title">Device and coverage</p>
          <InfoList columns={2} items={[
            ['Device', item.device.model], ['Serial number', <span className="mono">{item.device.serialNumber}</span>],
            ['Corporate', item.company?.name], ['Employee', item.device.employeeName || 'Unassigned'],
            ['Location', item.device.location], ['Service centre', item.serviceCentre?.name || 'Not mapped'],
            ['Purchase date', formatDate(item.purchaseDate, 'Not on record')], ['Last service', formatDate(item.lastServiceDate, 'None recorded')],
            ['Next service', formatDate(item.nextServiceDate, 'Not set')], ['Coverage', item.coverage.status],
            ['Warranty', `${item.coverage.warrantyStatus || 'Not on record'}${item.coverage.warrantyExpiry ? ` · ${formatDate(item.coverage.warrantyExpiry)}` : ''}`],
            ['AMC', `${item.coverage.amcStatus || 'Not on record'}${item.coverage.amcExpiry ? ` · ${formatDate(item.coverage.amcExpiry)}` : ''}`],
          ]} />
          {item.dataIssues?.length > 0 && <InlineAlert tone="warning" title="Record needs attention">{item.dataIssues.join('. ')}.</InlineAlert>}
        </div>

        {item.contact && (item.contact.name || item.contact.phone || item.contact.email) && <div className="pro-drawer-section">
          <p className="pro-drawer-title">Corporate contact</p>
          <InfoList items={[['Contact', item.contact.name], ['Phone', item.contact.phone ? <a className="cell-link" href={`tel:${item.contact.phone.replace(/[^+\d]/g, '')}`}>{item.contact.phone}</a> : null], ['Email', item.contact.email ? <a className="cell-link" href={`mailto:${item.contact.email}`}>{item.contact.email}</a> : null]].filter(([, value]) => value)} />
        </div>}

        {canAct && <div className="pro-drawer-section">
          <p className="pro-drawer-title">Next step</p>
          {mode ? <ActionForm action={mode} item={item} onCancel={() => setMode(null)} onDone={result => afterAction(mode, result)} />
            : <div className="pro-action-grid">{ACTIONS.map(action => <Button key={action.key} variant={action.primary ? 'primary' : 'secondary'} icon={action.icon} onClick={() => { setDone(''); setMode(action.key); }}>{action.label}</Button>)}</div>}
        </div>}

        <div className="pro-drawer-section">
          <p className="pro-drawer-title">Follow-up history</p>
          {item.contactLog.length || item.customerResponse ? <ul className="pro-log">
            {item.customerResponse && <li><strong>Customer: {item.customerResponse.type}{item.customerResponse.reason ? ` — ${item.customerResponse.reason}` : ''}</strong><span>{[item.customerResponse.byName, formatDateTime(item.customerResponse.at)].filter(Boolean).join(' · ')}</span>{item.customerResponse.notes && <span>{item.customerResponse.notes}</span>}</li>}
            {[...item.contactLog].reverse().map((entry, index) => <li key={entry._id || index}>
              <strong>{entry.outcome}</strong>
              <span>{[entry.method, entry.byName, formatDateTime(entry.at)].filter(Boolean).join(' · ')}</span>
              {entry.notes && <span>{entry.notes}</span>}
            </li>)}
          </ul> : <p className="text-muted text-small">No contact recorded yet.</p>}
        </div>

        <ServicePlanEditor item={item} onSaved={() => { state.reload(); onChanged(); }} />

        {item.tickets?.length > 0 && <div className="pro-drawer-section">
          <p className="pro-drawer-title">Service history</p>
          <ul className="pro-log">{item.tickets.slice(0, 5).map(ticket => <li key={ticket._id}>
            <strong>{ticket.ticketId} · {ticket.issueType || ticket.category}{ticket.serviceFollowUpId ? ' · Preventive' : ''}</strong>
            <span>{[ticket.status, ticket.assignedEngineer, formatDate(ticket.createdAt)].filter(Boolean).join(' · ')}</span>
          </li>)}</ul>
        </div>}
      </>}
  </Drawer>;
}

function ActionForm({ action, item, onCancel, onDone }) {
  const options = item.options;
  const [form, setForm] = useState({ method: 'Phone', outcome: 'Contacted', notes: '', followUpDate: '', scheduledDate: '', reason: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const needsFollowUpDate = action === 'remind-later' || (action === 'contact' && form.outcome === 'Customer Requested Later');
  const needsScheduledDate = action === 'schedule' || (action === 'contact' && form.outcome === 'Service Scheduled');
  const payload = useMemo(() => {
    if (action === 'contact') return { method: form.method, outcome: form.outcome, notes: form.notes, ...(needsFollowUpDate ? { followUpDate: form.followUpDate } : {}), ...(needsScheduledDate ? { scheduledDate: form.scheduledDate } : {}) };
    if (action === 'schedule') return { scheduledDate: form.scheduledDate, method: form.method, notes: form.notes };
    if (action === 'remind-later') return { followUpDate: form.followUpDate, notes: form.notes };
    return { reason: form.reason, notes: form.notes };
  }, [action, form, needsFollowUpDate, needsScheduledDate]);
  const invalid = (needsFollowUpDate && !form.followUpDate) || (needsScheduledDate && !form.scheduledDate) || (action === 'mark-not-required' && (!form.reason || (form.reason === 'Other' && !form.notes.trim())));
  const submit = async event => {
    event.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError('');
    try { onDone(await proactiveFollowUpAction(item._id, action, payload)); }
    catch (actionError) { setError(friendlyError(actionError, 'Unable to save this update.')); }
    finally { setBusy(false); }
  };
  const title = ACTIONS.find(entry => entry.key === action)?.label;
  return <form className="pro-form" onSubmit={submit} noValidate>
    <p className="subheading" style={{ margin: 0 }}>{title}</p>
    {(action === 'contact' || action === 'schedule') && <div className="pro-form-row">
      <Field label="Contact method">{props => <select {...props} value={form.method} onChange={set('method')}>{options.contactMethods.map(value => <option key={value}>{value}</option>)}</select>}</Field>
      {action === 'contact' && <Field label="Outcome">{props => <select {...props} value={form.outcome} onChange={set('outcome')}>{options.contactOutcomes.map(value => <option key={value}>{value}</option>)}</select>}</Field>}
    </div>}
    {needsScheduledDate && <Field label="Service date" required hint="The corporate admin is notified and confirms by raising the request.">{props => <input {...props} type="date" min={indiaDay()} value={form.scheduledDate} onChange={set('scheduledDate')} required />}</Field>}
    {needsFollowUpDate && <Field label="Follow up on" required hint="The device leaves the action queue until this date.">{props => <input {...props} type="date" min={indiaDay(1)} value={form.followUpDate} onChange={set('followUpDate')} required />}</Field>}
    {action === 'mark-not-required' && <fieldset className="pro-choice-list" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="field-label" style={{ marginBottom: 8 }}>Reason</legend>
      {options.notRequiredReasons.map(reason => <label className="pro-choice" key={reason}><input type="radio" name="reason" value={reason} checked={form.reason === reason} onChange={set('reason')} />{reason}</label>)}
    </fieldset>}
    <Field label={action === 'mark-not-required' && form.reason === 'Other' ? 'Notes (required)' : 'Notes'}>{props => <textarea {...props} rows={3} maxLength={1000} value={form.notes} onChange={set('notes')} placeholder="What was discussed or agreed" />}</Field>
    {action === 'mark-not-required' && <p className="text-small text-muted">This closes the current cycle only. The next recommended service is still calculated.</p>}
    {error && <InlineAlert title={error} />}
    <div className="form-actions"><Button onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" disabled={invalid || busy}>{busy ? 'Saving…' : 'Save'}</Button></div>
  </form>;
}

function ServicePlanEditor({ item, onSaved }) {
  const [months, setMonths] = useState(String(item.intervalMonths));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setMonths(String(item.intervalMonths)); }, [item.intervalMonths]);
  const save = async () => {
    setBusy(true);
    setError('');
    try { await updateDeviceServicePlan(item.deviceId, { serviceIntervalMonths: Number(months) }); onSaved(); }
    catch (saveError) { setError(friendlyError(saveError, 'Unable to update the service interval.')); }
    finally { setBusy(false); }
  };
  return <div className="pro-drawer-section">
    <p className="pro-drawer-title">Service interval</p>
    <div className="row">
      <label className="filter-select"><span className="sr-only">Service interval</span>
        <select value={months} onChange={event => setMonths(event.target.value)} aria-label="Service interval in months">{[...new Set([3, 4, 6, 9, 12, 18, 24, item.intervalMonths])].sort((a, b) => a - b).map(value => <option key={value} value={value}>Every {value} months</option>)}</select>
      </label>
      <Button size="sm" icon={BellRing} disabled={busy || Number(months) === item.intervalMonths} onClick={save}>{busy ? 'Saving…' : 'Update interval'}</Button>
    </div>
    {error && <InlineAlert title={error} />}
  </div>;
}
