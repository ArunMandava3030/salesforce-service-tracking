import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../../force-app/main/default/lwc/technicianCaseTrackingWorkspace/technicianCaseTrackingWorkspace.js');
const template = read('../../force-app/main/default/lwc/technicianCaseTrackingWorkspace/technicianCaseTrackingWorkspace.html');
const metadata = read('../../force-app/main/default/lwc/technicianCaseTrackingWorkspace/technicianCaseTrackingWorkspace.js-meta.xml');
const CASE_A = '500000000000001AAA';
const CASE_B = '500000000000002AAA';
const SESSION_A = 'a01000000000001AAA';
const SESSION_B = 'a01000000000002AAA';
const SESSION_C = 'a01000000000003AAA';
const NOW = 1800000000000;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function caseResult(caseId = CASE_A) {
    return { caseId, caseNumber: caseId === CASE_A ? '00001001' : '00001002', subject: 'Customer needs a technician' };
}

function session(sessionId = SESSION_A, extra = {}) {
    return {
        sessionId, sessionName: 'TS-0001', caseId: CASE_A, createdAtMs: NOW - 1000,
        expiresAtMs: NOW + 3600000, endedAtMs: null, ownerName: 'First agent',
        active: true, expired: false, canManage: true, ...extra
    };
}

function harness(overrides = {}) {
    const calls = [];
    const implementations = {
        searchCases: () => Promise.resolve([caseResult()]),
        getCase: ({ caseId }) => Promise.resolve(caseResult(caseId)),
        listCaseSessions: () => Promise.resolve({ sessions: [], nextCursor: null }),
        createCaseSession: ({ caseId }) => Promise.resolve(session(SESSION_A, { caseId })),
        linkSessionToCase: ({ caseId, sessionId }) => Promise.resolve(session(sessionId, { caseId })),
        ...overrides
    };
    const bindings = {
        LightningElement: class {},
        DEFAULT_PUBLISHER_PAGE_URL: 'https://sample.my.site.com/LiveTracking/apex/TechnicianGpsInvite',
        DEFAULT_CUSTOMER_PAGE_URL: 'https://sample.my.site.com/LiveTracking/s/',
        Date: class extends Date { static now() { return NOW; } }
    };
    for (const [name, implementation] of Object.entries(implementations)) {
        bindings[name] = args => {
            calls.push({ name, args });
            return implementation(args);
        };
    }
    const executable = source
        .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*/gm, '')
        .replace(/@api\s+/g, '')
        .replace('export default class TechnicianCaseTrackingWorkspace', 'class TechnicianCaseTrackingWorkspace');
    const Component = new Function(...Object.keys(bindings), executable + '\nreturn TechnicianCaseTrackingWorkspace;')(...Object.values(bindings));
    const component = new Component();
    return {
        component, calls,
        connect() { component.connectedCallback(); },
        search(value) { component.handleSearchChange({ target: { value } }); return component.handleSearch(); },
        inputSession(value) { component.handleExistingSessionChange({ target: { value } }); },
        open(sessionId) { component.handleOpenSession({ currentTarget: { dataset: { sessionId } } }); }
    };
}

test('a Case record context loads its Case and history without searching or starting a session', async () => {
    const h = harness();
    h.component.recordId = CASE_A;
    h.component.objectApiName = 'Case';
    assert.equal(h.calls.length, 0);
    h.connect();
    await flush();
    assert.equal(h.component.selectedCaseId, CASE_A);
    assert.equal(h.component.caseHeading, 'Case 00001001');
    assert.equal(h.component.showSearch, false);
    assert.equal(h.component.canChangeCase, false);
    assert.deepEqual(h.calls.map(call => call.name), ['getCase', 'listCaseSessions']);
    assert.deepEqual(h.calls[1].args, { caseId: CASE_A, beforeSessionId: null });
    assert.equal(h.component.showEmptyHistory, true);
    assert.equal(h.component.viewingSession, false);
});

test('home, Experience, and non-Case records offer search without automatic Apex calls', () => {
    for (const recordId of ['', undefined, '001000000000001AAA', '500-invalid']) {
        const h = harness();
        h.component.recordId = recordId;
        h.connect();
        assert.equal(h.component.showSearch, true);
        assert.equal(h.calls.length, 0);
        assert.equal(h.component.actionsDisabled, true);
    }
});

