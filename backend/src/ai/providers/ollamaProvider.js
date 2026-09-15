const trimTrailingSlash = value => String(value || 'http://127.0.0.1:11434').replace(/\/+$/, '');

export class OllamaProviderError extends Error {
  constructor(message, code = 'OLLAMA_UNAVAILABLE') {
    super(message);
    this.name = 'OllamaProviderError';
    this.code = code;
  }
}

export function getOllamaConfig(environment = process.env) {
  if (!environment.OLLAMA_MODEL?.trim()) throw new OllamaProviderError('OLLAMA_MODEL is not configured.', 'OLLAMA_MODEL_NOT_CONFIGURED');
  return {
    baseUrl: trimTrailingSlash(environment.OLLAMA_BASE_URL),
    model: environment.OLLAMA_MODEL.trim(),
    timeoutMs: Number(environment.OLLAMA_TIMEOUT_MS) || 60000
  };
}

export async function getOllamaReply({ messages, fetchImpl = fetch, environment = process.env }) {
  const config = getOllamaConfig(environment);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model: config.model, messages, stream: false, options: { temperature: 0.2 } })
    });
    if (!response.ok) {
      console.error(`[AI ERROR] Stage: Ollama Status: ${response.status} Reason: Ollama returned a non-success response.`);
      throw new OllamaProviderError('Ollama could not complete the request.', response.status === 404 ? 'OLLAMA_MODEL_UNAVAILABLE' : 'OLLAMA_REQUEST_FAILED');
    }
    const payload = await response.json();
    const reply = payload.message?.content?.trim();
    if (!reply) throw new OllamaProviderError('Ollama returned an empty response.', 'OLLAMA_EMPTY_RESPONSE');
    return reply;
  } catch (error) {
    if (error instanceof OllamaProviderError) throw error;
    if (error.name === 'AbortError') throw new OllamaProviderError('Ollama request timed out.', 'OLLAMA_TIMEOUT');
    console.error('[AI] Ollama unavailable');
    console.error('[AI] Check whether Ollama is running');
    console.error(`[AI] Check whether ${config.model} is installed`);
    throw new OllamaProviderError('Ollama is not reachable.', 'OLLAMA_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

export async function getOllamaHealth({ fetchImpl = fetch, environment = process.env } = {}) {
  try {
    const config = getOllamaConfig(environment);
    const response = await fetchImpl(`${config.baseUrl}/api/tags`);
    if (!response.ok) return { available: false, model: config.model };
    const payload = await response.json();
    const available = Array.isArray(payload.models) && payload.models.some(item => item.name === config.model || item.model === config.model);
    return { available, model: config.model };
  } catch (error) {
    console.error('[AI] Ollama unavailable');
    console.error('[AI] Check whether Ollama is running');
    console.error(`[AI] Check whether ${environment.OLLAMA_MODEL || 'the configured model'} is installed`);
    return { available: false, model: environment.OLLAMA_MODEL };
  }
}
