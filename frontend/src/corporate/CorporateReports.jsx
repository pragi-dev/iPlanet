import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, CircleCheck, ClipboardList, Clock3, Download, Laptop, Ticket } from 'lucide-react';
import { Shell } from './components';
import { PeriodCalendar } from './PeriodCalendar';
import { getDevices, getTicketResolutions, getTickets } from './api';
import { PERIOD_KINDS, closedAt, coverage, latestDate, periodForDate, raisedIn, rangePeriod, summarise, trend } from './reportData';
import { BarList, ColumnChart } from '../ui/charts';
import { Badge, Button, Card, ErrorState, InlineAlert, KPI, KPIGrid, PageHeader, PageSkeleton, TableCard, formatDate, friendlyError, pluralize, readSessionUser, useAsync } from '../ui';

// Reports on the organization's own requests and devices for one year, month, week or day. What is shown is exactly what the PDF download contains. A separate module,
// so the charting library only loads here.
const STEP_LABELS = { year: 'year', month: 'month', day: 'day', hour: 'hour' };
const COLUMNS = [
  { key: 'ticketId', label: 'Request', value: ticket => ticket.ticketId || '' },
  { key: 'createdAt', label: 'Raised', value: ticket => new Date(ticket.createdAt).getTime() || 0 },
  { key: 'category', label: 'Type', value: ticket => ticket.category || 'Service' },
  { key: 'issueType', label: 'Issue', value: ticket => ticket.issueType || '' },
  { key: 'location', label: 'Location', value: ticket => ticket.location || '' },
  { key: 'status', label: 'Status', value: ticket => ticket.status || '' },
  { key: 'closedAt', label: 'Closed', value: ticket => ticket.status === 'Closed' ? new Date(closedAt(ticket)).getTime() || 0 : 0 },
];

function SortableRequests({ tickets, description }) {
  const [sort, setSort] = useState({ key: 'createdAt', direction: 'desc' });
  const column = COLUMNS.find(item => item.key === sort.key);
  const rows = useMemo(() => [...tickets].sort((a, b) => {
    const [x, y] = [column.value(a), column.value(b)];
    const order = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    return sort.direction === 'asc' ? order : -order;
  }), [tickets, column, sort.direction]);
  const toggle = key => setSort(current => current.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: ['createdAt', 'closedAt'].includes(key) ? 'desc' : 'asc' });
  return <TableCard columns={COLUMNS.length} toolbar={<div style={{ padding: '20px 24px 8px' }}><h2 className="card-title" style={{ margin: 0 }}>Requests in this period</h2><p className="text-muted text-small" style={{ margin: '4px 0 0' }}>{description}</p></div>} isEmpty={!rows.length} empty={<p className="text-muted" style={{ padding: 24, margin: 0 }}>No requests were raised in this period.</p>}>
    <table className="table">
      <thead><tr>{COLUMNS.map(item => {
        const active = sort.key === item.key;
        const Icon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
        return <th key={item.key} aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
          <button type="button" className="btn-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: 'inherit', color: 'inherit' }} onClick={() => toggle(item.key)}>{item.label}<Icon size={13} aria-hidden="true" style={{ opacity: active ? 1 : 0.4 }} /></button>
        </th>;
      })}</tr></thead>
      <tbody>{rows.map(ticket => <tr key={ticket._id}>
        <td><Link className="cell-link mono" to={`/corporate/service-requests/${ticket._id}`}>{ticket.ticketId}</Link></td>
        <td className="cell-nowrap">{formatDate(ticket.createdAt)}</td>
        <td>{ticket.category || 'Service'}</td>
        <td>{ticket.issueType || '—'}</td>
        <td>{ticket.location || '—'}</td>
        <td><Badge dot>{ticket.status}</Badge></td>
        <td className="cell-nowrap">{ticket.status === 'Closed' ? formatDate(closedAt(ticket)) : '—'}</td>
      </tr>)}</tbody>
    </table>
  </TableCard>;
}

