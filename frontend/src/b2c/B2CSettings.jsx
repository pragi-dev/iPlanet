import { useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { Badge, Button, Card, ErrorState, Field, InlineAlert, PageHeader, PageSkeleton, formatDateTime, friendlyError, useAsync } from '../ui';
import { getB2CSettings, saveB2CSettings } from './api';
import { B2CShell, IDENTIFIER_LABELS, NoB2CAccess } from './shared';

// B2C administrators maintain the rules TCM confirms here. Nothing on this
// page is a TCM-approved default: rules show whether they are confirmed and
// templates whether their wording is approved.
const PLACEHOLDERS = '{{reference}} (or {{ticketNumber}}), {{customerName}}, {{subject}}, {{issueSummary}}, {{category}}, {{message}}, {{companyName}}, {{serialNumber}} (a line using it is left out when no verified serial number is known), and in the registration request only {{registrationLink}} and {{linkExpiry}}';

function useSection(initial, key, onSaved) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState({ busy: false, error: '', saved: false });
  const save = async () => {
    setStatus({ busy: true, error: '', saved: false });
    try { const settings = await saveB2CSettings({ [key]: value }); onSaved(settings); setValue(settings[key]); setStatus({ busy: false, error: '', saved: true }); }
    catch (error) { setStatus({ busy: false, error: friendlyError(error, 'Unable to save.'), saved: false }); }
  };
  return { value, setValue, status, save };
}

function SaveBar({ section, label }) {
  return <div className="b2c-save-bar">
    {section.status.error && <InlineAlert title={section.status.error} />}
    {section.status.saved && <InlineAlert tone="success" title={`${label} saved.`} />}
    <div><Button variant="primary" icon={Save} disabled={section.status.busy} onClick={section.save}>{section.status.busy ? 'Saving…' : `Save ${label.toLowerCase()}`}</Button></div>
  </div>;
}

const update = (list, index, changes) => list.map((item, other) => (other === index ? { ...item, ...changes } : item));

export function B2CSettings() {
  const state = useAsync(getB2CSettings, []);
  if (state.error?.status === 403) return <B2CShell title="B2C settings"><PageHeader title="B2C settings" /><NoB2CAccess /></B2CShell>;
  if (state.loading && !state.data) return <B2CShell title="B2C settings"><PageSkeleton kpis={0} variant="detail" /></B2CShell>;
  if (state.error) return <B2CShell title="B2C settings"><PageHeader title="B2C settings" /><div className="card"><ErrorState title="Unable to load settings" message={friendlyError(state.error)} onRetry={state.reload} /></div></B2CShell>;
  return <SettingsForm settings={state.data} onSaved={state.setData} />;
}

