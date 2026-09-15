import { getAiSupportReply } from './ai/aiEngine.js';
import { buildSupportContext } from './ai/contextBuilder.js';

// Compatibility entry point for callers of the former external-provider service.
// It uses the same local Ollama engine as every other AI support path.
export async function getAiTroubleshootingStep({ ticket, previousSteps = [], customerResponse = '' }) {
  const issueText = ticket?.description || 'Unknown issue';
  const message = customerResponse || issueText;
  const context = buildSupportContext({
    message,
    conversation: previousSteps.map(content => ({ role: 'assistant', content }))
  });
  context.portalContext = `Verified portal context:\nDevice type: ${ticket?.deviceId?.deviceType || 'Apple device'}\nDevice model: ${ticket?.deviceId?.model || 'Unknown model'}\nIssue category: ${ticket?.issueType || 'General support'}\nIssue description: ${issueText}\nTicket ID: ${ticket?.ticketId || 'Unknown'}`;
  return { available: true, message: await getAiSupportReply({ message, context }) };
}
