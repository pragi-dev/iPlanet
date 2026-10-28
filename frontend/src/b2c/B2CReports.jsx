import { useState } from 'react';
import { Card, ErrorState, FilterSelect, KPI, KPIGrid, PageHeader, PageSkeleton, friendlyError, useAsync } from '../ui';
import { BarList, ColumnChart } from '../ui/charts';
import { getB2CReports } from './api';
import { B2CShell, NoB2CAccess, hoursLabel } from './shared';

// Reports cover the escalations the signed-in user can see. No SLA targets
// are shown because TCM has not defined any; ageing and resolution time are
// reported as measured.
function ResolutionTable({ rows }) {
  if (!rows?.length) return <p className="text-muted text-small">No resolved escalations in this period.</p>;
  return <div className="table-scroll"><table className="table table-compact">
    <thead><tr><th>Group</th><th>Resolved</th><th>Average</th><th>Median</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.name}><td>{row.name}</td><td>{row.count}</td><td>{hoursLabel(row.averageHours)}</td><td>{hoursLabel(row.medianHours)}</td></tr>)}</tbody>
  </table></div>;
}

export function B2CReports() {
  const [filters, setFilters] = useState({ from: '', to: '', category: 'All', region: 'All' });
  const state = useAsync(() => getB2CReports(filters), [JSON.stringify(filters)]);
  const regions = useAsync(() => getB2CReports({}).then(result => result.byRegion.map(item => item.name).filter(name => name !== 'Not set')), []);
  const set = (key, value) => setFilters(current => ({ ...current, [key]: value }));
  const controls = <div className="row">
    <label className="filter-select"><span className="sr-only">From</span><input type="date" aria-label="Received from" value={filters.from} onChange={event => set('from', event.target.value)} /></label>
    <label className="filter-select"><span className="sr-only">To</span><input type="date" aria-label="Received to" value={filters.to} onChange={event => set('to', event.target.value)} /></label>
    <FilterSelect label="Category" value={filters.category} onChange={value => set('category', value)} options={['Service', 'Retail', 'Unclassified']} allLabel="All categories" />
    <FilterSelect label="Region" value={filters.region} onChange={value => set('region', value)} options={regions.data || []} allLabel="All regions" />
  </div>;

  if (state.error?.status === 403) return <B2CShell title="B2C reports"><PageHeader title="B2C reports" /><NoB2CAccess /></B2CShell>;
  if (state.loading && !state.data) return <B2CShell title="B2C reports"><PageSkeleton kpis={4} /></B2CShell>;
  if (state.error) return <B2CShell title="B2C reports"><PageHeader title="B2C reports" /><div className="card"><ErrorState title="Unable to load reports" message={friendlyError(state.error)} onRetry={state.reload} /></div></B2CShell>;
  const report = state.data;
  const monthly = report.monthly.map(item => ({ month: item.month, total: item.Service + item.Retail + item.Unclassified }));

  return <B2CShell title="B2C reports">
    <PageHeader title="B2C reports" description="Escalations by region, category, status and age, and how long resolution takes." actions={controls} />
    <KPIGrid columns={4}>
      <KPI label="Escalations" value={report.total} hint="Received in the selected period" />
      <KPI label="Active" value={report.active} hint="Not yet resolved" />
      <KPI label="Resolved" value={report.resolution.overall.count} />
      <KPI label="Median resolution time" value={hoursLabel(report.resolution.overall.medianHours)} hint={report.resolution.overall.averageHours !== null ? `Average ${hoursLabel(report.resolution.overall.averageHours)}` : 'Received → resolved'} />
    </KPIGrid>
    <div className="grid-main-side">
      <Card title="Escalations received" description="Per month, last 12 months"><ColumnChart data={monthly} dataKey="total" nameKey="month" seriesName="Escalations" emptyText="No escalations in this period." /></Card>
      <Card title="By status"><BarList data={report.byStatus} emptyText="No escalations in this period." /></Card>
    </div>
    <div className="grid-3">
      <Card title="By region"><BarList data={report.byRegion} emptyText="No escalations in this period." /></Card>
      <Card title="Service or Retail"><BarList data={report.byCategory} emptyText="No escalations in this period." /></Card>
      <Card title="Active by workflow level"><BarList data={report.byLevel} emptyText="No escalations in the workflow." /></Card>
    </div>
    <div className="grid-main-side">
      <Card title="Ageing of active escalations" description="Time since the customer's first email"><ColumnChart data={report.ageing} seriesName="Active escalations" emptyText="No active escalations." /></Card>
      <Card title="Resolution time by category"><ResolutionTable rows={report.resolution.byCategory} /></Card>
    </div>
    <Card title="Resolution time by region"><ResolutionTable rows={report.resolution.byRegion} /></Card>
  </B2CShell>;
}
