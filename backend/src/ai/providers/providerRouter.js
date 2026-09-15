import 'dotenv/config';
import { getGeminiHealth, getGeminiReply, GeminiProviderError } from './geminiProvider.js';
import { getOllamaHealth, getOllamaReply, OllamaProviderError } from './ollamaProvider.js';

export function selectedProvider(environment = process.env) { return (environment.AI_PROVIDER || 'gemini').trim().toLowerCase(); }
export async function getProviderReply(options = {}) {
  const provider = selectedProvider(options.environment);
  if (provider === 'gemini') return getGeminiReply(options);
  if (provider === 'ollama') return getOllamaReply(options);
  throw Object.assign(new Error('Unsupported AI provider.'), { code: 'AI_PROVIDER_UNSUPPORTED' });
}
export async function getProviderHealth(options = {}) {
  return selectedProvider(options.environment) === 'gemini' ? getGeminiHealth(options) : getOllamaHealth(options);
}
export { GeminiProviderError, OllamaProviderError };
