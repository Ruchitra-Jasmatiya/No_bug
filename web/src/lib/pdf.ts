import type { ReportDTO } from '@nba/shared';
import { CATEGORY_LABEL, formatDate } from './format';

/** Builds a plain, text-based PDF of the report in the browser. jsPDF is loaded on demand. */
export async function downloadReportPdf(report: ReportDTO): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  let y = M;

  const ensure = (h: number) => {
    if (y + h > H - M) {
      doc.addPage();
      y = M;
    }
  };
  const text = (s: string, size = 10.5, style: 'normal' | 'bold' = 'normal', color: [number, number, number] = [43, 50, 40], indent = 0) => {
    doc.setFont('helvetica', style).setFontSize(size).setTextColor(...color);
    const lines = doc.splitTextToSize(s, W - M * 2 - indent) as string[];
    for (const line of lines) {
      ensure(size * 1.35);
      doc.text(line, M + indent, y);
      y += size * 1.35;
    }
  };
  const gap = (n = 8) => (y += n);

  doc.setFillColor(245, 240, 228).rect(0, 0, W, 96, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(22).setTextColor(63, 78, 55).text('NO BUGS ALLOWED', M, 48);
  doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(91, 99, 85).text('Website testing report', M, 68);
  y = 124;

  const j = report.job;
  text(j.hostname, 18, 'bold');
  text(j.targetUrl, 10, 'normal', [91, 99, 85]);
  text(`Tested ${formatDate(j.finishedAt ?? j.queuedAt)}  ·  Status: ${j.status}`, 10, 'normal', [91, 99, 85]);
  gap(10);
  text(report.message, 12, 'bold');
  gap(4);
  const c = report.summary.counts;
  text(`Checks: ${c.pass} passed · ${c.fail} failed · ${c.warning} warnings · ${c.info} informational · ${c.skipped + c.blocked} not run`);
  text(`Issues reported: ${report.bugs.length}`);
  if (report.summary.incomplete) text('Some modules were skipped, blocked or unavailable. This report only covers the tests that ran.', 10, 'normal', [168, 65, 47]);
  gap(14);

  text('Modules', 14, 'bold');
  for (const m of report.modules) text(`• ${m.label}: ${m.status}${m.note ? ` — ${m.note}` : ''}`, 10, 'normal', [43, 50, 40], 8);
  gap(14);

  text(`Issues (${report.bugs.length})`, 14, 'bold');
  if (report.bugs.length === 0) text('No issues detected in the tests performed.');
  report.bugs.forEach((b, i) => {
    gap(8);
    ensure(60);
    text(`${i + 1}. [${b.severity.toUpperCase()}] ${b.title}`, 11.5, 'bold');
    text(`${b.issueCode} · ${CATEGORY_LABEL[b.category] ?? b.category} · ${b.confidence}${b.affectedUrl ? ` · ${b.affectedUrl}` : ''}`, 9, 'normal', [91, 99, 85], 10);
    text(b.description, 10, 'normal', [43, 50, 40], 10);
    text(`Suggested fix: ${b.suggestedFix}`, 10, 'normal', [63, 78, 55], 10);
    const ai = b.aiAnalysis as { explanation?: string; fix?: string } | null;
    if (ai?.explanation) text(`AI explanation (not test evidence): ${ai.explanation}`, 9.5, 'normal', [91, 99, 85], 10);
  });

  gap(18);
  text('This report lists what was found in the tests performed. It does not certify that a website is free of bugs.', 9, 'normal', [91, 99, 85]);
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p).setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(130, 135, 120);
    doc.text(`NO BUGS ALLOWED · ${j.hostname} · page ${p} of ${pages}`, M, H - 24);
  }
  doc.save(`no-bugs-allowed-${j.hostname.replace(/[^a-z0-9.-]/gi, '_')}-${(j.finishedAt ?? j.queuedAt).slice(0, 10)}.pdf`);
}