export function CorporateReports() {
  const state = useAsync(() => Promise.all([getTickets(), getDevices()]).then(([tickets, devices]) => ({ tickets, devices })), []);
  const [kind, setKind] = useState('month');
  const [keys, setKeys] = useState({});
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const allTickets = state.data?.tickets;
  if (state.loading && !state.data) return <Shell title="Reports"><PageSkeleton kpis={5} /></Shell>;
  if (state.error) return <Shell title="Reports"><PageHeader title="Reports" /><div className="card"><ErrorState title="Unable to load reports" message={friendlyError(state.error)} onRetry={state.reload} /></div></Shell>;

  const { devices } = state.data;
  const period = kind === 'custom' ? rangePeriod(keys.custom?.from, keys.custom?.to) : periodForDate(kind, keys[kind]);
  const setRange = (edge, value) => setKeys(current => ({ ...current, custom: { from: period.from, to: period.to, [edge]: value } }));
  const tickets = raisedIn(allTickets, period);
  const figures = summarise(tickets);
  const fleet = coverage(devices);
  const timeline = trend(allTickets, kind, period);
  const scope = period.title;

  const download = async () => {
    setDownloading(true);
    setDownloadError('');
    try {
      const [{ downloadReportPdf }, resolutions] = await Promise.all([import('./reportPdf'), getTicketResolutions()]);
      downloadReportPdf({ period, kind, tickets: allTickets, devices, resolutions, organization: readSessionUser().company });
    } catch (error) {
      setDownloadError(friendlyError(error, 'The PDF could not be created. Please try again.'));
    } finally {
      setDownloading(false);
    }
  };

  const actions = <>
    <label className="filter-select report-kind"><span className="sr-only">Report type</span><select value={kind} onChange={event => setKind(event.target.value)} aria-label="Report type">{PERIOD_KINDS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    {kind === 'custom'
      ? <div className="report-range">
        <label className="filter-select"><span className="sr-only">From</span><input type="date" value={period.from} max={period.to} onChange={event => event.target.value && setRange('from', event.target.value)} aria-label="From date" title="From" /></label>
        <label className="filter-select"><span className="sr-only">To</span><input type="date" value={period.to} min={period.from} max={latestDate()} onChange={event => event.target.value && setRange('to', event.target.value)} aria-label="To date" title="To" /></label>
      </div>
      : ['year', 'month'].includes(kind)
        ? <PeriodCalendar kind={kind} value={period.value} max={latestDate()} label="Period" onChange={value => setKeys(current => ({ ...current, [kind]: value }))} />
        : <label className="filter-select report-period"><span className="sr-only">Period</span><input type="date" value={period.value} max={latestDate()} onChange={event => event.target.value && setKeys(current => ({ ...current, [kind]: event.target.value }))} aria-label="Period" title="Pick a day" /></label>}
    <Button variant="primary" icon={Download} onClick={download} disabled={downloading}>{downloading ? 'Preparing…' : 'Download PDF'}</Button>
  </>;
  return <Shell title="Reports">
    <PageHeader title="Reports" description={`Service requests raised ${{ day: 'on ', custom: '' }[kind] ?? 'in '}${scope}, with turnaround and device coverage. Download PDF saves this period.`} actions={actions} />
    {downloadError && <InlineAlert title={downloadError} />}
    <KPIGrid columns={5}>
      <KPI label="Service requests" value={figures.total} icon={Ticket} hint={scope} />
      <KPI label="Still open" value={figures.open} icon={ClipboardList} tone="info" hint="Of requests raised" />
      <KPI label="Closed" value={figures.closed} icon={CircleCheck} tone="success" hint="Of requests raised" />
      <KPI label="Avg. turnaround" value={figures.avgDays === null ? '—' : `${figures.avgDays.toFixed(1)} days`} icon={Clock3} hint={figures.closedCount ? `Raised → closed, ${pluralize(figures.closedCount, 'request')}` : 'No closed requests'} />
      <KPI label="Devices" value={devices.length} icon={Laptop} hint="Registered today" />
    </KPIGrid>
    <div className="grid-main-side">
      <Card title="When were requests raised?" description={`Requests per ${STEP_LABELS[timeline.step]} · ${scope}`}><ColumnChart data={timeline.data} dataKey="requests" seriesName="Requests" emptyText="No requests raised in this period." /></Card>
      <Card title="Where do these requests stand?" description={`By status · ${scope}`}><BarList data={figures.byStatus} emptyText="No requests in this period." /></Card>
    </div>
    <div className="grid-2">
      <Card title="Is iPlanet meeting its targets?" description={figures.resolvedCount ? `${figures.onTargetPercent}% of ${pluralize(figures.resolvedCount, 'resolved request')} met the resolution target · ${scope}` : `No resolved requests · ${scope}`}><BarList data={figures.sla} emptyText="No requests in this period." /></Card>
      <Card title="What are we asking for?" description={`By request type · ${scope}`}><BarList data={figures.byType} emptyText="No requests in this period." /></Card>
    </div>
    <div className="grid-main-side">
      <Card title="What issues come up most?" description={`Most reported issues · ${scope}`}><ColumnChart data={figures.byIssue} seriesName="Requests" emptyText="No service requests in this period." /></Card>
      <Card title="Where is service needed?" description={`By service location · ${scope}`}><BarList data={figures.byLocation} emptyText="No requests in this period." /></Card>
    </div>
    <div className="grid-3">
      <Card title="Which devices need service?" description={`By device type · ${scope}`}><BarList data={figures.byDeviceType} emptyText="No requests in this period." /></Card>
      <Card title="How much of the fleet is under warranty?" description="All devices, as of today"><BarList data={fleet.warranty} tone="#34c759" emptyText="No devices registered yet." /></Card>
      <Card title="How much of the fleet has AMC?" description="All devices, as of today"><BarList data={fleet.amc} tone="#34c759" emptyText="No devices registered yet." /></Card>
    </div>
    <SortableRequests tickets={tickets} description={`${pluralize(tickets.length, 'request')} raised · ${scope}. Select a column heading to sort.`} />
  </Shell>;
}
