import { useEffect, useState } from 'react';
import { Bell, Check, CheckCheck, UserRound } from 'lucide-react';
import { Shell, PageTitle, Badge, Empty } from './components';
import { ModalLayer } from './ModalLayer';
import { assignDeviceToEmployee, getDevices, getNotifications, markAllNotificationsRead, markNotificationRead } from './api';
import { Link } from 'react-router-dom';

const employeeKey = employee => `${employee.employeeName} (${employee.employeeId})`;

export function UnassignedDevices() {
  const [devices, setDevices] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [selected, setSelected] = useState(null);
  const [employee, setEmployee] = useState('');

  const load = async () => {
    const items = await getDevices();
    const people = [...new Map(items.filter(item => item.employeeName && item.employeeId).map(item => [item.employeeId, item])).values()];
    setEmployees(people);
    setDevices(items.filter(item => item.deviceAllocationStatus === 'Unassigned'));
  };
  useEffect(() => { void load(); }, []);
  const selectEmployee = value => {
    setEmployee(value);
  };
  const submit = async event => {
    event.preventDefault();
    const person = employees.find(item => employeeKey(item) === employee);
    if (!person || !selected) return;
    await assignDeviceToEmployee(selected._id, { employeeName: person.employeeName, employeeId: person.employeeId, department: person.department, location: person.location });
    setSelected(null);
    setEmployee('');
    await load();
  };
  return <Shell title="Unassigned devices"><PageTitle title="Unassigned Devices" description="Devices registered to your company and ready for employee assignment" /><section className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>Device</th><th>Serial</th><th>Asset ID</th><th>Warranty</th><th>AMC</th><th>Status</th><th></th></tr></thead><tbody>{devices.map(device => <tr key={device._id}><td><strong>{device.model}</strong><small>{device.deviceType}</small></td><td>{device.serialNumber}</td><td>{device.assetId}</td><td><Badge>{device.warrantyStatus}</Badge></td><td><Badge>{device.amcStatus}</Badge></td><td><Badge>Unassigned</Badge></td><td><button className="button primary" onClick={() => setSelected(device)}><UserRound size={15} />Assign</button></td></tr>)}</tbody></table>{!devices.length && <Empty message="All company devices are assigned." />}</div></section>{selected && <ModalLayer><form className="modal panel" onSubmit={submit}><div className="panel-heading"><div><span className="kicker">Employee assignment</span><h3>{selected.model}</h3></div><button type="button" className="modal-close" onClick={() => setSelected(null)}>×</button></div><label>Employee<input required list="company-employees" value={employee} onChange={event => selectEmployee(event.target.value)} placeholder="Search by employee name or ID" /><datalist id="company-employees">{employees.map(person => <option key={person.employeeId} value={employeeKey(person)} />)}</datalist></label><button className="button primary" disabled={!employees.some(person => employeeKey(person) === employee)}>Assign Device</button></form></ModalLayer>}</Shell>;
}

export function Notifications() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');

  const load = () => getNotifications().then(setItems).catch(err => setError(err.message));

  useEffect(() => { void load(); }, []);

  const read = async item => {
    if (!item.read) {
      await markNotificationRead(item._id);
      setItems(current => current.map(entry => entry._id === item._id ? { ...entry, read: true } : entry));
    }
  };

  const readAll = async () => {
    await markAllNotificationsRead();
    setItems(current => current.map(item => ({ ...item, read: true })));
  };

  return <Shell title="Notifications"><PageTitle title="Notifications" description="Updates from the iPlanet Service team" action={<button className="button secondary" onClick={readAll}><CheckCheck size={15} />Mark all read</button>} />{error && <p className="form-error">{error}</p>}<section className="notification-list">{items.map(item => <article className={`panel notification-item ${item.read ? '' : 'unread'}`} key={item._id}><div className="notification-icon"><Bell size={18} /></div><div><span className="kicker">{item.type}</span><h3>{item.title}</h3><p>{item.message}</p><small>{item.device?.model} · {item.device?.serialNumber}</small>{item.ticket && <Link className="text-link" to={`/tickets/${item.ticket._id}`} onClick={() => read(item)}>Open {item.ticket.ticketId}</Link>}</div>{!item.read && <button className="icon-button" title="Mark as read" onClick={() => read(item)}><Check size={17} /></button>}</article>)}{!items.length && !error && <Empty message="No notifications yet." />}</section></Shell>;
}
