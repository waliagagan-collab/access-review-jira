import { invoke, events } from '@forge/bridge';
import { buildXlsx, toCsv } from './xlsx.js';
import { sheetsOf, stamp, fileStamp } from './evidence.js';
import { decisionStats } from '../lib/review.js';
import { OPEN_REVIEW_EVENT, FRAME_READY_EVENT } from '../lib/ui.js';

/**
 * The one thing UI Kit cannot do is hand the browser a file. This tiny
 * Custom UI resource lives inside a UI Kit <Frame> purely to turn a review
 * into an evidence file: an Excel workbook with Summary, Users, Groups and
 * Changes sheets, or a CSV of the users. It talks to the same resolvers as
 * the page.
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
// The review open on the page, once the page has said which. Until then the
// newest review stays selected.
let wanted = null;

function selectWanted() {
  const sel = $('review');
  if (wanted && reviews.some((r) => r.id === wanted)) sel.value = wanted;
}

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
      opt.textContent = `${stamp(r.generatedAt)} · ${r.status === 'complete' ? 'signed off' : 'open'} · ${r.counts?.users ?? '?'} users`;
      sel.appendChild(opt);
    }
    const any = reviews.length > 0;
    sel.disabled = !any;
    $('excel').disabled = !any;
    $('csv').disabled = !any;
    $('status').textContent = any ? '' : 'No review yet.';
    selectWanted();
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
    // A review arrives in pages; the first carries the record and the groups.
    const first = await invoke('getReview', { reviewId, page: 0 });
    if (!first?.ok) throw new Error(first?.error ?? 'could not read the review');
    let rows = first.rows ?? [];
    for (let p = 1; p < (first.pages ?? 1); p++) {
      $('status').textContent = `Preparing… ${rows.length} users so far`;
      const res = await invoke('getReview', { reviewId, page: p });
      if (!res?.ok) throw new Error(res?.error ?? 'could not read the review');
      rows = rows.concat(res.rows ?? []);
    }
    const stats = decisionStats(rows, Object.fromEntries(rows.map((r) => [r.accountId, { decision: r.decision }])));
    const sheets = sheetsOf(first.review, rows, stats);
    const name = `access-review-${fileStamp(first.review.generatedAt ?? first.review.startedAt)}`;
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
    $('status').textContent = `${rows.length} users.`;
  } catch (err) {
    $('status').textContent = `Could not build the file: ${err?.message ?? 'no response'}.`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

/**
 * Follow the page: select the review it has open. If the events never arrive
 * the dropdown simply keeps its default, the newest review.
 */
async function followPage() {
  try {
    await events.on(OPEN_REVIEW_EVENT, (payload) => {
      wanted = payload?.id ? String(payload.id) : null;
      selectWanted();
    });
    await events.emit(FRAME_READY_EVENT);
  } catch {
    // No events in this host: the default selection stays.
  }
}

if (typeof document !== 'undefined' && $('excel')) {
  $('excel').addEventListener('click', () => download('xlsx'));
  $('csv').addEventListener('click', () => download('csv'));
  followPage();
  loadReviews();
}
