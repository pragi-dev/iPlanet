import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Inbox, Search, X } from 'lucide-react';
import { Button, EmptyState, FilterBar, FilterSelect, PageHeader, RowAction, SearchInput, TableCard, Tabs, formatDate, formatRelative, friendlyError, pluralize, useAsync } from '../ui';
import { getB2CTickets } from './api';
import { ACTIVE_STATUSES, B2CShell, B2CStatus, B2C_ROLE_LABELS, B2C_STATUSES, CategoryBadge, IDENTIFIER_LABELS, NoB2CAccess, REGION_STATUS, REGISTRATION_STATUS, TRIAGE_REASONS, ageLabel, isB2CAdmin, registrationLabel } from './shared';

const LEVELS = Object.entries(B2C_ROLE_LABELS).filter(([key]) => key !== 'b2c_admin').map(([value, label]) => ({ value, label }));
const AGEING = ['Under 1 day', '1–3 days', '3–7 days', '7–14 days', 'Over 14 days'];
const SORTS = [
  { value: 'createdAt:desc', label: 'Newest first' },
  { value: 'createdAt:asc', label: 'Oldest first' },
  { value: 'lastActivityAt:desc', label: 'Recently active' },
  { value: 'reference:asc', label: 'Reference' },
];
const FILTER_KEYS = ['status', 'category', 'region', 'regionStatus', 'registrationStatus', 'level', 'ageing'];
const REGION_STATUS_OPTIONS = Object.entries(REGION_STATUS).map(([value, item]) => ({ value, label: item.label }));
const REGISTRATION_OPTIONS = [{ value: 'open', label: 'Waiting for the customer' }, ...['manual_review', 'expired', 'completed', 'not_requested', 'cancelled'].map(value => ({ value, label: REGISTRATION_STATUS[value].label }))];
// Each tab is a preset of API filters.
const VIEWS = {
  active: { label: 'Active', params: { status: 'active' } },
  mine: { label: 'Assigned to me', params: { assignee: 'me', status: 'active' } },
  unassigned: { label: 'Waiting for an owner', params: { assignee: 'unassigned' } },
  validation: { label: 'Pending validation', params: { queue: 'validation' } },
  triage: { label: 'Needs triage', params: { status: 'Pending Triage' }, admin: true },
  all: { label: 'All', params: {} },
};

