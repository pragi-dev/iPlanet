// TEST ADAPTER — NOT TCM's CRM.
// Returns a handful of obviously fictitious records (example.test addresses,
// TEST- identifiers) so the email-to-ticket flow can be exercised end to end
// before TCM provides its CRM API. It contains no real customer data and is
// disabled in production unless B2C_ALLOW_TEST_ADAPTERS=true.
export const TEST_CRM_RECORDS = [
  {
    customer: { crmCustomerId: 'TEST-CUST-0001', name: 'Test Customer One', email: 'test.customer.one@example.test', phone: '+00 0000 000001', region: 'Test Region North' },
    devices: [{ crmDeviceId: 'TEST-DEV-0001', serialNumber: 'TESTSERIAL01', model: 'Test Device Model A', productName: 'Test Product A', purchaseDate: '2025-01-15', warrantyStatus: 'Test — Active' }],
    cases: [{ caseId: 'TEST-CASE-0001', status: 'Open', openedAt: '2026-09-01', description: 'Test case record' }],
  },
  {
    customer: { crmCustomerId: 'TEST-CUST-0002', name: 'Test Customer Two', email: 'test.customer.two@example.test', phone: '+00 0000 000002', region: 'Test Region South' },
    devices: [{ crmDeviceId: 'TEST-DEV-0002', serialNumber: 'TESTSERIAL02', model: 'Test Device Model B', productName: 'Test Product B', purchaseDate: '2024-06-30', warrantyStatus: 'Test — Expired' }],
    cases: [{ caseId: 'TEST-CASE-0002', status: 'Closed', openedAt: '2026-07-11', description: 'Test case record' }],
  },
  // Shares a serial with record 1, to exercise the "multiple matches" path.
  {
    customer: { crmCustomerId: 'TEST-CUST-0003', name: 'Test Customer Three', email: 'test.customer.three@example.test', phone: '+00 0000 000003', region: 'Test Region North' },
    devices: [{ crmDeviceId: 'TEST-DEV-0003', serialNumber: 'TESTSERIALDUP', model: 'Test Device Model A', productName: 'Test Product A', purchaseDate: '2025-03-02', warrantyStatus: 'Test — Active' }],
    cases: [],
  },
  {
    customer: { crmCustomerId: 'TEST-CUST-0004', name: 'Test Customer Four', email: 'test.customer.four@example.test', phone: '+00 0000 000004', region: 'Test Region North' },
    devices: [{ crmDeviceId: 'TEST-DEV-0004', serialNumber: 'TESTSERIALDUP', model: 'Test Device Model A', productName: 'Test Product A', purchaseDate: '2025-03-02', warrantyStatus: 'Test — Active' }],
    cases: [],
  },
];

export function createTestCrmAdapter({ records = TEST_CRM_RECORDS, failWith = null } = {}) {
  const state = { failWith, calls: 0 };
  return {
    provider: 'test',
    mode: 'test',
    isConfigured: () => true,
    state,
    // Tests can make the next lookups fail to exercise retries.
    failNext(error) { state.failWith = error; },
    async lookup({ caseIds = [], serialNumbers = [], email } = {}) {
      state.calls += 1;
      if (state.failWith) { const error = state.failWith; state.failWith = null; throw error; }
      const cases = new Set(caseIds.map(value => value.toUpperCase()));
      const serials = new Set(serialNumbers.map(value => value.toUpperCase()));
      const matches = [];
      for (const record of records) {
        const matchedBy = record.cases.some(item => cases.has(item.caseId)) ? 'caseId'
          : record.devices.some(item => serials.has(item.serialNumber)) ? 'serialNumber'
          : email && record.customer.email === String(email).toLowerCase() ? 'email' : null;
        if (matchedBy) matches.push({ ...structuredClone(record), matchedBy });
      }
      // An identifier match is more specific than an email match.
      const specific = matches.filter(match => match.matchedBy !== 'email');
      return { matches: specific.length ? specific : matches };
    },
  };
}