test('search is explicit, needs two characters, and opens only a returned Case choice', async () => {
    const h = harness();
    h.connect();
    await h.search('1');
    assert.equal(h.calls.length, 0);
    await h.search(' 1001 ');
    assert.deepEqual(h.calls[0], { name: 'searchCases', args: { searchTerm: '1001' } });
    assert.equal(h.component.searchResults[0].label, 'Case 00001001');
    h.component.handleSelectCase({ currentTarget: { dataset: { caseId: CASE_B } } });
    assert.equal(h.calls.length, 1);
    h.component.handleSelectCase({ currentTarget: { dataset: { caseId: CASE_A } } });
    await flush();
    assert.equal(h.component.hasCase, true);
    assert.equal(h.component.showSearch, false);
});

test('editing a query suppresses old results and old errors while a newer search runs', async () => {
    const first = deferred();
    const second = deferred();
    let count = 0;
    const h = harness({ searchCases: () => ++count === 1 ? first.promise : second.promise });
    h.connect();
    const earlier = h.search('first');
    const later = h.search('second');
    first.reject(Error('Old query failed'));
    await earlier;
    assert.equal(h.component.searchError, '');
    assert.equal(h.component.searchLoading, true);
    second.resolve([caseResult(CASE_B)]);
    await later;
    assert.equal(h.component.searchResults[0].caseId, CASE_B);
    assert.equal(h.component.searchLoading, false);
    h.component.handleSearchChange({ target: { value: 'third' } });
    assert.equal(h.component.searchResults.length, 0);
    assert.equal(h.component.searchPerformed, false);
});

test('search reports an accessible no-results state and a recoverable server error', async () => {
    const h = harness({ searchCases: ({ searchTerm }) => searchTerm === 'empty' ? Promise.resolve([]) : Promise.reject({ body: { message: 'Case access denied' } }) });
    h.connect();
    await h.search('empty');
    assert.equal(h.component.showNoResults, true);
    await h.search('error');
    assert.equal(h.component.searchError, 'Case access denied');
    assert.equal(h.component.showNoResults, false);
    assert.equal(h.component.searchLoading, false);
});

test('changing recordId ignores the previous Case response and opens only the new context', async () => {
    const pending = deferred();
    const h = harness({ getCase: ({ caseId }) => caseId === CASE_A ? pending.promise : Promise.resolve(caseResult(caseId)) });
    h.component.recordId = CASE_A;
    h.connect();
    h.component.recordId = CASE_B;
    await flush();
    pending.resolve(caseResult());
    await flush();
    assert.equal(h.component.selectedCaseId, CASE_B);
    assert.equal(h.component.caseDetails.caseId, CASE_B);
    assert.deepEqual(h.calls.filter(call => call.name === 'listCaseSessions').map(call => call.args.caseId), [CASE_B]);
    h.component.recordId = '001000000000001AAA';
    assert.equal(h.component.showSearch, true);
    assert.equal(h.component.sessions.length, 0);
    assert.equal(h.component.selectedSessionId, '');
});

test('a Case access failure does not fetch history and can be retried', async () => {
    let count = 0;
    const h = harness({ getCase: () => ++count === 1 ? Promise.reject({ body: { message: 'No Case access' } }) : Promise.resolve(caseResult()) });
    h.component.recordId = CASE_A;
    h.connect();
    await flush();
    assert.equal(h.component.caseError, 'No Case access');
    assert.equal(h.component.hasCase, false);
    assert.equal(h.calls.filter(call => call.name === 'listCaseSessions').length, 0);
    h.component.handleRetryCase();
    await flush();
    assert.equal(h.component.caseError, '');
    assert.equal(h.component.hasCase, true);
});

