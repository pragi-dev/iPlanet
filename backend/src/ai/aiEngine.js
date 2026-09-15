import { buildSupportMessages } from './aiPrompt.js';
import { getProviderReply, GeminiProviderError, OllamaProviderError } from './providers/providerRouter.js';

export class AiSupportError extends Error {
  constructor(message, statusCode = 503, code = 'AI_UNAVAILABLE') {
    super(message);
    this.name = 'AiSupportError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function getAiSupportReply({ message, context, fetchImpl = fetch, environment = process.env }) {
  try {
    return await getProviderReply({ messages: buildSupportMessages({ message, context }), fetchImpl, environment });
  } catch (error) {
    if (error instanceof AiSupportError) throw error;
    if (error instanceof OllamaProviderError || error instanceof GeminiProviderError) throw new AiSupportError('AI assistance is temporarily unavailable. You can still raise a service request manually.', 503, error.code);
    console.error('[AI ERROR] Stage: AI Engine Reason: Unexpected local AI error.');
    throw new AiSupportError('Local AI support is currently unavailable.', 503, 'OLLAMA_UNEXPECTED_ERROR');
  }
}
