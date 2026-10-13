import { invoke } from '@forge/bridge';
import { buildXlsx, toCsv } from './xlsx.js';
import { sheetsOf, day } from './evidence.js';

/**
 * The one thing UI Kit cannot do is hand the browser a file. This tiny
 * Custom UI resource lives inside a UI Kit <Frame> purely to turn a review
 * into an evidence file: an Excel workbook with a Summary sheet, a Users sheet
 * and a Groups sheet, or a CSV of the users. It talks to the same resolvers
 * as the page.
 */

const $ = (id) => document.getElementById(id);

function offerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

let reviews = [];

async function loadReviews() {
  try {
    const res = await invoke('getStatus');
    if (res?.forbidden) throw new Error(res.error);
    reviews = res?.reviews ?? [];
    const sel = $('review');
    sel.innerHTML = '';
    for (const r of reviews) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${day(r.startedAt)} · ${r.status === 'complete' ? 'signed off' : 'open'} · ${r.counts?.users ?? '?'} users`;
      sel.appendChild(opt);
    }
    const any = reviews.length > 0;
    sel.disabled = !any;
    $('excel').disabled = !any;
    $('csv').disabled = !any;
    $('status').textContent = any ? '' : 'No review yet.';
  } catch (err) {
    $('status').textContent = `Could not list reviews: ${err?.message ?? 'no response'}.`;
  }
}

async function download(kind) {
  const buttons = [$('excel'), $('csv')];
  buttons.forEach((b) => (b.disabled = true));
  $('status').textContent = 'Preparing…';
  try {
    const reviewId = $('review').value;
    const res = await invoke('getReview', { reviewId });
    if (!res?.ok) throw new Error(res?.error ?? 'could not read the review');
    const sheets = sheetsOf(res.review, res.rows ?? [], res.stats);
    const name = `access-review-${day(res.review.startedAt)}`;
    if (kind === 'xlsx') {
      const blob = new Blob([buildXlsx(sheets)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      offerDownload(blob, `${name}.xlsx`);
    } else {
      const text = toCsv(sheets[1].table);
      // The BOM makes Excel open the CSV as UTF-8 without an import wizard.
      offerDownload(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }), `${name}.csv`);
    }
    const capped = res.limit && (res.rows ?? []).length >= res.limit ? ` (capped at ${res.limit} users)` : '';
    $('status').textContent = `${(res.rows ?? []).length} users${capped}.`;
  } catch (err) {
    $('status').textContent = `Could not build the file: ${err?.message ?? 'no response'}.`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

if (typeof document !== 'undefined' && $('excel')) {
  $('excel').addEventListener('click', () => download('xlsx'));
  $('csv').addEventListener('click', () => download('csv'));
  loadReviews();
}
