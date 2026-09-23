import { useCallback } from 'react';
import { ServiceShell } from './components';
import { CoverageView, useAsync } from '../ui';
import { getCoverage } from './api';

const filterOptions = ['Warranty', 'AMC', 'Covered', 'Expiring Soon', 'Expired'];

export function ServiceCoverage() {
  const state = useAsync(getCoverage, []);
  const matchesFilter = useCallback((device, filter) => (filter === 'Warranty' && device.warrantyStatus) || (filter === 'AMC' && device.amcStatus) || device.coverageStatus === filter || device.warrantyStatus === filter || device.amcStatus === filter, []);
  return <ServiceShell title="Warranty & Coverage">
    <CoverageView state={state} showCorporate description="Coverage validity and service entitlements across every corporate device." filterOptions={filterOptions} matchesFilter={matchesFilter} />
  </ServiceShell>;
}
