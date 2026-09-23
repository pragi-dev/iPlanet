import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, ShieldCheck, ShieldOff, ShieldPlus, Wrench } from 'lucide-react';
import { Badge, EmptyState, ErrorState, FilterBar, FilterSelect, KPI, KPIGrid, PageHeader, PageSkeleton, SearchInput, TableCard } from './primitives';
import { formatDate, friendlyError } from './format';
import { DeviceIcon } from './ticket';

function coverageType(device) {
  const warranty = device.warrantyStatus === 'Active' || device.warrantyStatus === 'Expiring Soon';
  const amc = device.amcStatus === 'Active' || device.amcStatus === 'Expiring Soon';
  if (warranty && amc) return 'Warranty + AMC';
  if (warranty) return 'Warranty';
  if (amc) return 'AMC';
  return 'None';
}

export function CoverageView({ state, description, filterOptions, matchesFilter, showCorporate = false, deviceLink }) {
  const { data, error, loading, reload } = state;
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');
  const devices = useMemo(() => (data?.devices || []).filter(device => JSON.stringify(device).toLowerCase().includes(search.toLowerCase()) && (filter === 'All' || matchesFilter(device, filter))), [data, search, filter, matchesFilter]);

  if (loading && !data) return <PageSkeleton kpis={5} />;
  if (error && !data) return <><PageHeader title="Warranty & Coverage" description={description} /><div className="card"><ErrorState title="Unable to load coverage" message={friendlyError(error)} onRetry={reload} /></div></>;

  const summary = data.summary || {};
  return <>
    <PageHeader title="Warranty & Coverage" description={description} />
    <KPIGrid columns={5}>
      <KPI label="Total devices" value={summary.total} icon={ShieldPlus} />
      <KPI label="Warranty active" value={summary.warrantyActive} icon={ShieldCheck} tone="success" />
      <KPI label="AMC active" value={summary.amcActive} icon={Wrench} tone="info" />
      <KPI label="Expiring soon" value={summary.expiringSoon} icon={CalendarClock} tone="warning" />
      <KPI label="Expired" value={summary.expired} icon={ShieldOff} tone={summary.expired ? 'critical' : 'neutral'} />
    </KPIGrid>
    <TableCard
      columns={7}
      toolbar={<FilterBar summary={`${devices.length} of ${data.devices.length} devices`}>
        <SearchInput value={search} onChange={setSearch} placeholder={showCorporate ? 'Search serial, device or corporate' : 'Search device or serial'} label="Search coverage" />
        <FilterSelect label="Coverage filter" value={filter} onChange={setFilter} options={filterOptions} allLabel="All coverage" />
      </FilterBar>}
      isEmpty={!devices.length}
      empty={<EmptyState icon={ShieldCheck} title={data.devices.length ? 'No devices match these filters' : 'No devices registered yet'} description={data.devices.length ? 'Try a different search term or coverage filter.' : 'Coverage appears here once devices are enrolled.'} />}
    >
      <table className="table">
        <thead><tr><th>Device</th><th>Serial</th>{showCorporate && <th>Corporate</th>}<th>Location</th><th>Coverage type</th><th>Status</th><th>Warranty</th><th>AMC</th><th>Entitlements</th></tr></thead>
        <tbody>{devices.map(device => <tr key={device._id}>
          <td><div className="person-cell"><span className="asset-icon" style={{ width: 32, height: 32, borderRadius: 8 }}><DeviceIcon type={device.deviceType} model={device.model} size={16} /></span><div>{deviceLink ? <Link className="cell-link" to={deviceLink(device)}>{device.model}</Link> : <span className="cell-primary">{device.model}</span>}<span className="cell-sub">{device.assetId}</span></div></div></td>
          <td className="mono cell-nowrap">{device.serialNumber}</td>
          {showCorporate && <td>{device.companyId?.name || <span className="text-muted">Not assigned</span>}</td>}
          <td>{device.location || '—'}</td>
          <td className="cell-nowrap">{coverageType(device)}</td>
          <td><Badge dot>{device.coverageStatus || 'Not available'}</Badge></td>
          <td className="cell-nowrap"><Badge>{device.warrantyStatus || 'Not available'}</Badge><span className="cell-sub">Ends {formatDate(device.warrantyExpiry)}</span></td>
          <td className="cell-nowrap"><Badge>{device.amcStatus || 'Not available'}</Badge><span className="cell-sub">Ends {formatDate(device.amcExpiry)}</span></td>
          <td>{device.entitlements?.length ? <div className="chip-list">{device.entitlements.map(item => <span className="chip" key={item}>{item}</span>)}</div> : <span className="text-muted">None</span>}</td>
        </tr>)}</tbody>
      </table>
    </TableCard>
  </>;
}
