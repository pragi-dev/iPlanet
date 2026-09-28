import { Shell } from './components';
import { CoverageView, useAsync } from '../ui';
import { getCoverage } from './api';

export function CoverageEnhanced() {
  const state = useAsync(getCoverage, []);
  return <Shell title="Warranty & Coverage">
    <CoverageView state={state} description="Warranty, AMC and service entitlements across your organization's devices." deviceLink={device => `/corporate/devices/${device._id}`} />
  </Shell>;
}
