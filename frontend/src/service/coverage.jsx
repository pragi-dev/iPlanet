import { ServiceShell } from './components';
import { CoverageView, useAsync } from '../ui';
import { getCoverage } from './api';

export function ServiceCoverage() {
  const state = useAsync(getCoverage, []);
  return <ServiceShell title="Warranty & Coverage">
    <CoverageView state={state} showCorporate description="Coverage validity and service entitlements across every corporate device." />
  </ServiceShell>;
}
