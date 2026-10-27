import { LightningElement, api } from 'lwc';
import searchCases from '@salesforce/apex/TechnicianCaseTrackingController.searchCases';
import getCase from '@salesforce/apex/TechnicianCaseTrackingController.getCase';
import createCaseSession from '@salesforce/apex/TechnicianCaseTrackingController.createCaseSession';
import linkSessionToCase from '@salesforce/apex/TechnicianCaseTrackingController.linkSessionToCase';
import listCaseSessions from '@salesforce/apex/TechnicianCaseTrackingController.listCaseSessions';
import { DEFAULT_PUBLISHER_PAGE_URL, DEFAULT_CUSTOMER_PAGE_URL } from 'c/trackingInvitation';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
const validCaseId = value => validId(value) && value.startsWith('500');
const sameId = (left, right) => Boolean(left && right && left.slice(0, 15) === right.slice(0, 15));
const messageFor = (error, fallback) => error?.body?.message || error?.message || fallback;
const timestamp = value => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
};
const dateLabel = value => {
    const time = timestamp(value);
    return time && Number.isFinite(new Date(time).getTime()) ? new Date(time).toLocaleString() : '—';
};

function historyEntry(value, caseId) {
    if (!value || !validId(value.sessionId) || (value.caseId && !sameId(value.caseId, caseId))) {
        throw new Error('The session response did not match the selected Case. Refresh the session history.');
    }
    // History deliberately retains only session metadata, not GPS, links, or a Maps key.
    return {
        sessionId: value.sessionId,
        sessionName: value.sessionName || 'Tracking session',
        caseId: caseId,
        createdAtMs: timestamp(value.createdAtMs),
        endedAtMs: timestamp(value.endedAtMs),
        expiresAtMs: timestamp(value.expiresAtMs),
        active: value.active === true,
        expired: value.expired === true,
        ownerName: value.ownerName || '—',
        canManage: value.canManage === true
    };
}

export default class TechnicianCaseTrackingWorkspace extends LightningElement {
    @api publicPublisherPageUrl = DEFAULT_PUBLISHER_PAGE_URL;
    @api publicCustomerPageUrl = DEFAULT_CUSTOMER_PAGE_URL;
    _recordId = '';
    _objectApiName = '';
    connected = false;
    epoch = 0;
    contextApplied = '';
    searchRequest = 0;
    historyRequest = 0;
    searchTerm = '';
    searchResults = [];
    searchPerformed = false;
    searchLoading = false;
    searchError = '';
    selectedCaseId = '';
    caseDetails;
    caseLoading = false;
    caseError = '';
    sessions = [];
    nextCursor = '';
    historyLoading = false;
    historyError = '';
    selectedSessionId = '';
    existingSessionId = '';
    mutationBusy = false;
    mutationError = '';
    notice = '';

    @api get recordId() { return this._recordId; }
    set recordId(value) {
        this._recordId = typeof value === 'string' ? value.trim() : '';
        this.syncRecordContext();
    }
    @api get objectApiName() { return this._objectApiName; }
    set objectApiName(value) {
        this._objectApiName = typeof value === 'string' ? value : '';
        this.syncRecordContext();
    }

    connectedCallback() {
        this.connected = true;
        this.contextApplied = '';
        if (this.contextCaseId) this.syncRecordContext();
        else if (this.selectedCaseId) this.selectCase(this.selectedCaseId);
    }

    disconnectedCallback() {
        this.connected = false;
        this.epoch += 1;
        this.searchRequest += 1;
        this.historyRequest += 1;
        this.searchLoading = false;
        this.caseLoading = false;
        this.historyLoading = false;
        this.mutationBusy = false;
    }

