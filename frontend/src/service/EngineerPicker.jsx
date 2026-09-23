import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Badge, Button, FilterSelect, SearchInput } from '../ui';
import { engineerFilterOptions, filterEngineers } from './engineerFilters';

// Engineer selector for ticket assignment: a select-like trigger that opens a
// panel with search, Location and Availability filters and the matching list.
export function EngineerPicker({ engineers, value, onChange, label }) {
  const labelId = useId();
  const panelId = useId();
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('All');
  const [status, setStatus] = useState('All');
  const { locations, statuses } = useMemo(() => engineerFilterOptions(engineers), [engineers]);
  const visible = useMemo(() => filterEngineers(engineers, { search, location, status }), [engineers, search, location, status]);
  const selected = engineers.find(engineer => engineer._id === value);
  const filtered = search || location !== 'All' || status !== 'All';
  const clear = () => { setSearch(''); setLocation('All'); setStatus('All'); };
  const close = () => { setOpen(false); triggerRef.current?.focus(); };

  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return <div className="field">
    <span className="field-label" id={labelId}>{label}</span>
    <button type="button" ref={triggerRef} className="picker-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={panelId} aria-labelledby={labelId} onClick={() => setOpen(current => !current)}>
      <span className={selected ? '' : 'text-muted'}>{selected ? `${selected.name} · ${selected.location || 'No location'}` : 'Select an engineer'}</span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && <div className="picker-panel" id={panelId}>
      <SearchInput className="search-full" value={search} onChange={setSearch} placeholder="Search engineers…" label="Search engineers by name, ID, email, phone or location" />
      <div className="picker-filters">
        <FilterSelect label="Location" value={location} onChange={setLocation} options={locations} allLabel="All locations" />
        <FilterSelect label="Availability" value={status} onChange={setStatus} options={statuses} allLabel="All availability" />
      </div>
      <div className="row-between text-small text-muted">
        <span aria-live="polite">{visible.length} of {engineers.length} engineers</span>
        {filtered && <button type="button" className="btn-link" onClick={clear}>Clear filters</button>}
      </div>
      <div className="entity-option-list" role="listbox" aria-labelledby={labelId}>
        {visible.map(engineer => <button key={engineer._id} type="button" role="option" aria-selected={engineer._id === value} className="entity-option" onClick={() => { onChange(engineer._id); close(); }}>
          <span style={{ minWidth: 0 }}><strong>{engineer.name}</strong><small>{[engineer.employeeId, engineer.location, `${engineer.assignedTicketCount ?? 0} active`].filter(Boolean).join(' · ')}</small></span>
          <Badge dot>{engineer.status}</Badge>
        </button>)}
        {!visible.length && <p className="text-muted text-small" style={{ padding: '12px 14px' }}>No engineers match these filters.</p>}
      </div>
      <div><Button size="sm" onClick={close}>Cancel</Button></div>
    </div>}
  </div>;
}
