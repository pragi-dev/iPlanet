import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

export class GeminiProviderError extends Error {
  constructor(message, code = 'GEMINI_UNAVAILABLE') { super(message); this.name = 'GeminiProviderError'; this.code = code; }
}

function config(environment = process.env) {
  if (!environment.GEMINI_API_KEY?.trim()) throw new GeminiProviderError('Gemini API key is not configured.', 'GEMINI_API_KEY_NOT_CONFIGURED');
  return {
    apiKey: environment.GEMINI_API_KEY.trim(),
    model: environment.GEMINI_MODEL?.trim() || 'gemini-3.6-flash',
    fallbackModel: environment.GEMINI_FALLBACK_MODEL?.trim() || 'gemini-3.6-flash',
    timeoutMs: Number(environment.GEMINI_TIMEOUT_MS) || 60000
  };
}

function toGeminiContents(messages = []) {
  return messages.filter(item => item?.role !== 'system' && item?.content).map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(item.content) }] }));
}

export async function getGeminiReply({ messages, structuredOutput = false, environment = process.env, client } = {}) {
  const settings = config(environment);
  const systemInstruction = messages.filter(item => item?.role === 'system').map(item => item.content).filter(Boolean).join('\n\n');
  const contents = toGeminiContents(messages);
  if (!contents.length) throw new GeminiProviderError('Gemini request has no user message.', 'GEMINI_INVALID_REQUEST');
  const ai = client || new GoogleGenAI({ apiKey: settings.apiKey });
  const generationConfig = {
    systemInstruction,
    temperature: 0.2,
    ...(structuredOutput ? { responseMimeType: 'application/json' } : {})
  };
  const models = [...new Set([settings.model, settings.fallbackModel])];
  let lastError;
  for (const model of models) {
    let timer;
    try {
      // Deliberately omit prompts, user data, tokens, and the API key from logs.
      console.info(`[AI] Provider: gemini | Model: ${model} | Request received`);
      const response = await Promise.race([
        ai.models.generateContent({ model, contents, config: generationConfig }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new GeminiProviderError('Gemini request timed out.', 'GEMINI_TIMEOUT')), settings.timeoutMs); })
      ]);
      const text = response?.text?.trim();
      if (!text) throw new GeminiProviderError('Gemini returned an empty or blocked response.', 'GEMINI_EMPTY_RESPONSE');
      console.info(`[AI] Provider: gemini | Model: ${model} | Response received`);
      return text;
    } catch (error) {
      if (error instanceof GeminiProviderError) lastError = error;
      else {
        const status = Number(error?.status || error?.statusCode || 0);
        const code = status === 401 || status === 403 ? 'GEMINI_AUTH_FAILED' : status === 404 ? 'GEMINI_MODEL_UNAVAILABLE' : status === 429 ? 'GEMINI_RATE_LIMITED' : status >= 500 ? 'GEMINI_SERVICE_ERROR' : 'GEMINI_REQUEST_FAILED';
        console.error(`[AI ERROR] Stage: Gemini Code: ${code} Status: ${status || 'network/unknown'}`);
        lastError = new GeminiProviderError('Gemini could not complete the request.', code);
      }
      if (!['GEMINI_RATE_LIMITED', 'GEMINI_MODEL_UNAVAILABLE'].includes(lastError.code) || model === models.at(-1)) throw lastError;
      console.warn(`[AI] Model ${model} is unavailable (${lastError.code}); trying fallback model ${models.at(-1)}`);
    } finally { clearTimeout(timer); }
  }
  throw lastError;
}

export async function getGeminiHealth({ environment = process.env } = {}) {
  try { const settings = config(environment); return { available: true, model: settings.model }; } catch { return { available: false, model: environment.GEMINI_MODEL || null }; }
}