    get contextCaseId() { return validCaseId(this._recordId) ? this._recordId : ''; }
    get hasCase() { return Boolean(this.caseDetails); }
    get showSearch() { return !this.contextCaseId && !this.selectedCaseId; }
    get canChangeCase() { return !this.contextCaseId; }
    get hasSearchResults() { return this.searchResults.length > 0; }
    get searchDisabled() { return this.searchLoading || this.searchTerm.trim().length < 2; }
    get showNoResults() { return this.searchPerformed && !this.searchLoading && !this.hasSearchResults && !this.searchError; }
    get caseHeading() { return this.caseDetails ? 'Case ' + this.caseDetails.caseNumber : 'Case tracking'; }
    get caseSubject() { return this.caseDetails?.subject || 'No subject'; }
    get actionsDisabled() { return !this.hasCase || this.caseLoading || this.mutationBusy; }
    get linkDisabled() { return this.actionsDisabled || !validId(this.existingSessionId.trim()); }
    get hasSessions() { return this.sessions.length > 0; }
    get showEmptyHistory() { return !this.hasSessions && !this.historyLoading && !this.historyError; }
    get hasMoreSessions() { return Boolean(this.nextCursor); }
    get viewingSession() { return Boolean(this.selectedSessionId); }
    get selectedSessionName() {
        return this.sessions.find(row => sameId(row.sessionId, this.selectedSessionId))?.sessionName || 'Tracking session';
    }
    get sessionViews() {
        return this.selectedSessionId && this.selectedCaseId ? [{
            key: this.selectedCaseId + ':' + this.selectedSessionId,
            sessionId: this.selectedSessionId,
            caseId: this.selectedCaseId
        }] : [];
    }
    get historyRows() {
        const now = Date.now();
        return this.sessions.map(row => {
            const ended = Boolean(row.endedAtMs);
            const expired = !ended && (row.expired || (row.active && row.expiresAtMs && row.expiresAtMs <= now));
            const live = !ended && row.active && !expired;
            return {
                ...row,
                createdLabel: dateLabel(row.createdAtMs),
                endedLabel: dateLabel(row.endedAtMs),
                expiresLabel: dateLabel(row.expiresAtMs),
                statusLabel: expired ? 'Expired' : live ? 'Active' : 'Ended',
                statusClass: live ? 'status active' : 'status',
                openLabel: live ? 'Open live' : 'View session',
                accessLabel: row.canManage ? 'You manage this session' : 'View only'
            };
        });
    }

    current(epoch, caseId) {
        return this.connected && this.epoch === epoch && sameId(this.selectedCaseId, caseId);
    }

    syncRecordContext() {
        if (!this.connected) return;
        const caseId = this.contextCaseId;
        if (caseId && !sameId(caseId, this.contextApplied)) {
            this.contextApplied = caseId;
            this.selectCase(caseId);
        } else if (!caseId && this.contextApplied) {
            this.contextApplied = '';
            this.resetCase();
        }
    }

    resetCase() {
        this.epoch += 1;
        this.historyRequest += 1;
        this.searchRequest += 1;
        this.selectedCaseId = '';
        this.caseDetails = undefined;
        this.caseLoading = false;
        this.caseError = '';
        this.sessions = [];
        this.nextCursor = '';
        this.historyLoading = false;
        this.historyError = '';
        this.selectedSessionId = '';
        this.existingSessionId = '';
        this.mutationBusy = false;
        this.mutationError = '';
        this.notice = '';
        this.searchResults = [];
        this.searchPerformed = false;
        this.searchLoading = false;
        this.searchError = '';
    }

    handleSearchChange(event) {
        this.searchTerm = event.target.value || '';
        this.searchRequest += 1;
        this.searchResults = [];
        this.searchPerformed = false;
        this.searchLoading = false;
        this.searchError = '';
    }

    async handleSearch(event) {
        event?.preventDefault();
        if (!this.connected || !this.showSearch || this.searchDisabled) return;
        const request = ++this.searchRequest;
        const epoch = this.epoch;
        this.searchLoading = true;
        this.searchError = '';
        this.searchPerformed = false;
        this.searchResults = [];
        try {
            const results = await searchCases({ searchTerm: this.searchTerm.trim() });
            if (!this.connected || epoch !== this.epoch || request !== this.searchRequest) return;
            if (!Array.isArray(results)) throw new Error('Case search returned an invalid response. Try again.');
            this.searchResults = results.filter(row => validCaseId(row.caseId)).map(row => ({
                caseId: row.caseId,
                label: 'Case ' + row.caseNumber,
                subject: row.subject || 'No subject'
            }));
            this.searchPerformed = true;
        } catch (error) {
            if (this.connected && epoch === this.epoch && request === this.searchRequest) {
                this.searchError = messageFor(error, 'Cases could not be searched. Try again.');
            }
        } finally {
            if (this.connected && epoch === this.epoch && request === this.searchRequest) this.searchLoading = false;
        }
    }

    handleSelectCase(event) {
        const caseId = event.currentTarget.dataset.caseId;
        if (this.searchResults.some(row => sameId(row.caseId, caseId))) this.selectCase(caseId);
    }

