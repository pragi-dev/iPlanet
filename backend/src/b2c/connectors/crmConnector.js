import { createTestCrmAdapter } from './testCrmAdapter.js';

// CRM connector contract. TCM has not yet supplied CRM API documentation or
// credentials, so no live adapter exists. A live adapter must implement:
//
//   provider        e.g. 'tcm_crm'
//   mode            'live' | 'test'
//   isConfigured()  true when its credentials are present
//   lookup({ caseIds, serialNumbers, email }) -> { matches: [CrmMatch] }
//
// CrmMatch: {
//   customer: { crmCustomerId, name, email, phone, region },
//   devices:  [{ crmDeviceId, serialNumber, model, productName, purchaseDate, warrantyStatus }],
//   cases:    [{ caseId, status, openedAt, description }],
//   matchedBy: 'caseId' | 'serialNumber' | 'email'
// }
//
// It should throw ConnectorError (connectorErrors.js) with retryable=true for
// timeouts, 429 and 5xx so the lookup is retried, and retryable=false for
// authentication or request errors. Only the mapped fields above are stored
// on the ticket; raw CRM responses are never persisted or logged.
export function createCrmConnector({ config, testAdapter } = {}) {
  if (config.crmProvider === 'test' && config.allowTestAdapters) return testAdapter || createTestCrmAdapter();
  return { provider: config.crmProvider === 'test' ? 'test (disabled in production)' : 'none', mode: 'not_configured', isConfigured: () => false, async lookup() { return { matches: [] }; } };
}
