import { useState } from 'react';
import { Edit3, Plus, Siren } from 'lucide-react';
import { ServiceShell } from './components';
import { createEscalationRule, getEscalationMatrix, getEscalationRules, getServiceNotifications, markAllServiceNotificationsRead, markServiceNotificationRead, updateEscalationRule } from './api';
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, InlineAlert, Modal, NotificationCenter, PageHeader, PageSkeleton, SectionHeader, friendlyError, useAsync } from '../ui';

function serviceRoute(item) {
  if (item.action?.route) return item.action.route;
  if (item.reviewId) return `/service/reviews/${item.reviewId}`;
  if (item.ticket?._id) return `/service/tickets/${item.ticket._id}`;
  return null;
}

export function ServiceNotifications() {
  return <ServiceShell title="Notifications">
    <NotificationCenter load={getServiceNotifications} markRead={markServiceNotificationRead} markAllRead={markAllServiceNotificationsRead} resolveRoute={serviceRoute} pollMs={10000} description="Operational updates across the iPlanet service desk." />
  </ServiceShell>;
}

const levelNames = { 1: 'Service Coordinator', 2: 'Service Manager', 3: 'Regional Operations Manager' };
const triggers = ['SLA Approaching', 'SLA At Risk', 'SLA Breached', 'Critical SLA Breach', 'High Priority SLA Breach'];

function LevelPill({ level }) {
  return <span className={`level-pill level-${level}`}>Level {String(level).padStart(2, '0')}</span>;
}

function RuleForm({ rule, onClose, onSaved }) {
  const [form, setForm] = useState(rule || { name: '', level: 1, trigger: 'SLA Approaching', priority: 'All', slaThreshold: 80, action: '', isActive: true });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const update = event => setForm({ ...form, [event.target.name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value });
  const submit = async event => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try { onSaved(rule ? await updateEscalationRule(rule._id, form) : await createEscalationRule(form)); }
    catch (saveError) { setError(friendlyError(saveError, 'Unable to save this rule.')); setSaving(false); }
  };
  return <Modal as="form" onSubmit={submit} onClose={onClose} eyebrow="Escalation rule" title={rule ? 'Edit escalation rule' : 'New escalation rule'} description="Rules decide when an active ticket is escalated and to whom."
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save rule'}</Button></>}>
    <div className="form-grid">
      <Field className="span-2" label="Rule name" required>{props => <input {...props} name="name" required value={form.name} onChange={update} placeholder="e.g. Critical tickets at 50% SLA" />}</Field>
      <Field label="Escalate to">{props => <select {...props} name="level" value={form.level} onChange={update}>{[1, 2, 3].map(level => <option key={level} value={level}>Level {String(level).padStart(2, '0')} · {levelNames[level]}</option>)}</select>}</Field>
      <Field label="Trigger">{props => <select {...props} name="trigger" value={form.trigger} onChange={update}>{triggers.map(item => <option key={item}>{item}</option>)}</select>}</Field>
      <Field label="Applies to priority">{props => <select {...props} name="priority" value={form.priority} onChange={update}>{['All', 'Low', 'Medium', 'High', 'Critical'].map(item => <option key={item}>{item}</option>)}</select>}</Field>
      <Field label="SLA threshold (%)" required hint="Percentage of the resolution target elapsed.">{props => <input {...props} name="slaThreshold" type="number" min="0" max="100" required value={form.slaThreshold} onChange={update} />}</Field>
      <Field className="span-2" label="Action" required hint="What happens when the rule fires.">{props => <input {...props} name="action" required value={form.action} onChange={update} placeholder="e.g. Notify service manager and reassign" />}</Field>
      <label className="checkbox span-2"><input name="isActive" type="checkbox" checked={form.isActive} onChange={update} />Rule is active</label>
    </div>
    {error && <InlineAlert title={error} />}
  </Modal>;
}