test('history distinguishes active, expired, and ended sessions and retains no GPS or Maps key', async () => {
    const h = harness({ listCaseSessions: () => Promise.resolve({ sessions: [
        session(SESSION_A, { browserMapsKey: 'should-not-retain', latitude: 37.7700, longitude: -122.4500, publisherUrl: 'private' }),
        session(SESSION_B, { expiresAtMs: NOW - 1, canManage: false, ownerName: 'Other agent' }),
        session(SESSION_C, { active: false, endedAtMs: NOW - 500, expiresAtMs: NOW - 1, expired: true, canManage: false })
    ], nextCursor: null }) });
    h.connect();
    await h.component.selectCase(CASE_A);
    assert.deepEqual(h.component.historyRows.map(row => row.statusLabel), ['Active', 'Expired', 'Ended']);
    assert.deepEqual(h.component.historyRows.map(row => row.openLabel), ['Open live', 'View session', 'View session']);
    assert.equal(h.component.historyRows[1].accessLabel, 'View only');
    assert.notEqual(h.component.historyRows[2].endedLabel, '—');
    for (const key of ['browserMapsKey', 'latitude', 'longitude', 'publisherUrl']) assert.equal(key in h.component.sessions[0], false);
});

test('history pagination appends, deduplicates, and stops when no older cursor is returned', async () => {
    const h = harness({ listCaseSessions: ({ beforeSessionId }) => Promise.resolve(beforeSessionId ? {
        sessions: [session(SESSION_A), session(SESSION_B)], nextCursor: null
    } : { sessions: [session()], nextCursor: SESSION_A }) });
    h.connect();
    await h.component.selectCase(CASE_A);
    assert.equal(h.component.hasMoreSessions, true);
    await h.component.loadHistory(true);
    assert.deepEqual(h.component.sessions.map(row => row.sessionId), [SESSION_A, SESSION_B]);
    assert.deepEqual(h.calls.at(-1).args, { caseId: CASE_A, beforeSessionId: SESSION_A });
    assert.equal(h.component.hasMoreSessions, false);
    const count = h.calls.length;
    await h.component.loadHistory(true);
    assert.equal(h.calls.length, count);
});

test('refresh supersedes a pending older page and a repeated cursor cannot loop forever', async () => {
    const older = deferred();
    let count = 0;
    const h = harness({ listCaseSessions: ({ beforeSessionId }) => {
        count++;
        if (count === 2) return older.promise;
        return Promise.resolve({ sessions: [session(SESSION_A)], nextCursor: beforeSessionId || SESSION_A });
    } });
    h.connect();
    await h.component.selectCase(CASE_A);
    const pending = h.component.loadHistory(true);
    await h.component.loadHistory(false);
    older.resolve({ sessions: [session(SESSION_B)], nextCursor: SESSION_B });
    await pending;
    assert.deepEqual(h.component.sessions.map(row => row.sessionId), [SESSION_A]);
    assert.equal(h.component.nextCursor, SESSION_A);
    await h.component.loadHistory(true);
    assert.equal(h.component.nextCursor, '');
});

test('history errors clear prior Case data and its open viewer, allow retry, and never cross into another Case', async () => {
    const oldPage = deferred();
    let count = 0;
    const h = harness({ listCaseSessions: ({ caseId }) => {
        if (caseId === CASE_B) return Promise.resolve({ sessions: [], nextCursor: null });
        count++;
        if (count === 1) return Promise.resolve({ sessions: [session()], nextCursor: SESSION_A });
        if (count === 2) return Promise.reject(Error('History unavailable'));
        return oldPage.promise;
    } });
    h.connect();
    await h.component.selectCase(CASE_A);
    h.open(SESSION_A);
    await h.component.loadHistory(true);
    assert.equal(h.component.historyError, 'History unavailable');
    assert.equal(h.component.sessions.length, 0);
    assert.equal(h.component.nextCursor, '');
    assert.equal(h.component.selectedSessionId, '');
    const request = h.component.loadHistory(false);
    await h.component.selectCase(CASE_B);
    oldPage.resolve({ sessions: [session(SESSION_B)], nextCursor: null });
    await request;
    assert.equal(h.component.selectedCaseId, CASE_B);
    assert.equal(h.component.historyError, '');
    assert.equal(h.component.sessions.length, 0);
});

