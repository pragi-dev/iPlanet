// SLA escalation rules shared by B2B service tickets and B2C escalations, so both
// escalate the same way from the same EscalationRule records.
export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
export const RESPONSE_TARGET = '4 business hours';
export function targetHours(priority = 'Medium') { return { Critical: 4, High: 12, Medium: 24, Low: 48 }[priority] || 24; }
export function slaTargets(priority, createdAt) {
  return { responseTarget: RESPONSE_TARGET, resolutionTarget: `${targetHours(priority)} hours`, slaTargetAt: new Date(new Date(createdAt).getTime() + targetHours(priority) * 3600000) };
}

const BREACH_TRIGGERS = ['SLA Breached', 'Critical SLA Breach', 'High Priority SLA Breach'];
const RISK_TRIGGERS = ['SLA Approaching', 'SLA At Risk'];
// Of the rules a ticket has reached, the one with the highest escalation level wins, so a
// generic "All priorities" rule can never downgrade a Critical ticket's escalation.
const strongestRule = (rules, triggers, elapsedPercent) => rules.filter(rule => triggers.includes(rule.trigger) && elapsedPercent >= rule.slaThreshold).sort((a, b) => b.level - a.level || b.slaThreshold - a.slaThreshold)[0];

// The escalation state a ticket should move to, or null when nothing changes.
// `changed` is true when the SLA or escalation status itself moves (not just the level).
export function computeSlaEscalation(ticket, activeRules, now = Date.now()) {
  if (!ticket.slaTargetAt || ['Completed', 'Closed'].includes(ticket.status)) return null;
  const target = new Date(ticket.slaTargetAt).getTime();
  const created = new Date(ticket.createdAt).getTime();
  const elapsedPercent = Math.min(100, Math.max(0, ((now - created) / (target - created)) * 100));
  const rules = activeRules.filter(rule => rule.priority === 'All' || rule.priority === ticket.priority);
  const breachRule = strongestRule(rules, BREACH_TRIGGERS, elapsedPercent);
  const riskRule = strongestRule(rules, RISK_TRIGGERS, elapsedPercent);
  const nextStatus = breachRule ? 'SLA Breached' : riskRule ? 'At Risk' : 'Healthy';
  if (nextStatus === 'Healthy' || ['SLA Breached', 'Escalated'].includes(ticket.escalationStatus) && nextStatus !== 'SLA Breached') return null;
  const rule = breachRule || riskRule;
  const ruleLevel = rule?.level || (nextStatus === 'SLA Breached' && ticket.priority === 'Critical' ? 3 : nextStatus === 'SLA Breached' ? 2 : 1);
  const level = Math.max(ruleLevel, ticket.escalationLevel || 0);
  // Level 2+ breaches are handed to management, which the dashboards count as escalations.
  const nextEscalation = nextStatus === 'SLA Breached' && level >= 2 ? 'Escalated' : nextStatus;
  const reason = nextStatus !== 'SLA Breached' ? 'Resolution SLA approaching' : now >= target ? 'Resolution SLA exceeded' : 'Escalation threshold reached before the SLA deadline';
  const update = { slaStatus: nextStatus, escalationStatus: nextEscalation, escalationLevel: level, escalationReason: reason, escalatedAt: ticket.escalatedAt || new Date(now) };
  if (Object.entries(update).every(([key, value]) => key === 'escalatedAt' ? Boolean(ticket.escalatedAt) : ticket[key] === value)) return null;
  return { update, nextStatus, level, reason, changed: ticket.slaStatus !== nextStatus || ticket.escalationStatus !== nextEscalation };
}