export function EscalationMatrix() {
  const state = useAsync(() => Promise.all([getEscalationMatrix(), getEscalationRules()]).then(([levels, rules]) => ({ levels, rules })), []);
  const [editing, setEditing] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(null);
  const [toggling, setToggling] = useState('');
  const [error, setError] = useState('');

  const saved = rule => {
    state.setData(current => ({ ...current, rules: current.rules.some(item => item._id === rule._id) ? current.rules.map(item => item._id === rule._id ? rule : item) : [...current.rules, rule] }));
    setEditing(null);
  };
  const toggle = async rule => {
    setToggling(rule._id);
    setError('');
    try {
      const updated = await updateEscalationRule(rule._id, { isActive: !rule.isActive });
      state.setData(current => ({ ...current, rules: current.rules.map(item => item._id === updated._id ? updated : item) }));
      setConfirmDisable(null);
    } catch (toggleError) { setError(friendlyError(toggleError, 'Unable to update this rule.')); }
    finally { setToggling(''); }
  };

  if (state.loading && !state.data) return <ServiceShell title="Escalation Matrix"><PageSkeleton kpis={0} /></ServiceShell>;
  if (state.error) return <ServiceShell title="Escalation Matrix"><PageHeader title="Escalation Matrix" /><div className="card"><ErrorState title="Unable to load the escalation matrix" message={friendlyError(state.error)} onRetry={state.reload} /></div></ServiceShell>;
  const { levels, rules } = state.data;
  const contactFor = level => levels.find(item => Number(item.level) === Number(level));
  const sortedRules = [...rules].sort((a, b) => a.level - b.level || a.slaThreshold - b.slaThreshold);

  return <ServiceShell title="Escalation Matrix">
    <PageHeader title="Escalation Matrix" description="When active tickets escalate, and who is notified at each level." actions={<Button variant="primary" icon={Plus} onClick={() => setEditing({})}>Add rule</Button>} />
    {error && <InlineAlert title={error} action={<Button size="sm" variant="ghost" onClick={() => setError('')}>Dismiss</Button>} />}

    <section className="page-section" aria-labelledby="escalation-rules">
      <SectionHeader id="escalation-rules" title="Escalation rules" description={`${rules.filter(rule => rule.isActive).length} of ${rules.length} active · evaluated against every active ticket's SLA`} />
      <div className="card card-flush">
        {sortedRules.length ? <div className="table-scroll"><table className="table">
          <thead><tr><th>Level</th><th>Trigger</th><th>Response target</th><th>Escalation to</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{sortedRules.map(rule => { const contact = contactFor(rule.level); return <tr key={rule._id}>
            <td><LevelPill level={rule.level} /></td>
            <td><span className="cell-primary">{rule.trigger}</span><span className="cell-sub">{rule.name}{rule.priority && rule.priority !== 'All' ? ` · ${rule.priority} priority` : ' · All priorities'}</span></td>
            <td className="cell-nowrap"><span className="cell-num">{rule.slaThreshold}%</span> of SLA elapsed{rule.action && <span className="cell-sub" style={{ whiteSpace: 'normal', maxWidth: 260 }}>{rule.action}</span>}</td>
            <td>{contact ? <div className="contact-cell"><strong style={{ fontWeight: 500 }}>{contact.name}</strong><span>{contact.contactName}{contact.email ? ` · ${contact.email}` : ''}</span></div> : levelNames[rule.level]}</td>
            <td><span className="row" style={{ flexWrap: 'nowrap' }}><button type="button" role="switch" className="toggle" aria-checked={rule.isActive} aria-label={`${rule.isActive ? 'Disable' : 'Enable'} ${rule.name}`} disabled={toggling === rule._id} onClick={() => rule.isActive ? setConfirmDisable(rule) : toggle(rule)} /><span className="text-small">{rule.isActive ? 'Active' : 'Off'}</span></span></td>
            <td className="cell-right"><Button size="sm" variant="ghost" icon={Edit3} onClick={() => setEditing(rule)} aria-label={`Edit ${rule.name}`}>Edit</Button></td>
          </tr>; })}</tbody>
        </table></div> : <EmptyState icon={Siren} title="No escalation rules configured" description="Add a rule to escalate tickets automatically as they approach their SLA." action={<Button variant="primary" size="sm" icon={Plus} onClick={() => setEditing({})}>Add rule</Button>} />}
      </div>
    </section>

    <section className="page-section" aria-labelledby="escalation-contacts">
      <SectionHeader id="escalation-contacts" title="Escalation contacts" description="Notified when a ticket reaches each level" />
      <div className="card card-flush">
        {levels.length ? <ul className="attention-list">{levels.map(level => <li key={level.level} className="attention-item">
          <LevelPill level={level.level} />
          <span className="attention-text"><strong>{level.name}</strong><span>{level.contactName}{level.email ? ` · ${level.email}` : ''}</span></span>
          <span className="text-small text-muted">{level.trigger}</span>
        </li>)}</ul> : <EmptyState compact icon={Siren} title="No escalation contacts configured" />}
      </div>
    </section>

    {editing && <RuleForm rule={editing._id ? editing : null} onClose={() => setEditing(null)} onSaved={saved} />}
    {confirmDisable && <ConfirmDialog title={`Turn off "${confirmDisable.name}"?`} description="Tickets won't be escalated by this rule until it's turned on again." confirmLabel="Turn off" tone="danger" busy={toggling === confirmDisable._id} onConfirm={() => toggle(confirmDisable)} onClose={() => setConfirmDisable(null)}>
      <p className="text-muted text-small">Level {confirmDisable.level} · {confirmDisable.trigger} · {confirmDisable.slaThreshold}% of SLA</p>
    </ConfirmDialog>}
  </ServiceShell>;
}