    async selectCase(caseId) {
        if (!this.connected || !validCaseId(caseId)) return;
        this.resetCase();
        this.selectedCaseId = caseId;
        this.caseLoading = true;
        const epoch = this.epoch;
        try {
            const result = await getCase({ caseId });
            if (!this.current(epoch, caseId)) return;
            if (!result || !validCaseId(result.caseId) || !sameId(result.caseId, caseId)) {
                throw new Error('The selected Case could not be loaded. Select the Case again.');
            }
            this.caseDetails = { caseId: result.caseId, caseNumber: result.caseNumber, subject: result.subject };
            this.selectedCaseId = result.caseId;
            this.caseLoading = false;
            await this.loadHistory(false);
        } catch (error) {
            if (this.current(epoch, caseId)) this.caseError = messageFor(error, 'The Case could not be opened. Check your Case access.');
        } finally {
            if (this.current(epoch, caseId)) this.caseLoading = false;
        }
    }

    handleRetryCase() { this.selectCase(this.selectedCaseId); }
    handleChangeCase() { if (this.canChangeCase && !this.mutationBusy) this.resetCase(); }
    handleRefreshHistory() { this.loadHistory(false); }
    handleLoadMore() { this.loadHistory(true); }

    async loadHistory(append) {
        if (!this.connected || !this.hasCase || (append && (!this.nextCursor || this.historyLoading))) return;
        const epoch = this.epoch;
        const caseId = this.selectedCaseId;
        const request = ++this.historyRequest;
        const cursor = append ? this.nextCursor : null;
        this.historyLoading = true;
        this.historyError = '';
        try {
            const result = await listCaseSessions({ caseId, beforeSessionId: cursor });
            if (!this.current(epoch, caseId) || request !== this.historyRequest) return;
            if (!result || !Array.isArray(result.sessions) || (result.nextCursor && !validId(result.nextCursor))) {
                throw new Error('Session history returned an invalid response. Refresh the history.');
            }
            const incoming = result.sessions.map(row => historyEntry(row, caseId));
            const rows = append ? [...this.sessions, ...incoming] : incoming;
            const seen = new Set();
            this.sessions = rows.filter(row => {
                const key = row.sessionId.slice(0, 15);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            this.nextCursor = result.nextCursor && !sameId(result.nextCursor, cursor) ? result.nextCursor : '';
        } catch (error) {
            if (this.current(epoch, caseId) && request === this.historyRequest) {
                this.sessions = [];
                this.nextCursor = '';
                this.selectedSessionId = '';
                this.historyError = messageFor(error, 'Session history could not be loaded. Try refreshing it.');
            }
        } finally {
            if (this.current(epoch, caseId) && request === this.historyRequest) this.historyLoading = false;
        }
    }

    handleExistingSessionChange(event) {
        this.existingSessionId = event.target.value || '';
        this.mutationError = '';
    }
    handleCreateSession() { return this.changeSession(false); }
    handleLinkSession() { return this.changeSession(true); }

    async changeSession(linkExisting) {
        if (!this.connected || this.actionsDisabled) return;
        const sessionId = this.existingSessionId.trim();
        if (linkExisting && !validId(sessionId)) {
            this.mutationError = 'Enter a valid 15- or 18-character tracking session ID.';
            return;
        }
        const epoch = this.epoch;
        const caseId = this.selectedCaseId;
        this.mutationBusy = true;
        this.mutationError = '';
        this.notice = '';
        try {
            const result = linkExisting ? await linkSessionToCase({ caseId, sessionId }) : await createCaseSession({ caseId });
            if (!this.current(epoch, caseId)) return;
            const entry = historyEntry(result, caseId);
            this.sessions = [entry, ...this.sessions.filter(row => !sameId(row.sessionId, entry.sessionId))];
            this.selectedSessionId = entry.sessionId;
            this.existingSessionId = '';
            this.notice = linkExisting ? 'The existing session is now linked to this Case.' : 'A new tracking session was created for this Case.';
            this.loadHistory(false);
        } catch (error) {
            if (this.current(epoch, caseId)) this.mutationError = messageFor(error, 'The tracking session could not be updated. Try again.');
        } finally {
            if (this.current(epoch, caseId)) this.mutationBusy = false;
        }
    }

    handleOpenSession(event) {
        const sessionId = event.currentTarget.dataset.sessionId;
        const row = this.sessions.find(value => sameId(value.sessionId, sessionId));
        if (row) {
            this.selectedSessionId = row.sessionId;
            this.notice = '';
        }
    }

    handleBackToHistory() {
        this.selectedSessionId = '';
        this.notice = '';
        this.loadHistory(false);
    }

    handleSessionEnded() { this.loadHistory(false); }
}
