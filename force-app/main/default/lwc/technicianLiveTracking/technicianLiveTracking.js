import { LightningElement, api } from 'lwc';
import USER_ID from '@salesforce/user/Id';
import createSession from '@salesforce/apex/TechnicianLiveTrackingController.createSession';
import getSession from '@salesforce/apex/TechnicianLiveTrackingController.getSession';
import getCaseSession from '@salesforce/apex/TechnicianCaseTrackingController.getCaseSession';
import endSession from '@salesforce/apex/TechnicianLiveTrackingController.endSession';
import issuePublisherLink from '@salesforce/apex/TechnicianLiveTrackingController.issuePublisherLink';
import revokePublisherLink from '@salesforce/apex/TechnicianLiveTrackingController.revokePublisherLink';
import configureMaps from '@salesforce/apex/TechnicianLiveTrackingController.configureMaps';
import issueCustomerLink from '@salesforce/apex/TechnicianLiveTrackingController.issueCustomerLink';
import revokeCustomerLink from '@salesforce/apex/TechnicianLiveTrackingController.revokeCustomerLink';
import { DEFAULT_PUBLISHER_PAGE_URL, DEFAULT_CUSTOMER_PAGE_URL, normalizePublisherPageUrl, buildInvitationUrl, resolveLiveMapPageUrl, normalizeCustomerPageUrl, buildCustomerUrl } from 'c/trackingInvitation';

const SCOPE = 'technician-live-tracking-poc';
const BRIDGE_VERSION = '2026-10-08.live2';
const CUSTOMER = { lat: 37.7749, lng: -122.4194 };
const POLL_MS = 3000;
const STALE_MS = 15000;

