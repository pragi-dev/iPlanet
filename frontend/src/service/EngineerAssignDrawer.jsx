import { useMemo, useState } from 'react';
import { UserCheck, UsersRound } from 'lucide-react';
import { assignEngineer } from './api';
import { engineerFilterOptions, filterEngineers } from './engineerFilters';
import { Avatar, Badge, Button, Drawer, FilterSelect, InlineAlert, SearchInput, friendlyError, suggestEngineer } from '../ui';

function Workload({ count = 0, max }) {
  const cap = Math.max(5, max);
  return <span className="workload" title={`${count} open ticket${count === 1 ? '' : 's'}`}>
    <span className="workload-dots" aria-hidden="true">{Array.from({ length: Math.min(cap, 8) }, (_, index) => <i key={index} className={index < count ? 'on' : ''} />)}</span>
    {count} open
  </span>;
}

// Assignment workspace: search + Location + Availability filters over the
// engineers API, each engineer shown with location, availability and open
// workload. A suggestion appears only when an available engineer works in the
// ticket's location; the reasons are stated, nothing is inferred.
export function EngineerAssignDrawer({ ticket, engineers, onClose, onAssigned }) {
  const currentId = String(ticket.assignedEngineerId?._id || ticket.assignedEngineerId || '');
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('All');
  const [status, setStatus] = useState('All');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { locations, statuses } = useMemo(() => engineerFilterOptions(engineers), [engineers]);
  const suggestion = useMemo(() => suggestEngineer(engineers, ticket), [engineers, ticket]);
  const ticketLocation = String(ticket.location || '').toLowerCase();
  const maxLoad = Math.max(0, ...engineers.map(engineer => engineer.assignedTicketCount || 0));
  const visible = useMemo(() => filterEngineers(engineers, { search, location, status }).sort((a, b) => {
    const local = engineer => (String(engineer.location || '').toLowerCase() === ticketLocation ? 0 : 1);
    const free = engineer => (engineer.status === 'Available' ? 0 : 1);
    return local(a) - local(b) || free(a) - free(b) || (a.assignedTicketCount || 0) - (b.assignedTicketCount || 0) || String(a.name).localeCompare(String(b.name));
  }), [engineers, search, location, status, ticketLocation]);
  const filtered = search || location !== 'All' || status !== 'All';
  const chosen = engineers.find(engineer => String(engineer._id) === selected);

  const assign = async engineerId => {
    if (!engineerId || busy) return;
    setBusy(true);
    setError('');
    try { await assignEngineer(ticket._id, engineerId); onAssigned(engineers.find(engineer => String(engineer._id) === String(engineerId))); }
    catch (assignError) { setError(friendlyError(assignError, 'Unable to assign this engineer.')); setBusy(false); }
  };

  return <Drawer className="assign-drawer" width={460} title={currentId ? 'Reassign engineer' : 'Assign engineer'} eyebrow={`${ticket.ticketId} · ${ticket.issueType || 'Service'}${ticket.location ? ` · ${ticket.location}` : ''}`} icon={<UsersRound size={18} />} onClose={onClose}
    footer={<div className="row-between"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" icon={UserCheck} disabled={!chosen || busy || String(chosen?._id) === currentId} onClick={() => assign(selected)}>{busy ? 'Assigning…' : chosen ? `Assign ${chosen.name.split(' ')[0]}` : 'Assign engineer'}</Button></div>}>
    {suggestion && <section className="suggestion-card" aria-label="Suggested engineer">
      <div className="suggestion-card-head">
        <div>
          <p className="suggestion-eyebrow">Suggested engineer</p>
          <div className="person-block" style={{ marginTop: 6 }}><Avatar name={suggestion.engineer.name} size={36} /><div><strong>{suggestion.engineer.name}</strong><small>{suggestion.engineer.employeeId}</small></div></div>
        </div>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => assign(suggestion.engineer._id)}>Assign</Button>
      </div>
      <p className="suggestion-reasons">{suggestion.reasons.map(reason => <span key={reason}>{reason}</span>)}</p>
    </section>}

    <div className="stack-12">
      <SearchInput className="search-full" value={search} onChange={setSearch} placeholder="Search engineers…" label="Search engineers by name, ID, email, phone or location" data-autofocus />
      <div className="filter-row">
        <FilterSelect label="Location" value={location} onChange={setLocation} options={locations} allLabel="All locations" />
        <FilterSelect label="Availability" value={status} onChange={setStatus} options={statuses} allLabel="All availability" />
      </div>
      <div className="row-between text-small text-muted">
        <span aria-live="polite">{visible.length} of {engineers.length} engineers{ticket.location ? ` · ${ticket.location} first` : ''}</span>
        {filtered && <button type="button" className="btn-link" onClick={() => { setSearch(''); setLocation('All'); setStatus('All'); }}>Clear filters</button>}
      </div>
    </div>

    <div className="engineer-list" role="radiogroup" aria-label="Engineers" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const options = [...event.currentTarget.querySelectorAll('[role="radio"]')];
      const index = options.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const nextOption = options[Math.min(options.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      nextOption.focus();
      nextOption.click();
    }}>
      {visible.map(engineer => {
        const id = String(engineer._id);
        const local = ticketLocation && String(engineer.location || '').toLowerCase() === ticketLocation;
        return <button key={id} type="button" role="radio" aria-checked={selected === id} className="engineer-option" onClick={() => setSelected(id)} onDoubleClick={() => assign(id)}>
          <Avatar name={engineer.name} size={36} />
          <span className="engineer-option-text">
            <strong>{engineer.name}{id === currentId && <span className="tag" style={{ marginLeft: 8 }}>Current</span>}{local && <span className="tag tag-accent" style={{ marginLeft: 8 }}>Same location</span>}</strong>
            <small>{[engineer.location || 'No location', engineer.employeeId, engineer.phone].filter(Boolean).join(' · ')}</small>
          </span>
          <span className="engineer-option-side"><Badge dot>{engineer.status || 'Unknown'}</Badge><Workload count={engineer.assignedTicketCount || 0} max={maxLoad} /></span>
        </button>;
      })}
      {!visible.length && <p className="text-muted text-small" style={{ padding: '12px 4px' }}>No engineers match these filters. Clear a filter to see more of the team.</p>}
    </div>
    {error && <InlineAlert title={error} />}
  </Drawer>;
}
