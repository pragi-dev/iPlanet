import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatDate, formatDateTime } from '../ui';
import { closedAt, closedIn, coverage, raisedIn, summarise } from './reportData';

const ACCENT = [0, 113, 227];
const MUTED = [110, 110, 115];
const KIND_LABELS = { year: 'Yearly', month: 'Monthly', custom: 'Custom range', day: 'Daily' };

// Builds the PDF for one period (a year, month, custom range or day) and starts the download. Loaded only when a
// report is downloaded, so the PDF library stays out of the page bundle.
export function downloadReportPdf({ period, kind, tickets: allTickets, devices, resolutions = {}, organization }) {
  const tickets = raisedIn(allTickets, period).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const figures = summarise(tickets);
  const fleet = coverage(devices);
  const closedThisPeriod = closedIn(allTickets, period).length;

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const width = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(20, 20, 20).text(`Service report: ${period.title}`, margin, y + 8);
  y += 28;
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...MUTED);
  doc.text([organization || 'Your organization', `${KIND_LABELS[kind]} report · requests raised ${kind === 'day' ? `on ${formatDate(period.start)}` : `${formatDate(period.start)} to ${formatDate(new Date(period.end.getTime() - 86400000))}`}`, `Generated ${formatDateTime(new Date())} from the iPlanet Self-care Portal`], margin, y);
  y += 44;

  const table = (title, head, body, options = {}) => {
    if (y > doc.internal.pageSize.getHeight() - 120) { doc.addPage(); y = margin; }
    doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(20, 20, 20).text(title, margin, y);
    autoTable(doc, { startY: y + 8, head: [head], body: body.length ? body : [[{ content: options.empty || 'None in this period.', colSpan: head.length, styles: { textColor: MUTED, fontStyle: 'italic' } }]], margin: { left: margin, right: margin }, theme: 'grid', styles: { fontSize: 9, cellPadding: 5, lineColor: [225, 225, 230] }, headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: 'bold' }, ...options.table });
    y = doc.lastAutoTable.finalY + 22;
  };
  const counts = rows => rows.map(row => [row.name, row.value]);

  table('Summary', ['Measure', 'Value'], [
    ['Requests raised', figures.total],
    ['Still open', figures.open],
    ['Closed (of requests raised)', figures.closed],
    ['Requests closed during the period', closedThisPeriod],
    ['Average turnaround (raised to closed)', figures.avgDays === null ? 'No closed requests' : `${figures.avgDays.toFixed(1)} days`],
    ['Resolved within target', figures.onTargetPercent === null ? 'No resolved requests' : `${figures.onTargetPercent}% of ${figures.resolvedCount}`],
    ['Devices registered (today)', devices.length],
  ], { table: { columnStyles: { 1: { halign: 'right', cellWidth: 150 } } } });

  const half = (width - margin * 2 - 16) / 2;
  const pair = (left, right) => {
    if (y > doc.internal.pageSize.getHeight() - 160) { doc.addPage(); y = margin; }
    const top = y;
    let bottom = top;
    for (const [index, [title, rows]] of [left, right].entries()) {
      const x = margin + index * (half + 16);
      doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(20, 20, 20).text(title, x, top);
      if (!rows.length) {
        doc.setFont('helvetica', 'italic').setFontSize(9).setTextColor(...MUTED).text('None in this period.', x, top + 20);
        bottom = Math.max(bottom, top + 24);
        continue;
      }
      autoTable(doc, { startY: top + 8, head: [['', 'Requests']], body: counts(rows), margin: { left: x }, tableWidth: half, theme: 'grid', styles: { fontSize: 9, cellPadding: 5, lineColor: [225, 225, 230] }, headStyles: { fillColor: ACCENT, textColor: 255 }, columnStyles: { 1: { halign: 'right', cellWidth: 70 } } });
      bottom = Math.max(bottom, doc.lastAutoTable.finalY);
    }
    y = bottom + 22;
  };
  pair(['By status', figures.byStatus], ['Against resolution targets', figures.sla]);
  pair(['By request type', figures.byType], ['Most reported issues', figures.byIssue]);
  pair(['By service location', figures.byLocation], ['By device type', figures.byDeviceType]);


  // Full details of every request, on landscape pages so the columns have room.
  doc.addPage('a4', 'landscape');
  y = margin;
  const coverageRows = [...new Set([...fleet.warranty, ...fleet.amc].map(row => row.name))].map(name => [name, fleet.warranty.find(row => row.name === name)?.value || 0, fleet.amc.find(row => row.name === name)?.value || 0]);
  table('Device coverage (as of today)', ['Status', 'Warranty', 'AMC'], coverageRows, { empty: 'No devices registered.', table: { tableWidth: 380, columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } } } });
  const clip = (text, length) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > length ? `${value.slice(0, length - 1)}…` : value; };
  table('Requests raised in this period', ['Request', 'Device', 'Location', 'Type · issue', 'Problem reported', 'Resolution', 'Engineer', 'Status'], tickets.map(ticket => {
    const resolved = resolutions[ticket._id];
    const device = ticket.deviceId || {};
    return [
      `${ticket.ticketId}\nRaised ${formatDate(ticket.createdAt)}`,
      [device.model, device.serialNumber && `S/N ${device.serialNumber}`, device.deviceType].filter(Boolean).join('\n') || '—',
      ticket.location || '—',
      [ticket.category || 'Service', ticket.issueType, ticket.deviceCount ? `${ticket.deviceCount} devices` : ''].filter(Boolean).join('\n'),
      clip(ticket.description, 300) || '—',
      resolved ? `${clip(resolved.resolution, 300)}\n(${formatDate(resolved.recordedAt)})` : 'Not resolved yet',
      ticket.assignedEngineer || 'Not assigned',
      [ticket.status, ticket.status === 'Closed' ? `Closed ${formatDate(closedAt(ticket))}` : '', ticket.priority ? `${ticket.priority} priority` : ''].filter(Boolean).join('\n'),
    ];
  }), { empty: 'No requests were raised in this period.', table: { styles: { fontSize: 8, cellPadding: 4, valign: 'top', overflow: 'linebreak', lineColor: [225, 225, 230] }, columnStyles: { 0: { cellWidth: 82 }, 1: { cellWidth: 100 }, 2: { cellWidth: 62 }, 3: { cellWidth: 80 }, 4: { cellWidth: 150 }, 5: { cellWidth: 150 }, 6: { cellWidth: 66 } } } });

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
    // Pages differ in orientation, so measure each one.
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    doc.text(`${organization || ''} · ${period.title}`, margin, pageHeight - 20);
    doc.text(`Page ${page} of ${pages}`, pageWidth - margin, pageHeight - 20, { align: 'right' });
  }
  doc.save(`iplanet-report-${kind}-${period.key}.pdf`);
}
