import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { Badge, Empty, PageTitle, Shell } from './components';
import { assignDeviceToEmployee, getDevices } from './api';

const employeeKey = employee => `${employee.employeeName} (${employee.employeeId})`;

export function UnassignedDevices() {
  const [devices, setDevices] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [selected, setSelected] = useState(null);
  const [employee, setEmployee] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const items = await getDevices();
      setEmployees([...new Map(items.filter(item => item.employeeName && item.employeeId).map(item => [item.employeeId, item])).values()]);
      setDevices(items.filter(item => item.deviceAllocationStatus === 'Unassigned'));
    } catch (err) { setError(err.message || 'Unable to load company devices.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const submit = async event => {
    event.preventDefault();
    const person = employees.find(item => employeeKey(item) === employee);
    if (!selected || !person) return;
    setSaving(true);
    setError('');
    try {
      await assignDeviceToEmployee(selected._id, { employeeName: person.employeeName, employeeId: person.employeeId, department: person.department, location: person.location });
      setSelected(null);
      setEmployee('');
      await load();
    } catch (err) { setError(err.message || 'Unable to assign this device.'); }
    finally { setSaving(false); }
  };

  return <Shell title="Unassigned devices"><PageTitle title="Unassigned Devices" description="Devices registered to your company and ready for employee assignment" />{error && <p className="form-error" style={{ margin: '0 4.5% 18px' }}>{error}</p>}<section className="panel table-panel">{loading ? <div className="loading">Loading unassigned devices...</div> : <div className="table-wrap"><table><thead><tr><th>Device</th><th>Serial</th><th>Asset ID</th><th>Warranty</th><th>AMC</th><th>Location</th><th></th></tr></thead><tbody>{devices.map(device => <tr key={device._id}><td><strong>{device.model}</strong><small>{device.deviceType}</small></td><td>{device.serialNumber}</td><td>{device.assetId}</td><td><Badge>{device.warrantyStatus}</Badge></td><td><Badge>{device.amcStatus}</Badge></td><td>{device.location}</td><td><button className="button primary" onClick={() => setSelected(device)}><UserRound size={15} />Assign</button></td></tr>)}</tbody></table>{!devices.length && <Empty message="All company devices are assigned." />}</div>}</section>{selected && <section className="panel" style={{ margin: '0 4.5% 40px' }}><div className="panel-heading"><div><span className="kicker">Employee assignment</span><h3>{selected.model}</h3></div><button className="link-button" onClick={() => setSelected(null)}>Cancel</button></div><form className="request-form" onSubmit={submit}><label>Employee<input required list="company-employees" value={employee} onChange={event => setEmployee(event.target.value)} placeholder="Search by employee name or ID" /><datalist id="company-employees">{employees.map(person => <option key={person.employeeId} value={employeeKey(person)} />)}</datalist></label><button className="button primary" disabled={saving || !employees.some(person => employeeKey(person) === employee)}>{saving ? 'Assigning…' : 'Assign Device'}</button></form></section>}</Shell>;
}
