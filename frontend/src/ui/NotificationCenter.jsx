import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, CheckCheck, ChevronRight, Laptop, MessageSquareText, ShieldAlert, Star, Ticket, UserCheck } from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, IconButton, PageHeader, Tabs, TableSkeleton } from './primitives';
import { dayGroup, formatRelative, formatDateTime, friendlyError } from './format';
import { notifyNotificationsChanged } from './AppShell';

const typeMeta = {
  NEW_SERVICE_REQUEST: { label: 'Service request', icon: Ticket, tone: 'info' },
  TICKET_UPDATE: { label: 'Ticket update', icon: Ticket, tone: 'info' },
  ENGINEER_ASSIGNED: { label: 'Engineer assignment', icon: UserCheck, tone: 'info' },
  SLA_ESCALATION: { label: 'SLA', icon: ShieldAlert, tone: 'warning' },
  NEW_DEVICE: { label: 'Device enrollment', icon: Laptop, tone: 'success' },
  RATE_SERVICE: { label: 'Review request', icon: Star, tone: 'neutral' },
  NEW_CUSTOMER_REVIEW: { label: 'Customer review', icon: MessageSquareText, tone: 'neutral' },
};

function metaFor(item) {
  const meta = typeMeta[item.type] || { label: String(item.type || 'Update').replaceAll('_', ' ').toLowerCase().replace(/^\w/, char => char.toUpperCase()), icon: Bell, tone: 'neutral' };
  if (item.type === 'SLA_ESCALATION' && /breach/i.test(`${item.title} ${item.message}`)) return { ...meta, label: 'SLA breach', tone: 'critical' };
  if (item.type === 'SLA_ESCALATION') return { ...meta, label: 'SLA warning' };
  return meta;
}

export function NotificationCenter({ load, markRead, markAllRead, resolveRoute, description, pollMs }) {
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  const refresh = ({ silent = false } = {}) => load().then(result => { setItems(result); setError(null); }).catch(loadError => { if (!silent) setError(friendlyError(loadError, 'Unable to load notifications.')); });

  useEffect(() => {
    void refresh();
    if (!pollMs) return undefined;
    const interval = window.setInterval(() => void refresh({ silent: true }), pollMs);
    return () => window.clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const unreadCount = items?.filter(item => !item.read).length || 0;
  const visible = useMemo(() => (items || []).filter(item => filter === 'all' || !item.read), [items, filter]);
  const groups = useMemo(() => ['Today', 'Yesterday', 'Earlier'].map(label => ({ label, items: visible.filter(item => dayGroup(item.createdAt) === label) })).filter(group => group.items.length), [visible]);

  const read = async item => {
    if (item.read) return;
    try {
      await markRead(item._id);
      setItems(current => current.map(entry => entry._id === item._id ? { ...entry, read: true } : entry));
      notifyNotificationsChanged();
    } catch (readError) { setError(friendlyError(readError, 'Unable to update this notification.')); }
  };
  const readAll = async () => {
    try {
      await markAllRead();
      setItems(current => current.map(item => ({ ...item, read: true })));
      notifyNotificationsChanged();
    } catch (readError) { setError(friendlyError(readError, 'Unable to mark notifications as read.')); }
  };
  const open = async item => {
    const route = resolveRoute(item);
    await read(item);
    if (route) navigate(route);
  };

  return <>
    <PageHeader title="Notifications" description={description} actions={<Button icon={CheckCheck} onClick={readAll} disabled={!unreadCount}>Mark all as read</Button>} />
    <Tabs label="Notification filter" value={filter} onChange={setFilter} tabs={[{ value: 'all', label: 'All', count: items?.length ?? undefined }, { value: 'unread', label: 'Unread', count: items ? unreadCount : undefined }]} />
    {error && !items ? <div className="card"><ErrorState title="Unable to load notifications" message={error} onRetry={refresh} /></div>
      : !items ? <div className="card"><TableSkeleton rows={5} columns={3} /></div>
      : !groups.length ? <div className="card"><EmptyState icon={Bell} title={filter === 'unread' ? 'You are all caught up' : 'No notifications yet'} description={filter === 'unread' ? 'There are no unread notifications.' : 'Ticket, SLA, device and review updates will appear here.'} /></div>
      : <div className="stack-24">
        {error && <ErrorState compact title="Something went wrong" message={error} />}
        {groups.map(group => <section className="notification-group" key={group.label} aria-label={group.label}>
          <h2 className="notification-group-label">{group.label}</h2>
          <ul className="notification-list">
            {group.items.map(item => {
              const meta = metaFor(item);
              const Icon = meta.icon;
              const route = resolveRoute(item);
              return <li key={item._id} className={`notification-item ${item.read ? '' : 'unread'}`}>
                <span className={`notification-icon tone-${meta.tone}`} aria-hidden="true"><Icon size={17} /></span>
                <div className="notification-body">
                  <div className="notification-head">
                    <span className="notification-title">{item.title}</span>
                    <Badge tone={meta.tone === 'neutral' ? 'neutral' : meta.tone}>{meta.label}</Badge>
                    {!item.read && <span className="sr-only">Unread</span>}
                  </div>
                  {item.message && <p className="notification-message">{item.message}</p>}
                  <p className="notification-meta">
                    <time dateTime={item.createdAt} title={formatDateTime(item.createdAt)}>{formatRelative(item.createdAt) || 'Recently'}</time>
                    {item.ticket?.ticketId && <><span aria-hidden="true">·</span><span className="mono">{item.ticket.ticketId}</span></>}
                    {item.device?.model && <><span aria-hidden="true">·</span><span>{item.device.model}{item.device.serialNumber ? ` · ${item.device.serialNumber}` : ''}</span></>}
                  </p>
                  {route && <button type="button" className="notification-link btn-link" onClick={() => void open(item)}>{item.ticket?.ticketId ? `Open ${item.ticket.ticketId}` : 'View details'}<ChevronRight size={14} aria-hidden="true" /></button>}
                </div>
                <div className="notification-side">
                  {!item.read && <IconButton label="Mark as read" icon={Check} onClick={() => void read(item)} />}
                  {!item.read && <span className="unread-dot" aria-hidden="true" style={{ marginTop: 14 }} />}
                </div>
              </li>;
            })}
          </ul>
        </section>)}
      </div>}
  </>;
}
