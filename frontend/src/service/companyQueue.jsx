import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Ticket, X } from 'lucide-react';
import { ServiceShell } from './components';
import { getCompanies, getServiceCentres, getServiceTickets } from './api';
import { Badge, Button, EmptyState, FilterBar, FilterSelect, PageHeader, RowAction, SearchInput, TableCard, formatDate, friendlyError, slaLabel, useAsync } from '../ui';

const statuses = ['Open', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts', 'Completed', 'Closed'];
const locations = ['Chennai', 'Coimbatore', 'Bengaluru', 'Madurai'];
const filterKeys = ['companyId', 'assignment', 'status', 'priority', 'location', 'slaStatus', 'date'];

export function MyTickets() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const initial = () => ({ search: params.get('search') || '', ...Object.fromEntries(filterKeys.map(key => [key, params.get(key) || (key === 'date' ? '' : 'All')])) });
  const [filters, setFilters] = useState(initial);
  const [searchText, setSearchText] = useState(filters.search);
  const [centre, setCentre] = useState(params.get('serviceCentreId') || 'All');
  useEffect(() => { const next = initial(); setFilters(next); setSearchText(next.search); setCentre(params.get('serviceCentreId') || 'All'); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = window.setTimeout(() => setFilters(current => current.search === searchText ? current : { ...current, search: searchText }), 300); return () => window.clearTimeout(timer); }, [searchText]);

  const lookups = useAsync(() => Promise.all([getCompanies(), getServiceCentres()]).then(([companies, centres]) => ({ companies, centres })), []);
  const state = useAsync(() => getServiceTickets(filters), [JSON.stringify(filters)]);
  const update = (key, value) => setFilters(current => ({ ...current, [key]: value }));
  // The API has no service-centre filter, so it is applied to the loaded tickets.
  const tickets = useMemo(() => (state.data || []).filter(ticket => centre === 'All' || String(ticket.serviceCentreId?._id || ticket.serviceCentreId) === centre), [state.data, centre]);
  const active = filterKeys.some(key => filters[key] && filters[key] !== 'All') || filters.search || centre !== 'All';
  const clear = () => { setParams({}); setFilters({ search: '', ...Object.fromEntries(filterKeys.map(key => [key, key === 'date' ? '' : 'All'])) }); setSearchText(''); setCentre('All'); };

  return <ServiceShell title="Tickets">
    <PageHeader title="Tickets" description="Every service request raised by corporate customers." />
    <TableCard
      columns={10}
      loading={state.loading && !state.data}
      error={state.error && friendlyError(state.error)}
      errorTitle="Unable to load tickets"
      onRetry={state.reload}
      toolbar={<FilterBar summary={state.data ? <span className="row">{state.loading && <span className="text-muted">Updating…</span>}{`${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`}{active && <Button size="sm" variant="ghost" icon={X} onClick={clear}>Clear filters</Button>}</span> : null}>
        <SearchInput value={searchText} onChange={setSearchText} placeholder="Search ticket, device, serial or company" label="Search tickets" />
        <FilterSelect label="Status" value={filters.status} onChange={value => update('status', value)} options={statuses} allLabel="All statuses" />
        <FilterSelect label="Priority" value={filters.priority} onChange={value => update('priority', value)} options={['Low', 'Medium', 'High', 'Critical']} allLabel="All priorities" />
        <FilterSelect label="Corporate" value={filters.companyId} onChange={value => update('companyId', value)} options={(lookups.data?.companies || []).map(company => ({ value: company._id, label: company.name }))} allLabel="All corporates" />
        <FilterSelect label="Service centre" value={centre} onChange={setCentre} options={(lookups.data?.centres || []).map(item => ({ value: item._id, label: item.name }))} allLabel="All service centres" />
        <FilterSelect label="Location" value={filters.location} onChange={value => update('location', value)} options={locations} allLabel="All locations" />
        <FilterSelect label="SLA" value={filters.slaStatus} onChange={value => update('slaStatus', value)} options={['Healthy', 'At Risk', 'Escalated', 'SLA Breached', 'Resolved']} allLabel="All SLA states" />
        <FilterSelect label="Assignment" value={filters.assignment} onChange={value => update('assignment', value)} options={['Assigned', 'Unassigned']} allLabel="All assignments" />
        <label className="filter-select"><span className="sr-only">Created on</span><input type="date" value={filters.date} onChange={event => update('date', event.target.value)} aria-label="Created on date" /></label>
      </FilterBar>}
      isEmpty={!tickets.length}
      empty={active ? <EmptyState icon={Search} title="No tickets match these filters" description="Try a different search term or clear the filters." action={<Button size="sm" onClick={clear}>Clear filters</Button>} /> : <EmptyState icon={Ticket} title="No tickets yet" description="Tickets raised by corporate customers will appear here." />}
    >
      <table className="table table-compact">
        <thead><tr><th>Ticket ID</th><th>Corporate</th><th>Device</th><th>Issue</th><th>Priority</th><th>Engineer</th><th>Status</th><th>SLA</th><th>Created</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{tickets.map(ticket => <tr key={ticket._id} className="row-clickable" onClick={event => { if (!event.target.closest('a')) navigate(`/service/tickets/${ticket._id}`); }}>
          <td className="cell-nowrap"><Link className="cell-link mono" to={`/service/tickets/${ticket._id}`}>{ticket.ticketId}</Link><span className="cell-sub">{ticket.location}</span></td>
          <td>{ticket.companyId?.name || ticket.customerId?.company || '—'}</td>
          <td><span className="cell-primary">{ticket.deviceId?.model || '—'}</span><span className="cell-sub mono">{ticket.deviceId?.serialNumber}</span></td>
          <td>{ticket.issueType || '—'}<span className="cell-sub">{ticket.category}</span></td>
          <td><Badge>{ticket.priority}</Badge></td>
          <td>{ticket.assignedEngineer || <span className="text-muted">Unassigned</span>}</td>
          <td><Badge dot>{ticket.status}</Badge></td>
          <td><Badge>{slaLabel(ticket)}</Badge></td>
          <td className="cell-nowrap">{formatDate(ticket.createdAt)}</td>
          <td className="cell-right"><RowAction to={`/service/tickets/${ticket._id}`} label="Open" /></td>
        </tr>)}</tbody>
      </table>
    </TableCard>
  </ServiceShell>;
}
