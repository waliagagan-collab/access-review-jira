import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  Frame,
  Heading,
  Inline,
  Label,
  Link,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  ProgressBar,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';
import { licenseGate, licenseMessage } from '../lib/scan.js';
import { scanProgress, showReviewPrompt } from '../lib/ui.js';
import { DECISIONS, DECISION_WORDS, decisionStats, filterReviewRows, quarterName } from '../lib/review.js';

const REVIEW_URL = 'https://marketplace.atlassian.com/search?query=Access%20Review%20for%20Jira';

const PERIODS = [30, 60, 90, 180, 365].map((d) => ({
  label: `Activity in the last ${d} days`,
  value: String(d),
}));

const fmtDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '—');
const fmtTime = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const phaseText = (s) => {
  switch (s?.phase) {
    case 'roles':
      return 'Reading which groups grant which product';
    case 'groups':
      return `Listing groups — ${Object.keys(s.groupsAll ?? {}).length} so far`;
    case 'members':
      return `Listing group members — ${s.usersFound ?? 0} memberships read`;
    case 'issues':
      return `Scanning recent activity — ${s.issuesScanned ?? 0} issues`;
    case 'verify':
      return `Checking users — ${s.verified ?? 0} checked, ${s.inactiveFound ?? 0} with no activity so far`;
    case 'finalize':
      return 'Building the review';
    default:
      return 'Working';
  }
};

/**
 * One-time request for a Marketplace review, shown only after a review has
 * been signed off. Closing it hides it for the whole site.
 */
function ReviewPrompt({ onHide }) {
  return (
    <SectionMessage appearance="discovery" title="Did this make your access review easier?">
      <Stack space="space.100">
        <Text>
          A short review on the Atlassian Marketplace helps other admins find this app. It takes a minute, and we
          read every one.
        </Text>
        <Inline space="space.100" alignBlock="center">
          <Link href={REVIEW_URL} openNewTab>
            Write a review
          </Link>
          <Button appearance="subtle" onClick={onHide}>
            Not now
          </Button>
        </Inline>
      </Stack>
    </SectionMessage>
  );
}

const HowItWorks = ({ compact, onToggle }) =>
  compact ? (
    <SectionMessage>
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Text>
          A snapshot of every user, their groups, products, admin rights and recent activity. Mark each person Keep,
          Remove or Follow up, sign the review off, and download the evidence. Read-only: nothing on your site changes.
        </Text>
        <Button appearance="subtle" spacing="compact" onClick={onToggle}>
          How it works
        </Button>
      </Inline>
    </SectionMessage>
  ) : (
    <SectionMessage title="How it works">
      <Stack space="space.100">
        <Text>
          <Strong>Start a review</Strong> and the app takes a snapshot of the site: every group (including empty ones),
          who is in it, which product each group grants, who holds an admin group, and whether each person did
          anything in Jira in the window: created or reported an issue, changed a status or field, commented or
          logged work. Every candidate is checked against all issues, not a sample.
        </Text>
        <Text>
          Then review: mark each person <Strong>Keep</Strong>, <Strong>Remove</Strong> or <Strong>Follow up</Strong>,
          add notes, and <Strong>Complete review</Strong> to sign it off with your name and the time. Download the
          evidence as Excel (summary, users and groups) for your SOC 2 or ISO 27001 file. The next review shows who
          was added, who left and who became an admin since this one.
        </Text>
        <Text>
          The app never changes anything. To act on the Remove list, use Atlassian Administration, or Seat Reclaim for
          Jira, which removes access with an undo.
        </Text>
        {onToggle && (
          <Box>
            <Button appearance="subtle" spacing="compact" onClick={onToggle}>
              Hide
            </Button>
          </Box>
        )}
      </Stack>
    </SectionMessage>
  );

// ---------------------------------------------------------------------------
// Review tab
// ---------------------------------------------------------------------------