test('opening another agent session creates a new child key and Back never ends or mutates a session', async () => {
    const h = harness({ listCaseSessions: () => Promise.resolve({ sessions: [session(), session(SESSION_B, { canManage: false })], nextCursor: null }) });
    h.connect();
    await h.component.selectCase(CASE_A);
    h.open(SESSION_A);
    assert.equal(h.component.sessionViews[0].key, CASE_A + ':' + SESSION_A);
    h.open(SESSION_B);
    assert.equal(h.component.sessionViews[0].key, CASE_A + ':' + SESSION_B);
    assert.equal(h.component.sessionViews[0].sessionId, SESSION_B);
    h.component.handleBackToHistory();
    await flush();
    assert.deepEqual(h.component.sessionViews, []);
    assert.equal(h.component.viewingSession, false);
    assert.ok(h.calls.every(call => ['getCase', 'listCaseSessions'].includes(call.name)));
});

test('create opens its returned session, refreshes history, and permits a later second session for the Case', async () => {
    let count = 0;
    const h = harness({ createCaseSession: ({ caseId }) => Promise.resolve(session(++count === 1 ? SESSION_A : SESSION_B, { caseId })) });
    h.connect();
    await h.component.selectCase(CASE_A);
    await h.component.handleCreateSession();
    await flush();
    assert.equal(h.component.selectedSessionId, SESSION_A);
    assert.match(h.component.notice, /new tracking session/);
    assert.equal(h.component.mutationBusy, false);
    h.component.handleBackToHistory();
    await flush();
    await h.component.handleCreateSession();
    assert.equal(h.component.selectedSessionId, SESSION_B);
    assert.deepEqual(h.calls.filter(call => call.name === 'createCaseSession').map(call => call.args), [{ caseId: CASE_A }, { caseId: CASE_A }]);
});

test('duplicate create clicks are blocked and a Case switch ignores a late mutation result', async () => {
    const pending = deferred();
    const h = harness({ createCaseSession: () => pending.promise });
    h.connect();
    await h.component.selectCase(CASE_A);
    const first = h.component.handleCreateSession();
    await h.component.handleCreateSession();
    assert.equal(h.calls.filter(call => call.name === 'createCaseSession').length, 1);
    await h.component.selectCase(CASE_B);
    pending.resolve(session());
    await first;
    assert.equal(h.component.selectedCaseId, CASE_B);
    assert.equal(h.component.selectedSessionId, '');
    assert.equal(h.component.notice, '');
    assert.equal(h.component.mutationBusy, false);
});

test('link validates the session ID, lets the server enforce ownership, and opens a successful link', async () => {
    let count = 0;
    const h = harness({ linkSessionToCase: ({ caseId, sessionId }) => ++count === 1
        ? Promise.reject({ body: { message: 'Only your unlinked session can be attached.' } })
        : Promise.resolve(session(sessionId, { caseId })) });
    h.connect();
    await h.component.selectCase(CASE_A);
    h.inputSession('not-a-record');
    await h.component.handleLinkSession();
    assert.match(h.component.mutationError, /15- or 18-character/);
    assert.equal(count, 0);
    h.inputSession('  ' + SESSION_A + '  ');
    await h.component.handleLinkSession();
    assert.equal(h.component.mutationError, 'Only your unlinked session can be attached.');
    assert.equal(h.component.selectedSessionId, '');
    await h.component.handleLinkSession();
    assert.equal(h.component.selectedSessionId, SESSION_A);
    assert.equal(h.component.existingSessionId, '');
    assert.match(h.component.notice, /now linked/);
    assert.deepEqual(h.calls.filter(call => call.name === 'linkSessionToCase').at(-1).args, { caseId: CASE_A, sessionId: SESSION_A });
});

test('sessionended refreshes history without navigating away from the child', async () => {
    let ended = false;
    const h = harness({ listCaseSessions: () => Promise.resolve({ sessions: [session(SESSION_A, { active: !ended, endedAtMs: ended ? NOW : null })], nextCursor: null }) });
    h.connect();
    await h.component.selectCase(CASE_A);
    h.open(SESSION_A);
    ended = true;
    h.component.handleSessionEnded();
    await flush();
    assert.equal(h.component.selectedSessionId, SESSION_A);
    assert.equal(h.component.historyRows[0].statusLabel, 'Ended');
});

