import { CoverageView, useAsync } from '../ui';
import { getB2CCoverage } from './api';
import { B2CShell, isB2CAdmin } from './shared';

// Warranty & Coverage for B2C staff: the same view as the iPlanet Service portal, over the
// devices in the staff member's regions (every device for a B2C admin).
export function B2CCoverage() {
  const state = useAsync(getB2CCoverage, []);
  return <B2CShell title="Warranty & Coverage">
    <CoverageView state={state} description={isB2CAdmin() ? 'Coverage validity and service entitlements across every device.' : 'Coverage validity and service entitlements for the devices in your regions.'} />
  </B2CShell>;
}
