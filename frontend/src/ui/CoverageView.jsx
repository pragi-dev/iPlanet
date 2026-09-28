import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, FilterBar, FilterSelect, PageHeader, PageSkeleton, SearchInput, SectionHeader, TableCard } from './primitives';
import { NextAction } from './experience';
import { formatDate, friendlyError } from './format';
import { pluralize } from './insights';
import { DeviceIcon } from './ticket';

function coverageType(device) {
  const warranty = device.warrantyStatus === 'Active' || device.warrantyStatus === 'Expiring Soon';
  const amc = device.amcStatus === 'Active' || device.amcStatus === 'Expiring Soon';
  if (warranty && amc) return 'Warranty + AMC';
  if (warranty) return 'Warranty';
  if (amc) return 'AMC';
  return 'None';
}

// One filter vocabulary for both portals; each maps directly to device fields.
const filters = {
  Covered: device => device.coverageStatus === 'Covered',
  'Warranty active': device => device.warrantyStatus === 'Active',
  'AMC active': device => device.amcStatus === 'Active',
  'Expiring Soon': device => device.warrantyStatus === 'Expiring Soon' || device.amcStatus === 'Expiring Soon',
  Expired: device => device.warrantyStatus === 'Expired' || device.amcStatus === 'Expired',
};
const filterLabels = { 'Expiring Soon': 'Expiring soon' };

export function CoverageView({ state, description, showCorporate = false, deviceLink }) {
  const { data, error, loading, reload } = state;
  const [params] = useSearchParams();
  const [search, setSearch] = useState(params.get('search') || '');
  const [filter, setFilter] = useState(filters[params.get('filter')] ? params.get('filter') : 'All');
  const all = data?.devices || [];
  const devices = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter(device => (filter === 'All' || filters[filter](device))
      && (!term || [device.model, device.serialNumber, device.assetId, device.employeeName, device.location, device.companyId?.name].some(value => String(value || '').toLowerCase().includes(term))));
  }, [all, search, filter]);

  if (loading && !data) return <PageSkeleton kpis={5} />;
  if (error && !data) return <><PageHeader title="Warranty & Coverage" description={description} /><div className="card"><ErrorState title="Unable to load coverage" message={friendlyError(error)} onRetry={reload} /></div></>;

  const summary = data.summary || {};
  const counts = Object.fromEntries(Object.entries(filters).map(([key, test]) => [key, all.filter(test).length]));
  const toggle = key => setFilter(current => (current === key ? 'All' : key));
  const tiles = [
    ['Covered', 'Covered devices', `of ${pluralize(summary.total ?? all.length, 'device')}`],
    ['Warranty active', 'Warranty active', null],
    ['AMC active', 'AMC active', null],
    ['Expiring Soon', 'Expiring soon', 'Within the renewal window', 'warning'],
    ['Expired', 'Expired', 'Warranty or AMC ended'],
  ];

  return <>
    <PageHeader title="Warranty & Coverage" description={description} />
    {counts['Expiring Soon'] > 0 && filter !== 'Expiring Soon' && <NextAction tone="warning" eyebrow="Coverage" title={`${pluralize(counts['Expiring Soon'], 'device')} with coverage expiring soon`} description="Review these devices before their warranty or AMC lapses." actions={[{ label: 'Show expiring devices', onClick: () => setFilter('Expiring Soon') }]} live={false} />}
    <section className="page-section" aria-labelledby="coverage-overview">
      <SectionHeader id="coverage-overview" title="Coverage overview" description="Select a figure to filter the table." />
      <div className="kpi-grid" style={{ '--kpi-columns': 5 }} role="group" aria-label="Coverage filters">
        {tiles.map(([key, label, hint, tone]) => <button key={key} type="button" className={`kpi kpi-button kpi-${tone && counts[key] ? tone : 'neutral'}`} aria-pressed={filter === key} onClick={() => toggle(key)}>
          <span className="kpi-label">{label}</span>
          <strong className="kpi-value">{counts[key]}</strong>
          {hint && <span className="kpi-hint">{hint}</span>}
        </button>)}
      </div>
    </section>
    <section className="page-section" aria-labelledby="coverage-details">
      <SectionHeader id="coverage-details" title="Coverage details" />
      <TableCard
        columns={7}
        toolbar={<FilterBar summary={`${devices.length} of ${pluralize(all.length, 'device')}`}>
          <SearchInput value={search} onChange={setSearch} placeholder={showCorporate ? 'Search serial, model, employee or corporate' : 'Search serial, model or employee'} label="Search coverage" />
          <FilterSelect label="Coverage filter" value={filter} onChange={setFilter} options={Object.keys(filters).map(key => ({ value: key, label: filterLabels[key] || key }))} allLabel="All coverage" />
        </FilterBar>}
        isEmpty={!devices.length}
        empty={<EmptyState icon={ShieldCheck} title={all.length ? 'No devices match these filters' : 'No devices registered yet'} description={all.length ? 'Try a different search term or coverage filter.' : 'Coverage appears here once devices are enrolled.'} action={all.length && (search || filter !== 'All') ? <Button size="sm" onClick={() => { setSearch(''); setFilter('All'); }}>Clear filters</Button> : null} />}
      >
        <table className="table">
          <thead><tr><th>Device</th><th>Serial</th>{showCorporate && <th>Corporate</th>}<th>Location</th><th>Coverage</th><th>Status</th><th>Purchased</th><th>Warranty ends</th><th>AMC ends</th></tr></thead>
          <tbody>{devices.map(device => <tr key={device._id}>
            <td><div className="person-cell"><span className="thumb"><DeviceIcon type={device.deviceType} model={device.model} size={16} /></span><div>{deviceLink ? <Link className="cell-link" to={deviceLink(device)}>{device.model}</Link> : <span className="cell-primary">{device.model}</span>}<span className="cell-sub">{[device.assetId, device.employeeName].filter(Boolean).join(' · ')}</span></div></div></td>
            <td className="mono cell-nowrap">{device.serialNumber}</td>
            {showCorporate && <td>{device.companyId?.name || <span className="text-muted">Not assigned</span>}</td>}
            <td>{device.location || '—'}</td>
            <td><span className="cell-primary">{coverageType(device)}</span>{device.entitlements?.length ? <span className="cell-sub">{device.entitlements.join(' · ')}</span> : null}</td>
            <td><Badge dot>{device.coverageStatus || 'Not available'}</Badge></td>
            <td className="cell-nowrap">{formatDate(device.purchaseDate)}</td>
            <td className="cell-nowrap">{formatDate(device.warrantyExpiry)}<span className="cell-sub">{device.warrantyStatus || '—'}</span></td>
            <td className="cell-nowrap">{formatDate(device.amcExpiry)}<span className="cell-sub">{device.amcStatus || '—'}</span></td>
          </tr>)}</tbody>
        </table>
      </TableCard>
    </section>
  </>;
}
