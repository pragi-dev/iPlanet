import { Hourglass } from 'ldrs/react';
import 'ldrs/react/Hourglass.css';

// The app's loading indicator: the Hourglass loader from uiball's LDRS
// (https://uiball.com/ldrs/), drawn in the accent colour.
export function Loader({ size = 40, label = 'Loading…', className = '' }) {
  return <div className={`loader ${className}`.trim()} role="status" aria-live="polite">
    <Hourglass size={size} color="var(--color-accent)" speed={1.75} bgOpacity={0.15} />
    {label && <span className="loader-label">{label}</span>}
  </div>;
}