export function B2CQueue() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const admin = isB2CAdmin();
  const view = VIEWS[params.get('view')] && (!VIEWS[params.get('view')].admin || admin) ? params.get('view') : 'active';
  const filters = Object.fromEntries(FILTER_KEYS.map(key => [key, params.get(key) || 'All']));
  const sort = SORTS.some(item => item.value === params.get('sort')) ? params.get('sort') : SORTS[0].value;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [searchText, setSearchText] = useState(params.get('search') || '');
  const search = params.get('search') || '';

  const set = changes => setParams(current => {
    const next = new URLSearchParams(current);
    Object.entries(changes).forEach(([key, value]) => (value && value !== 'All' ? next.set(key, value) : next.delete(key)));
    if (!('page' in changes)) next.delete('page');
    return next;
  }, { replace: true });
  useEffect(() => { const timer = window.setTimeout(() => { if (searchText !== search) set({ search: searchText }); }, 300); return () => window.clearTimeout(timer); }, [searchText]); // eslint-disable-line react-hooks/exhaustive-deps

  const [sortField, order] = sort.split(':');
  // An explicit status filter (e.g. "active" from the dashboard) refines the tab's preset.
  const request = { ...VIEWS[view].params, ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== 'All')), search, sort: sortField, order, page, limit: 25 };
  const state = useAsync(() => getB2CTickets(request), [JSON.stringify(request)]);
  const data = state.data;
  const filtered = FILTER_KEYS.some(key => filters[key] !== 'All') || search;
  const clear = () => { setSearchText(''); setParams(view === 'active' ? {} : { view }, { replace: true }); };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const tabs = Object.entries(VIEWS).filter(([, item]) => !item.admin || admin).map(([value, item]) => ({ value, label: item.label }));

  if (state.error?.status === 403) return <B2CShell title="Escalation queue"><PageHeader title="Escalation queue" /><NoB2CAccess /></B2CShell>;

  return <B2CShell title="Escalation queue">
    <PageHeader title="Escalation queue" description="Customer escalations received by email. Open one to see the conversation, customer details and workflow." />
    <Tabs label="Queue views" tabs={tabs} value={view} onChange={value => { setSearchText(''); setParams(value === 'active' ? {} : { view: value }, { replace: true }); }} />
    <TableCard
      columns={8}
      loading={state.loading && !data}
      error={state.error && friendlyError(state.error)}
      errorTitle="Unable to load escalations"
      onRetry={state.reload}
      toolbar={<FilterBar summary={data ? <span className="row">{state.loading && <span className="text-muted">Updating…</span>}{pluralize(data.total, 'escalation')}{filtered && <Button size="sm" variant="ghost" icon={X} onClick={clear}>Clear filters</Button>}</span> : null}>
        <SearchInput value={searchText} onChange={setSearchText} placeholder="Search reference, subject, customer, case ID or serial" label="Search escalations" />
        <FilterSelect label="Status" value={filters.status} onChange={value => set({ status: value })} options={[{ value: 'active', label: 'Any active status' }, ...B2C_STATUSES]} allLabel="All statuses" />
        <FilterSelect label="Category" value={filters.category} onChange={value => set({ category: value })} options={['Service', 'Retail', 'Unclassified']} allLabel="All categories" />
        <FilterSelect label="Region" value={filters.region} onChange={value => set({ region: value })} options={data?.facets.regions || []} allLabel="All regions" />
        <FilterSelect label="Region assignment" value={filters.regionStatus} onChange={value => set({ regionStatus: value })} options={REGION_STATUS_OPTIONS} allLabel="Any region assignment" />
        <FilterSelect label="Customer registration" value={filters.registrationStatus} onChange={value => set({ registrationStatus: value })} options={REGISTRATION_OPTIONS} allLabel="Any registration state" />
        <FilterSelect label="Workflow level" value={filters.level} onChange={value => set({ level: value })} options={LEVELS} allLabel="All levels" />
        <FilterSelect label="Age" value={filters.ageing} onChange={value => set({ ageing: value })} options={AGEING} allLabel="Any age (active)" />
        <label className="filter-select"><span className="sr-only">Sort</span><select aria-label="Sort" value={sort} onChange={event => set({ sort: event.target.value })}>{SORTS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      </FilterBar>}
      isEmpty={!data?.items.length}
      empty={filtered ? <EmptyState icon={Search} title="No escalations match these filters" description="Try a different search term or clear the filters." action={<Button size="sm" onClick={clear}>Clear filters</Button>} />
        : <EmptyState icon={Inbox} title={view === 'mine' ? 'Nothing is assigned to you' : view === 'triage' ? 'Nothing needs triage' : 'No escalations here'} description="Escalations appear here as customer emails are processed." />}
      footer={data && pages > 1 ? <div className="b2c-pager">
        <Button size="sm" icon={ChevronLeft} disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</Button>
        <span className="text-muted text-small">Page {page} of {pages}</span>
        <Button size="sm" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next<ChevronRight size={14} aria-hidden="true" /></Button>
      </div> : null}
    >
      <table className="table table-compact">
        <thead><tr><th>Reference</th><th>Customer</th><th>Category</th><th>Region</th><th>Level · owner</th><th>Status</th><th>Age</th><th><span className="sr-only">Open</span></th></tr></thead>
        <tbody>{(data?.items || []).map(ticket => <tr key={ticket._id} className="row-clickable" onClick={event => { if (!event.target.closest('a')) navigate(`/b2c/tickets/${ticket._id}`); }}>
          <td className="b2c-cell-ref"><Link className="cell-link mono" to={`/b2c/tickets/${ticket._id}`}>{ticket.reference}</Link><span className="cell-sub">{ticket.subject || 'No subject'}</span></td>
          <td>{ticket.customer?.name || ticket.customer?.email}<span className="cell-sub">{ticket.registration?.status ? registrationLabel(ticket.registration, ticket.workflow?.assignee?.userId) : (ticket.identifiers || []).slice(0, 2).map(item => `${IDENTIFIER_LABELS[item.type] || item.type} ${item.value}`).join(' · ') || 'No identifier'}</span></td>
          <td><CategoryBadge category={ticket.category} /></td>
          <td>{ticket.region || <span className="text-muted">Not set</span>}{ticket.regionAssignment?.status && <span className="cell-sub">{ticket.regionAssignment.status === 'unresolved' ? `Unresolved: ${TRIAGE_REASONS[ticket.regionAssignment.reason] || ticket.regionAssignment.reason}` : REGION_STATUS[ticket.regionAssignment.status]?.label}</span>}</td>
          <td>{ticket.workflow?.currentLevel ? B2C_ROLE_LABELS[ticket.workflow.currentLevel] || ticket.workflow.currentLevel : <span className="text-muted">Not routed</span>}<span className="cell-sub">{ticket.workflow?.assignee?.name || (ticket.status === 'Pending Triage' ? (ticket.triage?.reasons || []).map(reason => TRIAGE_REASONS[reason] || reason)[0] : 'Unassigned')}</span></td>
          <td><B2CStatus status={ticket.status} /></td>
          <td className="cell-nowrap" title={formatDate(ticket.createdAt)}>{ACTIVE_STATUSES.includes(ticket.status) ? ageLabel(ticket.createdAt) : formatDate(ticket.createdAt)}<span className="cell-sub">{formatRelative(ticket.lastActivityAt)}</span></td>
          <td className="cell-right"><RowAction to={`/b2c/tickets/${ticket._id}`} label="Open" /></td>
        </tr>)}</tbody>
      </table>
    </TableCard>
  </B2CShell>;
}
