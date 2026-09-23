import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, UserRoundCheck, UserRoundPlus } from 'lucide-react';
import { Shell } from './components';
import { assignDeviceToEmployee, getDevices, getNotifications, markAllNotificationsRead, markNotificationRead } from './api';
import { Badge, Button, DeviceIcon, EmptyState, Field, FilterBar, InlineAlert, Modal, NotificationCenter, PageHeader, SearchInput, TableCard, formatDate, friendlyError, useAsync } from '../ui';

const employeeKey = employee => `${employee.employeeName} (${employee.employeeId})`;

async function loadInventory() {
  const items = await getDevices();
  const employees = [...new Map(items.filter(item => item.employeeName && item.employeeId).map(item => [item.employeeId, item])).values()];
  return { employees, devices: items.filter(item => item.deviceAllocationStatus === 'Unassigned') };
}

function AssignDeviceModal({ device, employees, onClose, onAssigned }) {
  const [employee, setEmployee] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const person = employees.find(item => employeeKey(item) === employee);
  const submit = async event => {
    event.preventDefault();
    if (!person) { setError('Select an employee from the list.'); return; }
    setSaving(true);
    setError('');
    try {
      await assignDeviceToEmployee(device._id, { employeeName: person.employeeName, employeeId: person.employeeId, department: person.department, location: person.location });
      onAssigned(person);
    } catch (assignError) {
      setError(friendlyError(assignError, 'Unable to assign this device.'));
      setSaving(false);
    }
  };
  return <Modal as="form" onSubmit={submit} onClose={onClose} eyebrow="Employee assignment" title={`Assign ${device.model}`} description={`Serial ${device.serialNumber}`}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" icon={UserRoundCheck} disabled={saving || !person}>{saving ? 'Assigning…' : 'Assign device'}</Button></>}>
    <Field label="Employee" required hint="Search by employee name or ID. Employees come from your existing device records." error={employee && !person ? 'Choose an employee from the suggestions.' : undefined}>
      {props => <><input {...props} required list="company-employees" value={employee} onChange={event => setEmployee(event.target.value)} placeholder="e.g. Priya Sharma (EMP-102)" autoComplete="off" />
        <datalist id="company-employees">{employees.map(item => <option key={item.employeeId} value={employeeKey(item)} />)}</datalist></>}
    </Field>
    {person && <div className="device-card"><div className="device-card-body"><strong>{person.employeeName}</strong><span>{[person.employeeId, person.department, person.location].filter(Boolean).join(' · ')}</span></div></div>}
    {!employees.length && <InlineAlert tone="warning" title="No employees on record">Employees appear here once at least one device is assigned to them.</InlineAlert>}
    {error && <InlineAlert title={error} />}
  </Modal>;
}

export function UnassignedDevices() {
  const state = useAsync(loadInventory, []);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [assigned, setAssigned] = useState(null);
  const devices = (state.data?.devices || []).filter(device => JSON.stringify(device).toLowerCase().includes(search.toLowerCase()));
  return <Shell title="Unassigned Devices">
    <PageHeader title="Unassigned Devices" description="Devices registered to your organization that are ready to be assigned to an employee." />
    {assigned && <InlineAlert tone="success" title={`${assigned.model} assigned to ${assigned.employee}`} action={<Button size="sm" variant="ghost" onClick={() => setAssigned(null)}>Dismiss</Button>} />}
    <TableCard
      columns={7}
      loading={state.loading && !state.data}
      error={state.error && friendlyError(state.error)}
      errorTitle="Unable to load unassigned devices"
      onRetry={state.reload}
      toolbar={<FilterBar summary={state.data ? `${devices.length} unassigned` : null}><SearchInput value={search} onChange={setSearch} placeholder="Search model, serial or asset ID" label="Search unassigned devices" /></FilterBar>}
      isEmpty={!devices.length}
      empty={<EmptyState icon={CheckCircle2} title={search ? 'No devices match your search' : 'All devices are assigned'} description={search ? 'Try a different search term.' : 'Newly enrolled devices will appear here for assignment.'} action={!search && <Button size="sm" to="/corporate/devices">View all devices</Button>} />}
    >
      <table className="table">
        <thead><tr><th>Device</th><th>Serial</th><th>Asset ID</th><th>Warranty</th><th>AMC</th><th>Status</th><th><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{devices.map(device => <tr key={device._id}>
          <td><div className="person-cell"><span className="asset-icon" style={{ width: 32, height: 32, borderRadius: 8 }}><DeviceIcon type={device.deviceType} model={device.model} size={16} /></span><div><Link className="cell-link" to={`/corporate/devices/${device._id}`}>{device.model}</Link><span className="cell-sub">{device.deviceType}</span></div></div></td>
          <td className="mono cell-nowrap">{device.serialNumber}</td>
          <td>{device.assetId || '—'}</td>
          <td className="cell-nowrap"><Badge>{device.warrantyStatus}</Badge><span className="cell-sub">{device.warrantyExpiry ? `Ends ${formatDate(device.warrantyExpiry)}` : ''}</span></td>
          <td className="cell-nowrap"><Badge>{device.amcStatus}</Badge><span className="cell-sub">{device.amcExpiry ? `Ends ${formatDate(device.amcExpiry)}` : ''}</span></td>
          <td><Badge dot>Unassigned</Badge></td>
          <td className="cell-right"><Button size="sm" variant="primary" icon={UserRoundPlus} onClick={() => setSelected(device)}>Assign</Button></td>
        </tr>)}</tbody>
      </table>
    </TableCard>
    {selected && <AssignDeviceModal device={selected} employees={state.data.employees} onClose={() => setSelected(null)} onAssigned={person => { setAssigned({ model: selected.model, employee: person.employeeName }); setSelected(null); void state.reload({ silent: true }); }} />}
  </Shell>;
}

function corporateRoute(item) {
  if (item.action?.route) return item.action.route;
  if (item.ticket?._id) return `/corporate/service-requests/${item.ticket._id}`;
  if (item.type === 'NEW_DEVICE') return '/corporate/unassigned-devices';
  if (item.device?._id) return `/corporate/devices/${item.device._id}`;
  return null;
}

export function Notifications() {
  return <Shell title="Notifications">
    <NotificationCenter load={getNotifications} markRead={markNotificationRead} markAllRead={markAllNotificationsRead} resolveRoute={corporateRoute} description="Updates on your devices, service requests and coverage from iPlanet Service." />
  </Shell>;
}
