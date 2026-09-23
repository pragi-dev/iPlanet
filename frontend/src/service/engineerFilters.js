// Shared engineer search and filters used by the Engineers page and the
// Ticket Details assignment picker. Only fields returned by the engineers API
// are searched: name, employee ID, email, phone and location.
export function filterEngineers(engineers, { search = '', location = 'All', status = 'All' } = {}) {
  const term = search.trim().toLowerCase();
  return engineers.filter(engineer => (status === 'All' || engineer.status === status)
    && (location === 'All' || engineer.location === location)
    && (!term || [engineer.name, engineer.employeeId, engineer.email, engineer.phone, engineer.location].some(value => String(value || '').toLowerCase().includes(term))));
}

export function engineerFilterOptions(engineers) {
  return {
    locations: [...new Set(engineers.map(engineer => engineer.location).filter(Boolean))].sort(),
    statuses: [...new Set(engineers.map(engineer => engineer.status).filter(Boolean))].sort(),
  };
}