function SettingsForm({ settings, onSaved }) {
  const inboxes = useSection(settings.inboxes, 'inboxes', onSaved);
  const rules = useSection(settings.identifierRules, 'identifierRules', onSaved);
  const keywords = useSection(settings.classificationRules, 'classificationRules', onSaved);
  const levels = useSection(settings.workflowLevels, 'workflowLevels', onSaved);
  const validation = useSection(settings.validation, 'validation', onSaved);
  const templates = useSection(settings.templates, 'templates', onSaved);
  const orderedLevels = [...levels.value].sort((a, b) => a.order - b.order);
  const unconfirmed = settings.identifierRules.filter(rule => rule.enabled && !rule.confirmed).length;
  const unapproved = settings.templates.filter(template => !template.approved).length;

  return <B2CShell title="B2C settings">
    <PageHeader title="B2C settings" description={`Inboxes, identifier and classification rules, the escalation workflow and customer email wording.${settings.updatedBy ? ` Last changed by ${settings.updatedBy} · ${formatDateTime(settings.updatedAt)}.` : ''}`} />
    {(unconfirmed > 0 || unapproved > 0) && <InlineAlert tone="warning" title="Some rules are still placeholders">{[unconfirmed && `${unconfirmed} identifier rule${unconfirmed === 1 ? ' is' : 's are'} not confirmed by TCM`, unapproved && `${unapproved} customer email template${unapproved === 1 ? ' is' : 's are'} not approved, so ${unapproved === 1 ? 'that email is' : 'those emails are'} held instead of sent`].filter(Boolean).join('; ')}.</InlineAlert>}

    <Card title="Inboxes" description="TCM support mailboxes to poll. Start with one test inbox and add the four TCM inboxes once confirmed. Credentials are set on the server, never here.">
      <div className="stack-16">
        {inboxes.value.map((inbox, index) => <div className="b2c-settings-row" key={index}>
          <Field label="Key">{props => <input {...props} value={inbox.key} onChange={event => inboxes.setValue(update(inboxes.value, index, { key: event.target.value }))} />}</Field>
          <Field label="Mailbox address">{props => <input {...props} type="email" value={inbox.address} onChange={event => inboxes.setValue(update(inboxes.value, index, { address: event.target.value }))} />}</Field>
          <Field label="Name">{props => <input {...props} value={inbox.displayName} onChange={event => inboxes.setValue(update(inboxes.value, index, { displayName: event.target.value }))} />}</Field>
          <Field label="Provider">{props => <select {...props} value={inbox.provider} onChange={event => inboxes.setValue(update(inboxes.value, index, { provider: event.target.value }))}><option value="test">Test adapter</option><option value="microsoft_graph">Microsoft 365 (Graph)</option><option value="imap">IMAP mailbox (e.g. MilesWeb) — receive only</option></select>}</Field>
          <Field label="Category for this inbox" hint="Only if TCM confirms the inbox handles one category.">{props => <select {...props} value={inbox.defaultCategory || ''} onChange={event => inboxes.setValue(update(inboxes.value, index, { defaultCategory: event.target.value || null }))}><option value="">Use keyword rules</option><option>Service</option><option>Retail</option></select>}</Field>
          <label className="row text-small"><input type="checkbox" checked={inbox.enabled} onChange={event => inboxes.setValue(update(inboxes.value, index, { enabled: event.target.checked }))} />Poll this inbox</label>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => inboxes.setValue(inboxes.value.filter((_, other) => other !== index))}>Remove</Button>
        </div>)}
        <div><Button size="sm" icon={Plus} disabled={inboxes.value.length >= 10} onClick={() => inboxes.setValue([...inboxes.value, { key: '', address: '', displayName: '', provider: 'microsoft_graph', defaultCategory: null, defaultRegion: '', enabled: false }])}>Add inbox</Button></div>
        <SaveBar section={inboxes} label="Inboxes" />
      </div>
    </Card>

    <Card title="Identifier rules" description="Regular expressions that find case IDs, serial numbers and other identifiers in the subject and body. The first capture group is the value.">
      <div className="stack-16">
        {rules.value.map((rule, index) => <div className="b2c-settings-row" key={index}>
          <Field label="Key">{props => <input {...props} value={rule.key} onChange={event => rules.setValue(update(rules.value, index, { key: event.target.value }))} />}</Field>
          <Field label="Type">{props => <select {...props} value={rule.type} onChange={event => rules.setValue(update(rules.value, index, { type: event.target.value }))}>{Object.entries(IDENTIFIER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</Field>
          <Field label="Description" className="b2c-wide">{props => <input {...props} value={rule.label} onChange={event => rules.setValue(update(rules.value, index, { label: event.target.value }))} />}</Field>
          <Field label="Pattern" className="b2c-wide">{props => <input {...props} className="mono" value={rule.pattern} onChange={event => rules.setValue(update(rules.value, index, { pattern: event.target.value }))} />}</Field>
          <Field label="Flags" hint="i = ignore case">{props => <input {...props} value={rule.flags} onChange={event => rules.setValue(update(rules.value, index, { flags: event.target.value }))} maxLength={4} />}</Field>
          <label className="row text-small"><input type="checkbox" checked={rule.enabled} onChange={event => rules.setValue(update(rules.value, index, { enabled: event.target.checked }))} />Enabled</label>
          <label className="row text-small"><input type="checkbox" checked={rule.confirmed} onChange={event => rules.setValue(update(rules.value, index, { confirmed: event.target.checked }))} />Confirmed by TCM</label>
          {!rule.confirmed && <Badge tone="warning">Not confirmed</Badge>}
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => rules.setValue(rules.value.filter((_, other) => other !== index))}>Remove</Button>
        </div>)}
        <div><Button size="sm" icon={Plus} onClick={() => rules.setValue([...rules.value, { key: `rule-${rules.value.length + 1}`, type: 'caseId', label: '', pattern: '', flags: 'i', enabled: true, confirmed: false }])}>Add rule</Button></div>
        <SaveBar section={rules} label="Identifier rules" />
      </div>
    </Card>

    <Card title="Service / Retail keywords" description="Used for inboxes without a fixed category. Whole words, not case sensitive. An email matching both lists, or neither, goes to triage instead of being guessed.">
      <div className="stack-16">
        <div className="grid-2">{keywords.value.map((rule, index) => <Field key={rule.category} label={`${rule.category} keywords`} hint="One per line">{props => <textarea {...props} rows={6} value={rule.keywords.join('\n')} onChange={event => keywords.setValue(update(keywords.value, index, { keywords: event.target.value.split('\n') }))} />}</Field>)}</div>
        <SaveBar section={keywords} label="Keywords" />
      </div>
    </Card>

    <Card title="Workflow levels" description="The escalation hierarchy. Level keys are the roles held by staff accounts and cannot be renamed here; new escalations pass through every enabled level, in order.">
      <div className="stack-16">
        {orderedLevels.map(level => { const index = levels.value.indexOf(level); return <div className="b2c-settings-row" key={level.key}>
          <Field label="Order">{props => <input {...props} type="number" min={1} max={20} value={level.order} onChange={event => levels.setValue(update(levels.value, index, { order: Number(event.target.value) }))} />}</Field>
          <Field label="Name" className="b2c-wide">{props => <input {...props} value={level.label} onChange={event => levels.setValue(update(levels.value, index, { label: event.target.value }))} />}</Field>
          <span className="text-muted text-small mono">{level.key}</span>
          <label className="row text-small"><input type="checkbox" checked={level.enabled} onChange={event => levels.setValue(update(levels.value, index, { enabled: event.target.checked }))} />Enabled</label>
        </div>; })}
        <SaveBar section={levels} label="Levels" />
      </div>
    </Card>

    <Card title="Resolution validation" description="Who must approve a resolution before the final customer email is sent. Pending TCM decision.">
      <div className="stack-16">
        <div className="grid-2">
          <Field label="Validated by">{props => <select {...props} value={validation.value.mode} onChange={event => validation.setValue({ ...validation.value, mode: event.target.value })}>
            <option value="next_level">The next level on the escalation's path (B2C admin at the top)</option>
            <option value="level">One specific level</option>
            <option value="none">No validation — the owner resolves directly</option>
          </select>}</Field>
          {validation.value.mode === 'level' && <Field label="Level">{props => <select {...props} value={validation.value.levelKey || ''} onChange={event => validation.setValue({ ...validation.value, levelKey: event.target.value })}><option value="">Choose a level</option>{orderedLevels.map(level => <option key={level.key} value={level.key}>{level.label}</option>)}</select>}</Field>}
        </div>
        <SaveBar section={validation} label="Validation" />
      </div>
    </Card>

    <Card title="Customer email templates" description={`Plain-text emails. Placeholders: ${PLACEHOLDERS}. The reference is always added to the subject so replies reach the right escalation. Unapproved templates are never sent.`}>
      <div className="stack-16" id="templates">
        {templates.value.map((template, index) => <div className="b2c-template" key={template.key}>
          <div className="row-between"><strong>{template.label || template.key}</strong>{template.approved ? <Badge tone="success">Approved{template.approvedBy ? ` by ${template.approvedBy}` : ''}{template.approvedAt ? ` · ${formatDateTime(template.approvedAt)}` : ''}</Badge> : <Badge tone="warning">Not approved — emails are held</Badge>}</div>
          <Field label="Subject">{props => <input {...props} value={template.subject} onChange={event => templates.setValue(update(templates.value, index, { subject: event.target.value }))} />}</Field>
          <Field label="Body">{props => <textarea {...props} rows={7} value={template.body} onChange={event => templates.setValue(update(templates.value, index, { body: event.target.value }))} />}</Field>
          <label className="row text-small"><input type="checkbox" checked={template.approved} onChange={event => templates.setValue(update(templates.value, index, { approved: event.target.checked }))} />This wording is approved by TCM for sending to customers</label>
        </div>)}
        <SaveBar section={templates} label="Templates" />
      </div>
    </Card>
  </B2CShell>;
}