const ALL = { label: 'Everyone', value: '' };
const VIEWS = [
  ALL,
  { label: 'Admins', value: 'admins' },
  { label: 'Active in the window', value: 'active' },
  { label: 'No activity in the window', value: 'inactive' },
  { label: 'New since previous review', value: 'new' },
];
const DECISION_FILTERS = [
  { label: 'Any decision', value: '' },
  { label: 'Undecided', value: 'undecided' },
  { label: 'Keep', value: 'keep' },
  { label: 'Remove', value: 'remove' },
  { label: 'Follow up', value: 'flag' },
];
const ALL_PRODUCTS = { label: 'All products', value: '' };
const ALL_GROUPS = { label: 'All groups', value: '' };

const decisionAppearance = { keep: 'primary', remove: 'danger', flag: 'warning' };
const decisionLozenge = { keep: 'success', remove: 'removed', flag: 'moved' };

function StartReview({ gate, running, stale, busy, onStart, period, setPeriod, hasReviews }) {
  return (
    <Inline space="space.100" alignBlock="end" shouldWrap>
      <Box xcss={{ minWidth: '250px' }}>
        <Label labelFor="period">Activity window</Label>
        <Select id="period" options={PERIODS} value={period} onChange={setPeriod} isDisabled={(running && !stale) || !gate.allowed} />
      </Box>
      <Button appearance={hasReviews ? 'default' : 'primary'} onClick={onStart} isDisabled={(running && !stale) || busy || !gate.allowed}>
        {running && !stale ? 'Taking snapshot…' : stale ? 'Restart snapshot' : hasReviews ? 'Start a new review' : 'Start a review'}
      </Button>
    </Inline>
  );
}

