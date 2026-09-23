import { useCallback } from 'react';
import { Shell } from './components';
import { CoverageView, useAsync } from '../ui';
import { getCoverage } from './api';

const filterOptions = ['Active', 'Expiring Soon', 'Expired', 'Covered'];

export function CoverageEnhanced() {
  const state = useAsync(getCoverage, []);
  const matchesFilter = useCallback((device, filter) => device.warrantyStatus === filter || device.amcStatus === filter || (filter === 'Covered' && device.coverageStatus === 'Covered'), []);
  return <Shell title="Warranty & Coverage">
    <CoverageView state={state} description="Warranty, AMC and service entitlements across your organization's devices." filterOptions={filterOptions} matchesFilter={matchesFilter} deviceLink={device => `/corporate/devices/${device._id}`} />
  </Shell>;
}
