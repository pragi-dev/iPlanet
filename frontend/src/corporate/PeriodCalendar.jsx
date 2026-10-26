import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

const MONTHS = Array.from({ length: 12 }, (_, month) => new Date(2000, month, 1).toLocaleString('en-IN', { month: 'short' }));
const YEARS_PER_PAGE = 12;

// A calendar for picking a whole year or a whole month, which browsers have no native
// control for. `value` and `onChange` use 'YYYY-MM-DD' dates (the first day of the period);
// `max` is the latest selectable date.
export function PeriodCalendar({ kind, value, max, label, onChange }) {
  const [open, setOpen] = useState(false);
  const selected = { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)) - 1 };
  const latest = { year: Number(max.slice(0, 4)), month: Number(max.slice(5, 7)) - 1 };
  // The year shown in the month grid, or the last year on the current page of the year grid.
  const [view, setView] = useState(selected.year);
  const root = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = event => { if (event.type === 'keydown' ? event.key === 'Escape' : !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  // Year pages end at the latest year; open on the page holding the selected year.
  const toggle = () => { setView(kind === 'year' ? latest.year - Math.floor((latest.year - selected.year) / YEARS_PER_PAGE) * YEARS_PER_PAGE : selected.year); setOpen(current => !current); };
  const pick = (year, month = 0) => { onChange(`${year}-${String(month + 1).padStart(2, '0')}-01`); setOpen(false); };

  const years = Array.from({ length: YEARS_PER_PAGE }, (_, index) => view - YEARS_PER_PAGE + 1 + index);
  const heading = kind === 'year' ? `${years[0]} – ${years[years.length - 1]}` : String(view);
  const step = kind === 'year' ? YEARS_PER_PAGE : 1;

  return <div className="period-calendar" ref={root}>
    <button type="button" className="period-calendar-button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
      <CalendarDays size={16} aria-hidden="true" /><span>{kind === 'year' ? selected.year : `${new Date(selected.year, selected.month, 1).toLocaleString('en-IN', { month: 'long' })} ${selected.year}`}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && <div className="period-calendar-popover" role="dialog" aria-label={kind === 'year' ? 'Choose a year' : 'Choose a month'}>
      <div className="period-calendar-head">
        <button type="button" className="icon-button ghost" aria-label={kind === 'year' ? 'Earlier years' : 'Previous year'} onClick={() => setView(current => current - step)}><ChevronLeft size={16} /></button>
        <strong>{heading}</strong>
        <button type="button" className="icon-button ghost" aria-label={kind === 'year' ? 'Later years' : 'Next year'} disabled={view >= latest.year} onClick={() => setView(current => current + step)}><ChevronRight size={16} /></button>
      </div>
      <div className="period-calendar-grid">
        {kind === 'year'
          ? years.map(year => <button type="button" key={year} className="period-calendar-cell" aria-pressed={year === selected.year} disabled={year > latest.year} onClick={() => pick(year)}>{year}</button>)
          : MONTHS.map((name, month) => <button type="button" key={name} className="period-calendar-cell" aria-pressed={view === selected.year && month === selected.month} disabled={view > latest.year || (view === latest.year && month > latest.month)} onClick={() => pick(view, month)}>{name}</button>)}
      </div>
    </div>}
  </div>;
}