test('disconnect ignores pending search, Case, history, and mutation work', async () => {
    for (const action of ['search', 'case', 'history', 'mutation']) {
        const pending = deferred();
        const overrides = action === 'search' ? { searchCases: () => pending.promise }
            : action === 'case' ? { getCase: () => pending.promise }
            : action === 'history' ? { listCaseSessions: () => pending.promise }
            : { createCaseSession: () => pending.promise };
        const h = harness(overrides);
        h.connect();
        let work;
        if (action === 'search') work = h.search('visit');
        else if (action === 'mutation') {
            await h.component.selectCase(CASE_A);
            work = h.component.handleCreateSession();
        } else work = h.component.selectCase(CASE_A);
        await flush();
        h.component.disconnectedCallback();
        const before = JSON.stringify({ caseDetails: h.component.caseDetails, sessions: h.component.sessions, selected: h.component.selectedSessionId });
        pending.resolve(action === 'search' ? [caseResult()] : action === 'case' ? caseResult()
            : action === 'history' ? { sessions: [session()], nextCursor: null } : session());
        await work;
        assert.equal(JSON.stringify({ caseDetails: h.component.caseDetails, sessions: h.component.sessions, selected: h.component.selectedSessionId }), before, action);
        assert.equal(h.component.searchLoading, false);
        assert.equal(h.component.caseLoading, false);
        assert.equal(h.component.historyLoading, false);
        assert.equal(h.component.mutationBusy, false);
    }
});

test('reconnect starts a fresh context load and cannot be overwritten by the earlier connection', async () => {
    const first = deferred();
    let count = 0;
    const h = harness({ getCase: () => ++count === 1 ? first.promise : Promise.resolve({ ...caseResult(), subject: 'Current connection' }) });
    h.component.recordId = CASE_A;
    h.connect();
    h.component.disconnectedCallback();
    h.connect();
    await flush();
    first.resolve({ ...caseResult(), subject: 'Previous connection' });
    await flush();
    assert.equal(h.component.caseSubject, 'Current connection');
    assert.equal(h.calls.filter(call => call.name === 'listCaseSessions').length, 1);
});

test('foreign Case session responses are rejected before a child or history row is created', async () => {
    const h = harness({
        listCaseSessions: () => Promise.resolve({ sessions: [session(SESSION_A, { caseId: CASE_B })], nextCursor: null }),
        createCaseSession: () => Promise.resolve(session(SESSION_A, { caseId: CASE_B }))
    });
    h.connect();
    await h.component.selectCase(CASE_A);
    assert.match(h.component.historyError, /did not match/);
    assert.equal(h.component.sessions.length, 0);
    await h.component.handleCreateSession();
    assert.match(h.component.mutationError, /did not match/);
    assert.equal(h.component.selectedSessionId, '');
});

test('the template uses an accessible Case search, metadata history, and a keyed session child', () => {
    assert.doesNotMatch(template, /lightning-record-picker/);
    assert.match(template, /type="search" label="Find a Case"/);
    assert.match(template, /<form\b[^>]*onsubmit=\{handleSearch\}/);
    assert.match(template, /<button\b[^>]*data-case-id=\{result.caseId\}[^>]*onclick=\{handleSelectCase\}/);
    assert.match(template, /<caption\b/);
    assert.match(template, /<th scope="row">/);
    assert.match(template, /<template for:each=\{sessionViews\} for:item="view">\s*<c-technician-live-tracking key=\{view.key\} tracking-session-id=\{view.sessionId\} case-id=\{view.caseId\}/);
    assert.match(template, /onsessionended=\{handleSessionEnded\}/);
    assert.match(template, /public-publisher-page-url=\{publicPublisherPageUrl\} public-customer-page-url=\{publicCustomerPageUrl\}/);
    assert.doesNotMatch(source, /localStorage|sessionStorage|geolocation|endSession|stopPublishing/);
    assert.match(metadata, /<apiVersion>62.0<\/apiVersion>/);
    assert.match(metadata, /<isExposed>false<\/isExposed>/);
});
