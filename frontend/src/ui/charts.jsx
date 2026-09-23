import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EmptyState } from './primitives';
import { BarChart3 } from 'lucide-react';

const axis = { tickLine: false, axisLine: false, tick: { fill: '#86868b', fontSize: 12 } };

export function ChartTooltip({ active, payload, label, unit = '' }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip">
    <strong>{label ?? payload[0].payload?.name}</strong>
    {payload.map(item => <div key={item.dataKey}>{item.name}: <b>{item.value}{unit}</b></div>)}
  </div>;
}

export function ColumnChart({ data, dataKey = 'value', nameKey = 'name', seriesName = 'Count', height = 240, emptyText = 'No data for this period yet.' }) {
  if (!data?.length || data.every(item => !Number(item[dataKey]))) return <EmptyState compact icon={BarChart3} title={emptyText} />;
  return <div role="img" aria-label={`${seriesName} chart: ${data.map(item => `${item[nameKey]} ${item[dataKey]}`).join(', ')}`}>
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#f0f0f2" />
        <XAxis dataKey={nameKey} {...axis} interval={0} tickFormatter={value => String(value).length > 12 ? `${String(value).slice(0, 11)}…` : value} />
        <YAxis {...axis} allowDecimals={false} />
        <Tooltip cursor={{ fill: 'rgba(0,0,0,0.03)' }} content={<ChartTooltip />} />
        <Bar dataKey={dataKey} name={seriesName} fill="#0071e3" radius={[6, 6, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  </div>;
}

// Horizontal bars for categorical distributions; easier to read than pies.
export function BarList({ data, emptyText = 'No data yet.', tone = '#0071e3', limit }) {
  const rows = [...(data || [])].filter(item => Number(item.value) > 0).sort((a, b) => b.value - a.value).slice(0, limit || undefined);
  if (!rows.length) return <EmptyState compact icon={BarChart3} title={emptyText} />;
  const max = Math.max(...rows.map(item => Number(item.value)));
  const total = rows.reduce((sum, item) => sum + Number(item.value), 0);
  return <ul className="bar-list">
    {rows.map(item => <li className="bar-row" key={item.name}>
      <span className="bar-row-label" title={item.name}>{item.name || 'Other'}</span>
      <span className="bar-track" role="presentation"><span className="bar-fill" style={{ width: `${(Number(item.value) / max) * 100}%`, background: tone }} /></span>
      <span className="bar-value" aria-label={`${item.value} of ${total}`}>{item.value}</span>
    </li>)}
  </ul>;
}