// Apex can serialize high-precision Decimals as strings. Missing values must stay missing.
function numericValue(value) {
    if (typeof value === 'string') {
        const text = value.trim();
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
        value = Number(text);
    }
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export default class TechnicianLiveTracking extends LightningElement {
    @api caseId;
    @api trackingSessionId;
    @api publicPublisherPageUrl = DEFAULT_PUBLISHER_PAGE_URL;
    @api publicCustomerPageUrl = DEFAULT_CUSTOMER_PAGE_URL;
    customerUrl = '';
    customerError = '';
    customerNotice = '';
    customerBusy = false;
    route;
    session;
    invitationUrl = '';
    invitationError = '';
    invitationNotice = '';
    invitationBusy = false;
    apiKey = '';
    sessionError = '';
    mapError = '';
    notice = '';
    busy = false;
    isLoading = false;
    mapReady = false;
    frameConnected = false;
    followTechnician = true;
    frameUrl;
    now = Date.now();
    connected = false;
    sessionEpoch = 0;
    pollTimer;
    clockTimer;
    loadTimer;
    channel;
    frameOrigin;
    messageHandler;
    lastMapSample;
    renderedMapSample;
    lastMapStatus;
    lastReadAt;
    cancelCaseRead;

    get isCaseContext() { return Boolean(this.caseId); }
    get showCreateSession() { return !this.isCaseContext; }
    get canManageSession() { return this.hasSession && (this.session.canManage === true || (!this.isCaseContext && this.session.canManage !== false)); }
    get isReadOnly() { return this.hasSession && !this.canManageSession; }
    get waitingForOwnerKey() { return this.isReadOnly && this.isActive && !this.apiKey; }
    get isHistorySession() { return this.isCaseContext && this.hasSession && !this.isActive; }
    get showKeyControls() { return this.canManageSession && (!this.isCaseContext || this.isActive); }
    get showViewerLoad() { return this.isReadOnly && this.isActive && Boolean(this.apiKey); }
    get mapPlaceholder() {
        if (this.isHistorySession) return 'This session has ended. Its last saved GPS details remain above.';
        if (this.isReadOnly) return this.apiKey ? 'Select Load live map to watch this session.' : 'Waiting for the session owner to configure the map.';
        return 'Enter your API key and select Load live map.';
    }
    get storageKey() { return 'technicianTrackingPoc.liveSession.' + USER_ID; }
    get hasSession() { return Boolean(this.session); }
    get sessionId() { return this.session?.sessionId || ''; }
    get publisherUrl() { return this.session?.publisherUrl || ''; }
    get customerLabel() { return '37.7749, -122.4194'; }
    get isActive() {
        return Boolean(this.session?.active && this.session.expiresAtMs > this.now);
    }
    get createDisabled() { return this.isCaseContext || this.busy || this.invitationBusy || this.customerBusy || this.isActive; }
    get stopDisabled() { return !this.canManageSession || this.busy || this.invitationBusy || this.customerBusy || !this.isActive; }
    get invitationDisabled() { return !this.canManageSession || this.busy || this.invitationBusy || this.customerBusy || !this.isActive; }
    get hasCustomerUrl() { return Boolean(this.customerUrl); }
    get customerButtonLabel() { return this.session?.customerInviteActive ? 'Replace customer link' : 'Create customer link'; }
    get revokeCustomerDisabled() { return this.invitationDisabled || !this.session?.customerInviteActive; }
    get revokeInvitationDisabled() { return this.invitationDisabled || !this.session?.publisherInviteActive; }
    get hasInvitationUrl() { return Boolean(this.invitationUrl); }
    get invitationButtonLabel() {
        return this.session?.publisherInviteActive ? 'Replace invitation link' : 'Create invitation link';
    }
    get invitationStatus() {
        if (!this.isActive) return 'The session has ended or expired. Invitations cannot send GPS.';
        return this.session?.publisherInviteActive
            ? 'An invitation is active. Replacing it immediately disables the previous link.'
            : 'Create an invitation for the person who will share their GPS.';
    }
    get loadDisabled() { return (this.isCaseContext && !this.isActive) || !this.apiKey.trim() || !this.session?.mapPageUrl || this.isLoading || this.busy || this.invitationBusy || this.customerBusy; }
    get mapKeyHelp() {
        try {
            const url = resolveLiveMapPageUrl(this.session?.mapPageUrl, this.publicPublisherPageUrl, window.location.origin);
            return 'Allow ' + new URL(url).origin + '/* and your public site in the browser key restrictions. Load live map saves this key for this session’s phone and customer maps.';
        } catch (error) {
            return 'Enter one browser-restricted key enabled for Maps JavaScript API and Routes API. It is saved for this session’s maps.';
        }
    }
    get mapControlsDisabled() { return !this.mapReady; }
    get locateDisabled() { return !this.mapReady || !this.hasPosition; }
    get hasPosition() {
        return Number.isFinite(this.session?.latitude) && Number.isFinite(this.session?.longitude) &&
            Math.abs(this.session.latitude) <= 90 && Math.abs(this.session.longitude) <= 180;
    }
    get waitingForPhone() { return this.isActive && !this.hasPosition; }
    get positionSample() {
        if (!this.hasPosition || !Number.isFinite(this.session.capturedAtMs) || this.session.capturedAtMs <= 0) return '';
        return [this.session.capturedAtMs, this.session.latitude, this.session.longitude].join('/');
    }
    get capturedLabel() {
        return this.session?.capturedAtMs ? new Date(this.session.capturedAtMs).toLocaleTimeString() : 'No GPS fix yet';
    }
    get lastReadLabel() {
        return this.lastReadAt ? new Date(this.lastReadAt).toLocaleTimeString() : 'Not checked yet';
    }
    get mapPositionLabel() {
        if (!this.hasPosition) return 'No technician position received for this session yet.';
        if (this.isHistorySession) return 'Session ended. Showing its last saved GPS details; live tracking has stopped.';
        if (!this.mapReady) return 'Phone position received. Load the live map to see the technician.';
        if (!this.positionSample || this.renderedMapSample !== this.positionSample) return 'Waiting for the map to apply the latest phone position...';
        if (!this.isActive || this.stale) return 'Map updated with the last saved phone position. This location is not current.';
        return 'Map updated with the latest phone position. Blue T is your technician.';
    }
    get stale() {
        return this.hasPosition && (
            this.now - this.session.capturedAtMs > STALE_MS ||
            this.now - this.session.receivedAtMs > STALE_MS
        );
    }
    get statusLabel() {
        if (!this.session) return 'Create a tracking session';
        if (this.session.endedAtMs) return 'Sharing stopped';
        if (this.session.expired || this.now >= this.session.expiresAtMs) return 'Session expired';
        if (!this.session.active) return 'Sharing stopped';
        if (!this.hasPosition) return 'Waiting for phone GPS';
        return this.stale ? 'GPS update is stale' : 'Receiving phone GPS';
    }
    get coordinatesLabel() {
        return this.hasPosition
            ? this.session.latitude.toFixed(6) + ', ' + this.session.longitude.toFixed(6)
            : 'Waiting for the first GPS fix';
    }
    get accuracyLabel() {
        return Number.isFinite(this.session?.accuracy) ? Math.round(this.session.accuracy) + ' m' : 'Not available';
    }
    get updatedLabel() {
        if (!this.session?.receivedAtMs) return 'No updates yet';
        return new Date(this.session.receivedAtMs).toLocaleTimeString() + ' (' +
            Math.max(0, Math.floor((this.now - this.session.receivedAtMs) / 1000)) + ' sec ago)';
    }
    get etaLabel() {
        if (!this.hasPosition) return 'Waiting for GPS';
        if (!this.isActive || this.stale) return 'ETA paused';
        if (this.route?.state === 'ready' && Number.isFinite(this.route.durationSeconds) && this.route.durationSeconds >= 0 &&
            Number.isFinite(this.route.computedAtMs) && this.now - this.route.computedAtMs < 90000) {
            return Math.max(1, Math.ceil(this.route.durationSeconds / 60)) + ' min';
        }
        if (!this.mapReady) return 'Load map for ETA';
        return this.route?.state === 'unavailable' ? 'ETA unavailable' : 'Calculating route…';
    }

    connectedCallback() {
        this.connected = true;
        this.messageHandler = this.handleFrameMessage.bind(this);
        window.addEventListener('message', this.messageHandler);
        this.clockTimer = window.setInterval(() => {
            this.now = Date.now();
            this.publishMapStatus();
        }, 1000);
        this.busy = false;
        if (this.isCaseContext) {
            if (this.trackingSessionId) this.restoreSession(this.trackingSessionId);
            return;
        }
        let sessionId = this.sessionId;
        try {
            sessionId = window.sessionStorage.getItem(this.storageKey) || sessionId;
        } catch (error) {
            // Storage can be unavailable; the in-memory session can still reconnect.
        }
        if (sessionId) this.restoreSession(sessionId);
    }

    disconnectedCallback() {
        this.connected = false;
        this.invitationUrl = '';
        this.invitationBusy = false;
        this.customerUrl = '';
        this.customerBusy = false;
        this.sessionEpoch += 1;
        if (this.cancelCaseRead) this.cancelCaseRead();
        window.clearTimeout(this.pollTimer);
        window.clearInterval(this.clockTimer);
        window.removeEventListener('message', this.messageHandler);
        this.clearMap();
    }

    async restoreSession(sessionId) {
        const epoch = ++this.sessionEpoch;
        this.busy = true;
        try {
            const snapshot = await this.readSession(sessionId);
            if (!this.connected || epoch !== this.sessionEpoch) return;
            this.applySnapshot(snapshot);
            this.schedulePoll();
        } catch (error) {
            if (this.connected && epoch === this.sessionEpoch) {
                this.rememberSession(null);
                if (this.isCaseContext) this.clearCaseData();
                this.sessionError = this.errorText(error);
            }
        } finally {
            if (this.connected && epoch === this.sessionEpoch) {
                this.busy = false;
                this.maybeLoadCaseMap();
            }
        }
    }

    readSession(sessionId) {
        if (!this.isCaseContext) return getSession({ sessionId });
        if (this.cancelCaseRead) this.cancelCaseRead();
        const caseId = this.caseId;
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const finish = (error, snapshot) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                this.cancelCaseRead = undefined;
                if (error) reject(error);
                else if (snapshot?.caseId !== caseId || snapshot?.sessionId !== sessionId) reject(new Error('This tracking session does not belong to the selected Case.'));
                else resolve(snapshot);
            };
            this.cancelCaseRead = () => finish(new Error('Session request cancelled.'));
            timer = window.setTimeout(() => finish(new Error('The Case tracking request timed out. Retry to reconnect.')), 22000);
            Promise.resolve().then(() => getCaseSession({ caseId, sessionId })).then(
                snapshot => finish(null, snapshot), error => finish(error)
            );
        });
    }

    clearCaseData() {
        this.clearMap();
        this.session = undefined;
        this.apiKey = '';
        this.invitationUrl = '';
        this.customerUrl = '';
        this.lastReadAt = undefined;
        window.clearTimeout(this.pollTimer);
    }

    handleRetrySession() {
        if (!this.isCaseContext || this.busy) return;
        this.sessionError = '';
        return this.restoreSession(this.trackingSessionId);
    }

    maybeLoadCaseMap() {
        if (this.isCaseContext && this.isActive && this.apiKey && !this.frameUrl && !this.mapError && !this.loadDisabled) {
            this.handleLoadMap();
        }
    }

    async handleCreateSession() {
        if (this.createDisabled) return;
        const epoch = ++this.sessionEpoch;
        window.clearTimeout(this.pollTimer);
        this.busy = true;
        this.sessionError = '';
        this.notice = '';
        this.invitationUrl = '';
        this.invitationError = '';
        this.invitationNotice = '';
        this.customerUrl = '';
        this.customerError = '';
        this.customerNotice = '';
        this.clearMap();
        try {
            const snapshot = await createSession();
            if (!this.connected || epoch !== this.sessionEpoch) return;
            this.applySnapshot(snapshot);
            this.rememberSession(snapshot.sessionId);
            this.schedulePoll();
        } catch (error) {
            if (this.connected && epoch === this.sessionEpoch) this.sessionError = this.errorText(error);
        } finally {
            if (this.connected && epoch === this.sessionEpoch) this.busy = false;
        }
    }

    async handleEndSession() {
        if (this.stopDisabled) return;
        const epoch = ++this.sessionEpoch;
        window.clearTimeout(this.pollTimer);
        this.busy = true;
        this.sessionError = '';
        try {
            const snapshot = await endSession({ sessionId: this.sessionId });
            if (!this.connected || epoch !== this.sessionEpoch) return;
            this.applySnapshot(snapshot);
            this.rememberSession(null);
            this.invitationUrl = '';
            this.customerUrl = '';
            if (this.isCaseContext) this.dispatchEvent(new CustomEvent('sessionended'));
        } catch (error) {
            if (this.connected && epoch === this.sessionEpoch) {
                this.sessionError = this.errorText(error);
                this.schedulePoll();
            }
        } finally {
            if (this.connected && epoch === this.sessionEpoch) this.busy = false;
        }
    }

    schedulePoll() {
        window.clearTimeout(this.pollTimer);
        if (this.connected && this.isActive) {
            this.pollTimer = window.setTimeout(() => this.pollSession(), POLL_MS);
        }
    }

    async pollSession() {
        const epoch = this.sessionEpoch;
        const sessionId = this.sessionId;
        if (!this.connected || !this.isActive || !sessionId) return;
        try {
            const snapshot = await this.readSession(sessionId);
            if (!this.connected || epoch !== this.sessionEpoch) return;
            this.sessionError = '';
            this.applySnapshot(snapshot);
        } catch (error) {
            if (!this.connected || epoch !== this.sessionEpoch) return;
            if (this.isCaseContext) this.clearCaseData();
            this.sessionError = 'Could not refresh the location. ' + this.errorText(error);
        }
        if (this.connected && epoch === this.sessionEpoch) {
            this.schedulePoll();
            this.maybeLoadCaseMap();
        }
    }

    applySnapshot(snapshot) {
        this.session = {
            ...snapshot,
            latitude: numericValue(snapshot.latitude),
            longitude: numericValue(snapshot.longitude),
            accuracy: numericValue(snapshot.accuracy),
            capturedAtMs: numericValue(snapshot.capturedAtMs),
            receivedAtMs: numericValue(snapshot.receivedAtMs),
            expiresAtMs: numericValue(snapshot.expiresAtMs)
        };
        this.now = Date.now();
        if (this.isReadOnly) {
            const key = this.isActive ? snapshot.browserMapsKey || '' : '';
            if (key !== this.apiKey) this.clearMap();
            this.apiKey = key;
        } else if (!this.apiKey && snapshot.browserMapsKey) this.apiKey = snapshot.browserMapsKey;
        if (!this.isActive || (snapshot.customerInviteActive === false && !this.customerBusy)) this.customerUrl = '';
        if (!this.isActive || (snapshot.publisherInviteActive === false && !this.invitationBusy)) {
            this.invitationUrl = '';
        }
        this.lastReadAt = this.now;
        this.publishLatestPosition();
        this.publishMapStatus();
    }

    rememberSession(sessionId) {
        if (this.isCaseContext) return;
        try {
            if (sessionId) window.sessionStorage.setItem(this.storageKey, sessionId);
            else window.sessionStorage.removeItem(this.storageKey);
        } catch (error) {
            // Persistence is optional; it is not the GPS transport.
        }
    }

    async handleCopyLink() {
        if (!this.canManageSession) return;
        try {
            await navigator.clipboard.writeText(this.publisherUrl);
            this.notice = 'Phone link copied. Open it in your phone browser and sign in with the same Salesforce user.';
        } catch (error) {
            this.notice = 'Select and copy the phone link from the field above.';
        }
    }

    async handleCreateInvitation() {
        if (this.invitationDisabled) return;
        let pageUrl;
        try {
            pageUrl = normalizePublisherPageUrl(this.publicPublisherPageUrl);
        } catch (error) {
            this.invitationError = 'Set the public GPS publisher page URL in App Builder or Experience Builder before creating an invitation.';
            return;
        }
        const epoch = ++this.sessionEpoch;
        window.clearTimeout(this.pollTimer);
        this.invitationBusy = true;
        this.invitationUrl = '';
        this.invitationError = '';
        this.invitationNotice = '';
        try {
            const grant = await issuePublisherLink({ sessionId: this.sessionId });
            if (!this.connected || epoch !== this.sessionEpoch) return;
            this.invitationUrl = buildInvitationUrl(pageUrl, grant.token);
            this.session = { ...this.session, publisherInviteActive: true };
            this.invitationNotice = 'Invitation created. Copy the complete link and send it to the person sharing GPS. It expires with this session.';
        } catch (error) {
            if (this.connected && epoch === this.sessionEpoch) this.invitationError = this.errorText(error);
        } finally {
            if (this.connected && epoch === this.sessionEpoch) {
                this.invitationBusy = false;
                this.schedulePoll();
            }
        }
    }

    async handleRevokeInvitation() {
        if (this.revokeInvitationDisabled) return;
        const epoch = ++this.sessionEpoch;
        window.clearTimeout(this.pollTimer);
        this.invitationBusy = true;
        this.invitationError = '';
        this.invitationNotice = '';
        try {
            const snapshot = await revokePublisherLink({ sessionId: this.sessionId });
            if (!this.connected || epoch !== this.sessionEpoch) return;
            this.applySnapshot(snapshot);
            this.invitationUrl = '';
            this.invitationNotice = 'Invitation revoked. Its recipient can no longer send GPS. The map retains the last saved position.';
        } catch (error) {
            if (this.connected && epoch === this.sessionEpoch) this.invitationError = this.errorText(error);
        } finally {
            if (this.connected && epoch === this.sessionEpoch) {
                this.invitationBusy = false;
                this.schedulePoll();
            }
        }
    }

    async handleCopyInvitation() {
        if (!this.invitationUrl || !this.isActive) return;
        try {
            await navigator.clipboard.writeText(this.invitationUrl);
            this.invitationNotice = 'Invitation link copied. The recipient opens it and taps Start sharing; a session code is not needed.';
        } catch (error) {
            this.invitationNotice = 'Select and copy the complete invitation link from the field above.';
        }
    }

    handleKeyChange(event) { if (this.canManageSession) this.apiKey = event.target.value; }

    handleCreateCustomerLink() { return this.updateCustomerLink(false); }
    handleRevokeCustomerLink() { return this.updateCustomerLink(true); }
    async updateCustomerLink(revoke) {
        if (this.invitationDisabled || (revoke && this.revokeCustomerDisabled)) return;
        let pageUrl;
        try { if (!revoke) pageUrl = normalizeCustomerPageUrl(this.publicCustomerPageUrl); }
        catch (error) { this.customerError = error.message; return; }
        const epoch = ++this.sessionEpoch;
        window.clearTimeout(this.pollTimer);
        this.customerBusy = true;
        this.customerUrl = '';
        this.customerError = '';
        this.customerNotice = '';
        try {
            if (revoke) {
                const snapshot = await revokeCustomerLink({ sessionId: this.sessionId });
                if (!this.connected || epoch !== this.sessionEpoch) return;
                this.applySnapshot(snapshot);
                this.customerNotice = 'Customer link revoked. Phone GPS sharing continues.';
            } else {
                const grant = await issueCustomerLink({ sessionId: this.sessionId });
                if (!this.connected || epoch !== this.sessionEpoch) return;
                this.customerUrl = buildCustomerUrl(pageUrl, grant.token);
                this.session = { ...this.session, customerInviteActive: true };
                this.customerNotice = 'Send this private viewing link to the customer. It expires with the session.';
            }
        } catch (error) {
            if (this.connected && epoch === this.sessionEpoch) this.customerError = this.errorText(error);
        } finally {
            if (this.connected && epoch === this.sessionEpoch) {
                this.customerBusy = false;
                this.schedulePoll();
            }
        }
    }
    async handleCopyCustomerLink() {
        if (!this.customerUrl || !this.isActive) return;
        try {
            await navigator.clipboard.writeText(this.customerUrl);
            this.customerNotice = 'Customer tracking link copied.';
        } catch (error) { this.customerNotice = 'Select and copy the complete customer link above.'; }
    }

    async handleCopySessionCode() {
        if (!this.canManageSession) return;
        try {
            await navigator.clipboard.writeText(this.sessionId);
            this.notice = 'Tracking code copied. Paste it into the phone page and tap Connect session.';
        } catch (error) {
            this.notice = 'Select and copy the tracking session code from the field above.';
        }
    }

    async handleLoadMap() {
        if (this.loadDisabled) return;
        this.clearMap();
        this.mapError = '';
        let url;
        try {
            url = new URL(resolveLiveMapPageUrl(this.session.mapPageUrl, this.publicPublisherPageUrl, window.location.origin));
        } catch (error) {
            this.failMap(error.message);
            return;
        }
        this.isLoading = true;
        this.busy = true;
        const epoch = ++this.sessionEpoch;
        window.clearTimeout(this.pollTimer);
        this.loadTimer = window.setTimeout(() => {
            if (!this.connected || epoch !== this.sessionEpoch) return;
            this.sessionEpoch += 1;
            this.busy = false;
            if (this.isCaseContext) {
                this.clearCaseData();
                this.sessionError = 'Could not connect to the Case session. Retry to reconnect.';
            }
            this.failMap('The map configuration could not be saved. Check your connection and retry.');
            this.schedulePoll();
        }, 22000);
        try {
            const snapshot = this.isReadOnly
                ? await this.readSession(this.sessionId)
                : await configureMaps({ sessionId: this.sessionId, apiKey: this.apiKey.trim() });
            if (!this.connected || epoch !== this.sessionEpoch) return;
            this.applySnapshot(snapshot);
            window.clearTimeout(this.loadTimer);
            if (this.isCaseContext && (!this.isActive || !this.apiKey)) {
                this.clearMap();
                return;
            }
        } catch (error) {
            if (this.connected && epoch === this.sessionEpoch) {
                if (this.isCaseContext) this.clearCaseData();
                this.failMap(this.errorText(error));
                if (this.isCaseContext) this.sessionError = this.errorText(error);
            }
            return;
        } finally {
            if (this.connected && epoch === this.sessionEpoch) {
                this.busy = false;
                this.schedulePoll();
            }
        }
        this.isLoading = true;
        this.channel = window.crypto.randomUUID();
        this.frameOrigin = url.origin;
        url.searchParams.set('parentOrigin', window.location.origin);
        url.searchParams.set('channel', this.channel);
        this.frameUrl = url.toString();
        this.loadTimer = window.setTimeout(() => {
            this.failMap(this.frameConnected
                ? 'The map page connected, but Google Maps did not finish loading. Check the API key and browser console.'
                : this.frameOrigin === window.location.origin
                    ? 'The site map did not connect. Confirm TechnicianLiveMap is enabled for this site and TechnicianLiveMapScript is Public, then refresh the whole site page.'
                    : 'The org map did not connect. Check Visualforce page access and browser session/cookie settings, or open tracking on your Experience site.');
        }, 30000);
    }

    handleFrameMessage(event) {
        const frame = this.template.querySelector('iframe');
        const data = event.data;
        if (!frame || event.source !== frame.contentWindow || event.origin !== this.frameOrigin ||
            !data || data.scope !== SCOPE || data.channel !== this.channel) return;
        if (data.type === 'frameReady') {
            if (!this.isLoading || this.frameConnected) return;
            if (data.bridgeVersion !== BRIDGE_VERSION) {
                this.failMap('The live map files have different versions. Deploy the complete technician-live-tracking.xml manifest.');
                return;
            }
            this.frameConnected = true;
            this.sendToMap('initialize', { apiKey: this.apiKey.trim(), customer: CUSTOMER });
        } else if (data.type === 'mapReady' && this.frameConnected) {
            if (data.bridgeVersion !== BRIDGE_VERSION) return;
            window.clearTimeout(this.loadTimer);
            this.isLoading = false;
            this.mapReady = true;
            this.sendToMap('follow', { enabled: this.followTechnician });
            this.publishLatestPosition();
            this.publishMapStatus();
        } else if (data.type === 'positionRendered' && this.mapReady && data.bridgeVersion === BRIDGE_VERSION) {
            if (this.positionSample && data.sampledAt === this.session.capturedAtMs &&
                data.position?.lat === this.session.latitude && data.position?.lng === this.session.longitude &&
                this.lastMapSample === this.positionSample) {
                this.renderedMapSample = this.positionSample;
            }
        } else if (data.type === 'routeUpdated' && this.mapReady && data.bridgeVersion === BRIDGE_VERSION) {
            this.route = { state: data.state, durationSeconds: numericValue(data.durationSeconds), computedAtMs: numericValue(data.computedAtMs) };
        } else if (data.type === 'mapError') {
            this.failMap(data.message || 'The live map could not load.');
        }
    }

    sendToMap(type, payload = {}) {
        const frame = this.template.querySelector('iframe');
        if (frame && this.frameConnected && this.channel && this.frameOrigin) {
            frame.contentWindow.postMessage({
                scope: SCOPE, channel: this.channel, bridgeVersion: BRIDGE_VERSION, type, ...payload
            }, this.frameOrigin);
        }
    }

    publishLatestPosition() {
        if (!this.mapReady || !this.positionSample) return;
        const sample = this.positionSample;
        if (sample === this.lastMapSample) return;
        this.lastMapSample = sample;
        this.lastMapStatus = undefined;
        this.sendToMap('position', {
            position: { lat: this.session.latitude, lng: this.session.longitude },
            accuracy: this.session.accuracy,
            sampledAt: this.session.capturedAtMs,
            receivedAtMs: this.session.receivedAtMs,
            active: this.isActive,
            stale: this.stale
        });
    }

    publishMapStatus() {
        if (!this.mapReady) return;
        let message;
        if (!this.hasPosition) {
            message = this.isActive
                ? 'Waiting for phone GPS. Open the latest invitation on the phone and tap Start sharing.'
                : this.statusLabel + '. No phone position was saved for this session.';
        } else if (!this.isActive || this.stale) {
            message = this.statusLabel + '. Showing the last saved phone position from ' + this.capturedLabel + '.';
        } else {
            message = 'Blue T: technician phone. GPS captured at ' + this.capturedLabel + '. Accuracy: ' + this.accuracyLabel + '.';
        }
        if (message === this.lastMapStatus) return;
        this.lastMapStatus = message;
        this.sendToMap('status', { text: message, active: this.isActive, stale: this.stale });
    }

    handleLocateTechnician() {
        if (this.locateDisabled) return;
        this.followTechnician = true;
        this.sendToMap('focusTechnician');
    }

    handleFollowChange(event) {
        this.followTechnician = event.target.checked;
        this.sendToMap('follow', { enabled: this.followTechnician });
    }

    handleFitMap() {
        this.followTechnician = false;
        this.sendToMap('follow', { enabled: false });
        this.sendToMap('fitBounds');
    }

    clearMap() {
        window.clearTimeout(this.loadTimer);
        this.channel = undefined;
        this.frameUrl = undefined;
        this.frameOrigin = undefined;
        this.lastMapSample = undefined;
        this.renderedMapSample = undefined;
        this.lastMapStatus = undefined;
        this.mapReady = false;
        this.route = undefined;
        this.frameConnected = false;
        this.isLoading = false;
    }

    failMap(message) {
        this.clearMap();
        this.mapError = message;
    }

    errorText(error) {
        return error?.body?.message || error?.message || 'Check your connection and the Technician Live Tracking POC permission set.';
    }
}
