// Raised by email and CRM connectors. `retryable` tells the processing queue
// whether trying again later can succeed (timeouts, 429, 5xx) or whether the
// failure needs configuration or data to change first.
export class ConnectorError extends Error {
  constructor(message, { retryable = true, status, connector } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.retryable = retryable;
    this.status = status;
    this.connector = connector;
  }
}

export function classifyHttpFailure(status) {
  return { retryable: status === 408 || status === 429 || status >= 500 };
}
