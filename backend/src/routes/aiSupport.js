import { Router } from 'express';
import { getAiSupportReply, AiSupportError } from '../ai/aiEngine.js';
import { buildSupportContext } from '../ai/contextBuilder.js';
import { getProviderHealth, selectedProvider } from '../ai/providers/providerRouter.js';

const MAX_MESSAGE_LENGTH = 4000;

export function createAiSupportRouter() {
  const router = Router();
  router.get('/health', async (_, res) => {
    const { available, model } = await getProviderHealth();
    return res.json({ success: available, provider: selectedProvider(), model, available });
  });
  router.post('/support/chat', async (req, res, next) => {
    return next();
    /*
    const { message, conversation, conversationId, ticketId, deviceId } = req.body || {};
    // The portal already uses this URL for ticket-bound, persisted sessions.
    // Leave that workflow to its existing handler in server.js.
    if (ticketId || conversationId || deviceId) return next();
    if (req.user?.role !== 'corporate_admin') return res.status(403).json({ success: false, message: 'This account is not allowed to access AI support.' });
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ success: false, message: 'A non-empty message is required.' });
    if (message.trim().length > MAX_MESSAGE_LENGTH) return res.status(400).json({ success: false, message: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` });
    if (conversation !== undefined && !Array.isArray(conversation)) return res.status(400).json({ success: false, message: 'Conversation must be an array when supplied.' });
    try {
      const context = buildSupportContext({ message: message.trim(), conversation });
      if (process.env.AI_KNOWLEDGE_DEBUG === 'true') {
        context.retrievedKnowledge.forEach(item => console.info(`AI Knowledge Retrieval: category=${item.category} document=${item.id} score=${item.relevanceScore}`));
      }
      const reply = await getAiSupportReply({ message: message.trim(), context });
      return res.json({ success: true, reply });
    } catch (error) {
      const status = error instanceof AiSupportError ? error.statusCode : 503;
      const code = error instanceof AiSupportError ? error.code : 'AI_UNEXPECTED_ERROR';
      console.error(`[AI ERROR] Stage: AI Support Route Code: ${code}`);
      return res.status(status).json({ success: false, message: 'AI support is currently unavailable. Please try again later or contact the service team.' });
    }
    */
  });
  return router;
}