function ReviewPanel({ gate, status, refresh, review, rows, setRows, stats, reload, loading, loadError }) {
  const [period, setPeriod] = useState(PERIODS[2]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [showHow, setShowHow] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [noteFor, setNoteFor] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [query, setQuery] = useState('');
  const [searchVersion, setSearchVersion] = useState(0);
  const [productFilter, setProductFilter] = useState(ALL_PRODUCTS);
  const [groupFilter, setGroupFilter] = useState(ALL_GROUPS);
  const [viewFilter, setViewFilter] = useState(ALL);
  const [decisionFilter, setDecisionFilter] = useState(DECISION_FILTERS[0]);
  const [justCompleted, setJustCompleted] = useState(false);

  const [reviewHidden, setReviewHidden] = useState(true);
  const hideReview = () => {
    setReviewHidden(true);
    invoke('hideReviewPrompt').catch(() => {});
  };
  useEffect(() => {
    invoke('getSettings')
      .then((res) => setReviewHidden(Boolean(res?.settings?.reviewPromptHiddenAt)))
      .catch(() => {});
  }, []);

  const state = status?.state;
  const running = state?.status === 'running';
  const stale = Boolean(status?.stale);
  const scan = scanProgress(state);

  // Poll only while a snapshot is actually being built.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [running, refresh]);

  const start = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await invoke('startReview', { days: Number(period.value) });
      if (!res?.ok) setMessage(res?.error ?? 'Could not start the review.');
      await refresh();
    } catch (err) {
      setMessage(
        `Could not start the review: ${err?.message ?? 'the app did not respond'}. Try again, and if it keeps happening email support@telcomaglobal.com.`
      );
    } finally {
      setBusy(false);
    }
  };

  const locked = review?.status === 'complete';

  // Decisions are applied on the page first and sent after, so a slow network
  // never makes a click feel ignored. A refused change is put back.
  const decide = async (row, decision, note = row.note ?? '') => {
    const previous = { decision: row.decision, note: row.note };
    setRows((prev) => prev.map((r) => (r.accountId === row.accountId ? { ...r, decision, note } : r)));
    try {
      const res = await invoke('setDecision', { reviewId: review.id, accountId: row.accountId, decision, note });
      if (!res?.ok) throw new Error(res?.error ?? 'refused');
      setRows((prev) =>
        prev.map((r) => (r.accountId === row.accountId ? { ...r, decidedAt: res.at ?? null, decidedByName: decision ? 'you' : null } : r))
      );
    } catch (err) {
      setRows((prev) => prev.map((r) => (r.accountId === row.accountId ? { ...r, ...previous } : r)));
      setMessage(`Could not save that decision: ${err?.message ?? 'no response'}.`);
    }
  };

  const keepAllActive = async () => {
    const ids = rows.filter((r) => r.active && !r.decision && !r.admin).map((r) => r.accountId);
    if (!ids.length) return;
    setBusy(true);
    try {
      const res = await invoke('setDecisionsBulk', { reviewId: review.id, accountIds: ids, decision: 'keep' });
      if (!res?.ok) throw new Error(res?.error ?? 'refused');
      await reload();
    } catch (err) {
      setMessage(`Could not mark them: ${err?.message ?? 'no response'}.`);
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    setConfirmOpen(false);
    setBusy(true);
    try {
      const res = await invoke('completeReview', { reviewId: review.id });
      if (!res?.ok) throw new Error(res?.error ?? 'refused');
      setJustCompleted(true);
      await refresh();
      await reload();
    } catch (err) {
      setMessage(`Could not sign off: ${err?.message ?? 'no response'}.`);
    } finally {
      setBusy(false);
    }
  };

  const reopen = async () => {
    setBusy(true);
    try {
      const res = await invoke('reopenReview', { reviewId: review.id });
      if (!res?.ok) throw new Error(res?.error ?? 'refused');
      setJustCompleted(false);
      await refresh();
      await reload();
    } catch (err) {
      setMessage(`Could not reopen: ${err?.message ?? 'no response'}.`);
    } finally {
      setBusy(false);
    }
  };

  const products = review?.products ?? [];
  const productOptions = useMemo(
    () => [ALL_PRODUCTS, ...products.map((p) => ({ label: p.name, value: p.name })), { label: 'No product access', value: 'none' }],
    [products]
  );
  const groupOptions = useMemo(
    () => [ALL_GROUPS, ...(review?.groups ?? []).filter((g) => g.licensedMembers > 0).map((g) => ({ label: g.name, value: g.id }))],
    [review]
  );
  const visible = useMemo(
    () =>
      filterReviewRows(rows, {
        query,
        product: productFilter.value || null,
        group: groupFilter.value || null,
        adminOnly: viewFilter.value === 'admins',
        activity: viewFilter.value === 'active' || viewFilter.value === 'inactive' ? viewFilter.value : null,
        decision: decisionFilter.value || null,
        newOnly: viewFilter.value === 'new',
      }),
    [rows, query, productFilter, groupFilter, viewFilter, decisionFilter]
  );
  const filtering = Boolean(query || productFilter.value || groupFilter.value || viewFilter.value || decisionFilter.value);
  const liveStats = useMemo(() => decisionStats(rows, Object.fromEntries(rows.map((r) => [r.accountId, { decision: r.decision }]))), [rows]);
  const decided = liveStats.total - liveStats.undecided;
  const activeUndecided = rows.filter((r) => r.active && !r.decision && !r.admin).length;
  const changes = review?.changes;
  const hasReviews = (status?.reviews ?? []).length > 0;

  const openNote = (row) => {
    setNoteFor(row);
    setNoteText(row.note ?? '');
  };

  return (
    <Stack space="space.200">
      <HowItWorks compact={Boolean(review) && !showHow} onToggle={review ? () => setShowHow((v) => !v) : null} />

      <StartReview gate={gate} running={running} stale={stale} busy={busy} onStart={start} period={period} setPeriod={setPeriod} hasReviews={hasReviews} />

      {message && (
        <SectionMessage appearance="warning">
          <Text>{message}</Text>
        </SectionMessage>
      )}
      {loadError && (
        <SectionMessage appearance="warning">
          <Text>{loadError}</Text>
        </SectionMessage>
      )}

      {running && !stale && (
        <Stack space="space.075">
          <ProgressBar ariaLabel="Snapshot progress" value={scan.value} isIndeterminate={scan.indeterminate} />
          <Text>{phaseText(state)}. You can leave this page — the snapshot continues.</Text>
        </Stack>
      )}

      {stale && (
        <SectionMessage appearance="warning" title="This snapshot appears to be stuck">
          <Text>It has not made progress for over 20 minutes. Restarting is safe — a snapshot changes nothing.</Text>
        </SectionMessage>
      )}

      {state?.status === 'failed' && (
        <SectionMessage appearance="error" title="Snapshot failed">
          <Text>{state.error}</Text>
        </SectionMessage>
      )}

      {justCompleted && review?.status === 'complete' && showReviewPrompt({ earned: true, hidden: reviewHidden }) && (
        <ReviewPrompt onHide={hideReview} />
      )}

      {loading && !review && <Spinner />}

      {review && (
        <Stack space="space.150">
          <Stack space="space.050">
            <Inline space="space.100" alignBlock="center">
              <Heading as="h2" size="medium">
                Access review · {quarterName(review.startedAt)}
              </Heading>
              <Lozenge appearance={locked ? 'success' : 'inprogress'}>{locked ? 'Signed off' : 'Open'}</Lozenge>
            </Inline>
            <Text>
              Snapshot {fmtTime(review.generatedAt)}
              {review.startedByName ? ` by ${review.startedByName}` : ''} · {plural(review.counts?.users ?? 0, 'user', 'users')} ·{' '}
              {plural(review.counts?.admins ?? 0, 'admin', 'admins')} · {review.counts?.inactive ?? 0} with no activity in{' '}
              {review.days} days · {review.counts?.noAccess ?? 0} with no product access
            </Text>
            {locked && (
              <Text>
                Signed off {fmtTime(review.completedAt)}
                {review.completedByName ? ` by ${review.completedByName}` : ''}: {review.stats?.keep ?? 0} keep,{' '}
                {review.stats?.remove ?? 0} remove, {review.stats?.flag ?? 0} follow up, {review.stats?.undecided ?? 0} undecided.
              </Text>
            )}
          </Stack>

          {!locked && (
            <Stack space="space.075">
              <ProgressBar ariaLabel="Review progress" value={liveStats.total ? decided / liveStats.total : 0} />
              <Text>
                {decided} of {liveStats.total} decided · {liveStats.keep} keep · {liveStats.remove} remove · {liveStats.flag} follow up
                {liveStats.undecided ? ` · ${liveStats.undecided} undecided` : ''}
              </Text>
            </Stack>
          )}

          {changes && (
            <SectionMessage appearance="information" title={`Since the review signed off on ${fmtDate(review.previousCompletedAt)}`}>
              <Text>
                {plural(changes.counts.added, 'user', 'users')} added · {changes.counts.removed} gone ·{' '}
                {plural(changes.counts.becameAdmin, 'new admin', 'new admins')} · {changes.counts.gainedProducts} gained a product.
                {changes.counts.added ? ' Filter the list by "New since previous review" to see who.' : ''}
              </Text>
            </SectionMessage>
          )}

          {(review.warnings ?? []).map((w) => (
            <SectionMessage key={w} appearance="warning">
              <Text>{w}</Text>
            </SectionMessage>
          ))}

          <Inline space="space.100" alignBlock="center" shouldWrap>
            {locked ? (
              <Button onClick={reopen} isDisabled={busy || !gate.allowed}>
                Reopen review
              </Button>
            ) : (
              <>
                <Button appearance="primary" onClick={() => setConfirmOpen(true)} isDisabled={busy || !gate.allowed || !rows.length}>
                  Complete review
                </Button>
                <Button onClick={keepAllActive} isDisabled={busy || !activeUndecided || !gate.allowed}>
                  Keep all active non-admins ({activeUndecided})
                </Button>
              </>
            )}
          </Inline>

          <Inline space="space.100" alignBlock="end" shouldWrap>
            <Box xcss={{ minWidth: '200px' }}>
              <Label labelFor="search">Search</Label>
              <Textfield
                key={`search-${searchVersion}`}
                id="search"
                name="search"
                defaultValue={query}
                placeholder="Name or email"
                onChange={(e) => setQuery(e?.target?.value ?? '')}
              />
            </Box>
            <Box xcss={{ minWidth: '180px' }}>
              <Label labelFor="product-filter">Product</Label>
              <Select id="product-filter" options={productOptions} value={productFilter} onChange={(v) => setProductFilter(v ?? ALL_PRODUCTS)} />
            </Box>
            <Box xcss={{ minWidth: '200px' }}>
              <Label labelFor="group-filter">Group</Label>
              <Select id="group-filter" options={groupOptions} value={groupFilter} onChange={(v) => setGroupFilter(v ?? ALL_GROUPS)} />
            </Box>
            <Box xcss={{ minWidth: '200px' }}>
              <Label labelFor="view-filter">Show</Label>
              <Select id="view-filter" options={VIEWS} value={viewFilter} onChange={(v) => setViewFilter(v ?? ALL)} />
            </Box>
            <Box xcss={{ minWidth: '160px' }}>
              <Label labelFor="decision-filter">Decision</Label>
              <Select id="decision-filter" options={DECISION_FILTERS} value={decisionFilter} onChange={(v) => setDecisionFilter(v ?? DECISION_FILTERS[0])} />
            </Box>
            {filtering && (
              <Button
                appearance="subtle"
                onClick={() => {
                  setQuery('');
                  setSearchVersion((v) => v + 1);
                  setProductFilter(ALL_PRODUCTS);
                  setGroupFilter(ALL_GROUPS);
                  setViewFilter(ALL);
                  setDecisionFilter(DECISION_FILTERS[0]);
                }}
              >
                Clear filters
              </Button>
            )}
          </Inline>

          <Text>
            Showing {visible.length} of {rows.length}
            {review.rowCount > rows.length ? ` (the first ${rows.length} of ${review.rowCount})` : ''}
          </Text>

          <DynamicTable
            head={{
              cells: [
                { key: 'name', content: 'User', isSortable: true },
                { key: 'products', content: 'Products', isSortable: true },
                { key: 'groups', content: 'Groups' },
                { key: 'activity', content: 'Activity', isSortable: true },
                { key: 'decision', content: 'Decision', isSortable: true },
              ],
            }}
            rows={visible.map((r) => ({
              key: r.accountId,
              cells: [
                {
                  key: `name-${String(r.displayName).toLowerCase()}`,
                  content: (
                    <Stack space="space.025">
                      <Inline space="space.050" alignBlock="center" shouldWrap>
                        <Text>{r.displayName}</Text>
                        {r.admin && <Lozenge appearance="new">Admin</Lozenge>}
                        {r.newSinceLast && <Lozenge>New</Lozenge>}
                        {r.becameAdmin && <Lozenge appearance="moved">New admin</Lozenge>}
                      </Inline>
                      {r.email && <Text size="small">{r.email}</Text>}
                    </Stack>
                  ),
                },
                {
                  key: `products-${(r.products ?? []).join(',') || '~'}`,
                  content: (r.products ?? []).length ? (r.products ?? []).join(', ') : <Lozenge appearance="default">No product access</Lozenge>,
                },
                {
                  key: `groups-${(r.groupNames ?? []).length}`,
                  content: (
                    <Text size="small">
                      {(r.groupNames ?? []).slice(0, 4).join(', ')}
                      {(r.groupNames ?? []).length > 4 ? ` +${r.groupNames.length - 4} more` : ''}
                      {!(r.groupNames ?? []).length ? '—' : ''}
                    </Text>
                  ),
                },
                {
                  key: `activity-${r.active ? 'a' : `i${r.severity ?? 0}`}`,
                  content: r.active ? (
                    <Stack space="space.025">
                      <Lozenge appearance="success">Active</Lozenge>
                      {r.lastActivityAt && <Text size="small">last seen {fmtDate(r.lastActivityAt)}</Text>}
                    </Stack>
                  ) : (
                    <Lozenge appearance={String(r.bucket).startsWith('over-') ? 'removed' : 'moved'}>{r.label ?? 'No activity'}</Lozenge>
                  ),
                },
                {
                  key: `decision-${r.decision ?? 'z'}`,
                  content: locked ? (
                    <Stack space="space.025">
                      <Lozenge appearance={r.decision ? decisionLozenge[r.decision] : 'default'}>{r.decision ? DECISION_WORDS[r.decision] : 'Undecided'}</Lozenge>
                      {r.note && <Text size="small">{r.note}</Text>}
                    </Stack>
                  ) : (
                    <Stack space="space.050">
                      <Inline space="space.050" shouldWrap>
                        {DECISIONS.map((d) => (
                          <Button
                            key={d}
                            spacing="compact"
                            appearance={r.decision === d ? decisionAppearance[d] : 'default'}
                            onClick={() => decide(r, r.decision === d ? null : d)}
                            isDisabled={!gate.allowed}
                          >
                            {DECISION_WORDS[d]}
                          </Button>
                        ))}
                        <Button spacing="compact" appearance="subtle" onClick={() => openNote(r)} isDisabled={!gate.allowed}>
                          {r.note ? 'Note ✓' : 'Note'}
                        </Button>
                      </Inline>
                      {r.note && <Text size="small">{r.note}</Text>}
                    </Stack>
                  ),
                },
              ],
            }))}
            rowsPerPage={25}
            emptyView={<Text>No users match these filters.</Text>}
          />

          <Frame key={`${review.id}-${review.status}`} resource="export-frame" />
        </Stack>
      )}

      <ModalTransition>
        {confirmOpen && review && (
          <Modal onClose={() => setConfirmOpen(false)}>
            <ModalHeader>
              <ModalTitle>Sign off this review?</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.100">
                <Text>
                  {liveStats.keep} keep · {liveStats.remove} remove · {liveStats.flag} follow up
                  {liveStats.undecided ? ` · ${liveStats.undecided} undecided` : ''}.
                </Text>
                {liveStats.undecided > 0 && (
                  <Text>
                    {plural(liveStats.undecided, 'user is', 'users are')} still undecided. They will be recorded as undecided in
                    the evidence file.
                  </Text>
                )}
                <Text>
                  The review is stamped with your name and the time. Nothing on your site changes; the Remove list is yours
                  to act on. You can reopen the review later.
                </Text>
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button appearance="primary" onClick={complete}>
                Sign off
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>

      <ModalTransition>
        {noteFor && (
          <Modal onClose={() => setNoteFor(null)}>
            <ModalHeader>
              <ModalTitle>Note for {noteFor.displayName}</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.100">
                <Label labelFor="note">Why this decision, or what to follow up</Label>
                <Textfield id="note" name="note" defaultValue={noteText} placeholder="e.g. Contractor, contract ends 31 Dec" onChange={(e) => setNoteText(e?.target?.value ?? '')} />
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setNoteFor(null)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => {
                  const row = noteFor;
                  setNoteFor(null);
                  decide(row, row.decision ?? 'flag', noteText);
                }}
              >
                Save note
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Groups tab
// ---------------------------------------------------------------------------

const GROUP_VIEWS = [
  { label: 'All groups', value: '' },
  { label: 'Grant a product', value: 'grants' },
  { label: 'Admin groups', value: 'admin' },
  { label: 'Empty groups', value: 'empty' },
];

function GroupsPanel({ review }) {
  const [query, setQuery] = useState('');
  const [searchVersion, setSearchVersion] = useState(0);
  const [view, setView] = useState(GROUP_VIEWS[0]);
  const groups = review?.groups ?? [];
  const q = query.trim().toLowerCase();
  const visible = groups.filter(
    (g) =>
      (!q || g.name.toLowerCase().includes(q)) &&
      (!view.value || (view.value === 'grants' ? g.products.length > 0 : view.value === 'admin' ? g.admin : g.empty))
  );
  if (!review) return <Text>Start a review to see the site's groups.</Text>;
  return (
    <Stack space="space.150">
      <Text>
        Every group on the site at the time of the snapshot ({fmtDate(review.generatedAt)}), including empty ones. "Grants"
        is what Atlassian's application roles say the group gives access to; admin groups are recognised by name.
      </Text>
      <Inline space="space.100" alignBlock="end" shouldWrap>
        <Box xcss={{ minWidth: '220px' }}>
          <Label labelFor="group-search">Search</Label>
          <Textfield key={`gs-${searchVersion}`} id="group-search" name="group-search" defaultValue={query} placeholder="Group name" onChange={(e) => setQuery(e?.target?.value ?? '')} />
        </Box>
        <Box xcss={{ minWidth: '180px' }}>
          <Label labelFor="group-view">Show</Label>
          <Select id="group-view" options={GROUP_VIEWS} value={view} onChange={(v) => setView(v ?? GROUP_VIEWS[0])} />
        </Box>
        {(query || view.value) && (
          <Button
            appearance="subtle"
            onClick={() => {
              setQuery('');
              setSearchVersion((v) => v + 1);
              setView(GROUP_VIEWS[0]);
            }}
          >
            Clear filters
          </Button>
        )}
      </Inline>
      <Text>
        Showing {visible.length} of {groups.length} · {groups.filter((g) => g.empty).length} empty ·{' '}
        {groups.filter((g) => g.products.length).length} grant a product
      </Text>
      <DynamicTable
        head={{
          cells: [
            { key: 'name', content: 'Group', isSortable: true },
            { key: 'grants', content: 'Grants', isSortable: true },
            { key: 'members', content: 'Members', isSortable: true },
            { key: 'review', content: 'In this review', isSortable: true },
          ],
        }}
        rows={visible.map((g) => ({
          key: g.id,
          cells: [
            {
              key: `name-${g.name.toLowerCase()}`,
              content: (
                <Inline space="space.050" alignBlock="center">
                  <Text>{g.name}</Text>
                  {g.admin && <Lozenge appearance="new">Admin</Lozenge>}
                  {g.empty && <Lozenge>Empty</Lozenge>}
                </Inline>
              ),
            },
            { key: `grants-${g.products.join(',') || '~'}`, content: g.products.join(', ') || '—' },
            { key: `members-${String(g.members).padStart(6, '0')}`, content: g.members },
            { key: `review-${String(g.licensedMembers).padStart(6, '0')}`, content: g.licensedMembers },
          ],
        }))}
        rowsPerPage={25}
        defaultSortKey="review"
        defaultSortOrder="DESC"
        emptyView={<Text>No groups match.</Text>}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Past reviews tab
// ---------------------------------------------------------------------------

function PastReviewsPanel({ reviews, currentId, onOpen, onDelete, busy }) {
  if (!reviews.length) return <Text>No reviews yet.</Text>;
  return (
    <Stack space="space.150">
      <Text>The last {reviews.length} {reviews.length === 1 ? 'review' : 'reviews'}. Open one to see it in the Review tab, or download its evidence file below.</Text>
      <DynamicTable
        head={{
          cells: [
            { key: 'when', content: 'Snapshot' },
            { key: 'status', content: 'Status' },
            { key: 'users', content: 'Users' },
            { key: 'admins', content: 'Admins' },
            { key: 'inactive', content: 'No activity' },
            { key: 'decisions', content: 'Decisions' },
            { key: 'act', content: '' },
          ],
        }}
        rows={reviews.map((r) => ({
          key: r.id,
          cells: [
            { key: 'when', content: fmtTime(r.generatedAt) },
            {
              key: 'status',
              content: (
                <Stack space="space.025">
                  <Lozenge appearance={r.status === 'complete' ? 'success' : 'inprogress'}>{r.status === 'complete' ? 'Signed off' : 'Open'}</Lozenge>
                  {r.status === 'complete' && <Text size="small">{fmtDate(r.completedAt)}</Text>}
                </Stack>
              ),
            },
            { key: 'users', content: r.counts?.users ?? '—' },
            { key: 'admins', content: r.counts?.admins ?? '—' },
            { key: 'inactive', content: r.counts?.inactive ?? '—' },
            {
              key: 'decisions',
              content: r.stats ? `${r.stats.keep} keep · ${r.stats.remove} remove · ${r.stats.flag} follow up${r.stats.undecided ? ` · ${r.stats.undecided} undecided` : ''}` : '—',
            },
            {
              key: 'act',
              content: (
                <Inline space="space.050">
                  <Button spacing="compact" onClick={() => onOpen(r.id)} isDisabled={r.id === currentId}>
                    {r.id === currentId ? 'Opened' : 'Open'}
                  </Button>
                  <Button spacing="compact" appearance="subtle" onClick={() => onDelete(r)} isDisabled={busy}>
                    Delete
                  </Button>
                </Inline>
              ),
            },
          ],
        }))}
      />
      <Frame key="past-export" resource="export-frame" />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const App = () => {
  const [ctx, setCtx] = useState(null);
  const [status, setStatus] = useState(null);
  const [currentId, setCurrentId] = useState(null);
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState(null);

  useEffect(() => {
    view
      .getContext()
      .then(setCtx)
      .catch(() => setCtx({}));
  }, []);

  // Polled on a timer while a snapshot runs, so a transient failure must not
  // throw into the interval and must not blank out what is already on screen.
  const refresh = useCallback(async () => {
    try {
      const res = await invoke('getStatus');
      setStatus(res);
      return res;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The newest review is the one to show, unless the admin opened another.
  const latestId = status?.reviews?.[0]?.id ?? null;
  const finishedRun = status?.state?.status === 'complete' ? status.state.reviewId : null;
  useEffect(() => {
    if (!currentId && latestId) setCurrentId(latestId);
    if (finishedRun && finishedRun !== currentId && latestId === finishedRun) setCurrentId(finishedRun);
  }, [latestId, finishedRun, currentId]);

  const reload = useCallback(async () => {
    if (!currentId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await invoke('getReview', { reviewId: currentId });
      if (!res?.ok) throw new Error(res?.error ?? 'could not load the review');
      setData(res);
      setRows(res.rows ?? []);
    } catch (err) {
      setLoadError(`Could not load the review: ${err?.message ?? 'no response'}.`);
    } finally {
      setLoading(false);
    }
  }, [currentId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const deleteReview = async () => {
    const r = toDelete;
    setToDelete(null);
    setBusy(true);
    try {
      await invoke('deleteReview', { reviewId: r.id });
      if (r.id === currentId) {
        setCurrentId(null);
        setData(null);
        setRows([]);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const gate = licenseGate(ctx?.license, ctx?.environmentType);
  const trialEnds =
    gate.reason === 'trial' && ctx?.license?.trialEndDate
      ? new Date(ctx.license.trialEndDate).toISOString().slice(0, 10)
      : null;

  if (status?.forbidden) {
    return (
      <SectionMessage appearance="error" title="Access denied">
        <Text>{status.error}</Text>
      </SectionMessage>
    );
  }

  return (
    <Stack space="space.200">
      {!gate.allowed && (
        <SectionMessage appearance="warning" title="Subscription needed">
          <Text>{licenseMessage(gate, ctx?.license)}</Text>
        </SectionMessage>
      )}
      {trialEnds && (
        <SectionMessage appearance="information">
          <Text>Your free trial runs until {trialEnds}.</Text>
        </SectionMessage>
      )}
      <Tabs id="access-review-tabs">
        <TabList>
          <Tab>Review</Tab>
          <Tab>Groups</Tab>
          <Tab>Past reviews</Tab>
        </TabList>
        <TabPanel>
          <Box xcss={{ paddingTop: 'space.200', width: '100%' }}>
            <ReviewPanel
              gate={gate}
              status={status}
              refresh={refresh}
              review={data?.review ?? null}
              rows={rows}
              setRows={setRows}
              stats={data?.stats}
              reload={reload}
              loading={loading}
              loadError={loadError}
            />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={{ paddingTop: 'space.200', width: '100%' }}>
            <GroupsPanel review={data?.review ?? null} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={{ paddingTop: 'space.200', width: '100%' }}>
            <PastReviewsPanel reviews={status?.reviews ?? []} currentId={currentId} onOpen={setCurrentId} onDelete={setToDelete} busy={busy} />
          </Box>
        </TabPanel>
      </Tabs>

      <ModalTransition>
        {toDelete && (
          <Modal onClose={() => setToDelete(null)}>
            <ModalHeader>
              <ModalTitle appearance="danger">Delete the review from {fmtDate(toDelete.generatedAt)}?</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Text>Its snapshot, decisions and notes are removed from the app. Download the evidence file first if you need it.</Text>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setToDelete(null)}>
                Cancel
              </Button>
              <Button appearance="danger" onClick={deleteReview}>
                Delete
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
