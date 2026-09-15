import { getProviderReply } from './providers/providerRouter.js';
import { indiaToday } from './serviceDate.js';

export const REQUEST_CATEGORIES = ['Service', 'Health Camp', 'Buyback', 'E-Waste'];
export const REQUEST_ISSUE_TYPES = ['Screen / Display', 'Battery', 'Charging', 'Keyboard', 'Trackpad', 'Camera', 'Speaker', 'Software', 'Performance', 'Physical Damage', 'Other'];

const requestSystemPrompt = `You understand corporate Apple-device service requests. Return ONLY one JSON object with intent, workflowSignal, category, issueType, description, preferredServiceDateIntent, symptoms. workflowSignal is one of: resolved, failed, explicit_service, unsafe, unknown. Allowed categories: Service, Health Camp, Buyback, E-Waste. Allowed issueType: Screen / Display, Battery, Charging, Keyboard, Trackpad, Camera, Speaker, Software, Performance, Physical Damage, Other. Return the customer's date words, never a calculated date. Never invent device, serial, company, coverage, IDs, location, or dates. Use null for unknown values.`;

function jsonObject(text) {
  const value = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(value.slice(start, end + 1)); } catch { return null; }
}

function fallback(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  let issueType = null;
  if (/overheat|battery|drain/.test(lower)) issueType = 'Battery';
  else if (/charg/.test(lower)) issueType = 'Charging';
  else if (/screen|display|flicker/.test(lower)) issueType = 'Screen / Display';
  else if (/keyboard/.test(lower)) issueType = 'Keyboard';
  else if (/trackpad/.test(lower)) issueType = 'Trackpad';
  else if (/camera/.test(lower)) issueType = 'Camera';
  else if (/speaker|sound|audio/.test(lower)) issueType = 'Speaker';
  else if (/slow|performance|freeze/.test(lower)) issueType = 'Performance';
  else if (/damage|crack|broken/.test(lower)) issueType = 'Physical Damage';
  const workflowSignal = /smoke|burning smell|swollen battery|sparks|catching fire/.test(lower) ? 'unsafe'
    : /send an engineer|raise (a )?service request|need someone to repair/.test(lower) ? 'explicit_service'
    : /still|didn.t work|doesn.t work|same issue|nothing changed|not fixed|not resolved|tried everything|இன்னும்\s*(வேலை\s*செய்யல|வேலை\s*செய்யவில்லை|இருக்கு)|சரியாகவில்லை/.test(lower) ? 'failed'
    : /^(yes|yep|yeah|ok|okay|fixed)\.?$|works now|working now|fixed it|problem solved|resolved|சரி\s*ஆயிடுச்சு|வேலை\s*செய்கிறது|சரியாகிவிட்டது/.test(lower) ? 'resolved'
    : 'unknown';
  return { intent: issueType ? 'create_service_request' : 'unknown', workflowSignal, category: issueType ? 'Service' : null, issueType, description: issueType ? text : null, preferredServiceDateIntent: null, symptoms: [] };
}

export function normalizeRequestUnderstanding(raw, message) {
  const data = raw && typeof raw === 'object' ? raw : jsonObject(raw);
  const safe = data || fallback(message);
  const category = REQUEST_CATEGORIES.includes(safe.category) ? safe.category : null;
  const issueType = REQUEST_ISSUE_TYPES.includes(safe.issueType) ? safe.issueType : fallback(message).issueType;
  const description = typeof safe.description === 'string' && safe.description.trim() ? safe.description.trim().slice(0, 4000) : fallback(message).description;
  const preferredServiceDateIntent = typeof safe.preferredServiceDateIntent === 'string' ? safe.preferredServiceDateIntent.trim().slice(0, 100) : null;
  const fallbackSignal = fallback(message).workflowSignal;
  // Immediate service and unsafe escalation are business-rule exceptions to
  // the normal troubleshooting-first flow. They must be grounded in explicit
  // customer wording, not inferred by a model from an ordinary symptom (for
  // example, a charging problem after trying another cable).
  const modelSignal = ['resolved', 'failed'].includes(safe.workflowSignal) ? safe.workflowSignal : 'unknown';
  const workflowSignal = fallbackSignal !== 'unknown' ? fallbackSignal : modelSignal;
  return { intent: safe.intent === 'create_service_request' || description ? 'create_service_request' : 'unknown', workflowSignal, category, issueType, description, preferredServiceDateIntent, symptoms: Array.isArray(safe.symptoms) ? safe.symptoms.filter(item => typeof item === 'string').slice(0, 8) : [] };
}

// Used only for clear customer outcome phrases while the backend is already
// awaiting a troubleshooting result. This avoids spending a Gemini request to
// classify "not resolved" or "it's working now"; it never generates a reply
// or substitutes for Gemini's troubleshooting response.
export function understandDeterministicResult(message) {
  return normalizeRequestUnderstanding(null, message);
}

export async function understandRequest({ message, conversation = [], fetchImpl, environment } = {}) {
  const messages = [
    { role: 'system', content: `${requestSystemPrompt}\nCurrent date: ${indiaToday()}; timezone: Asia/Kolkata.` },
    ...conversation.slice(-6).filter(item => item?.content).map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content).slice(0, 1000) })),
    { role: 'user', content: message }
  ];
  const raw = await getProviderReply({ messages, structuredOutput: true, fetchImpl, environment });
  return normalizeRequestUnderstanding(raw, message);
}
