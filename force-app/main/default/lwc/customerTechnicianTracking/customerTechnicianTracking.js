import { LightningElement, api } from 'lwc';
import getTracking from '@salesforce/apex/TechnicianCustomerTrackingController.getTracking';
import { DEFAULT_PUBLISHER_PAGE_URL, readCustomerToken, resolveLiveMapPageUrl } from 'c/trackingInvitation';

const SCOPE = 'technician-live-tracking-poc';
const BRIDGE = '2026-10-08.live2';
const STALE_MS = 15000;
function number(value) {
    if (typeof value === 'string' && value.trim() && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) value = Number(value);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export default class CustomerTechnicianTracking extends LightningElement {
    @api publicPublisherPageUrl = DEFAULT_PUBLISHER_PAGE_URL;
    linkInput = '';
    snapshot;
    error = '';
    mapError = '';
    loading = false;
    frameUrl;
    frameOrigin;
    channel;
    frameConnected = false;
    mapReady = false;
    route;
    now = Date.now();
    token = '';
    connected = false;
    epoch = 0;
    pollTimer;
    clockTimer;
    loadTimer;
    requestTimer;
    messageHandler;
    hashHandler;

    get hasTracking() { return Boolean(this.snapshot); }
    get hasPosition() {
        return Number.isFinite(this.snapshot?.latitude) && Math.abs(this.snapshot.latitude) <= 90 &&
            Number.isFinite(this.snapshot?.longitude) && Math.abs(this.snapshot.longitude) <= 180;
    }
    get stale() {
        return this.hasPosition && (!this.snapshot.capturedAtMs || !this.snapshot.receivedAtMs ||
            this.now - this.snapshot.capturedAtMs > STALE_MS || this.now - this.snapshot.receivedAtMs > STALE_MS);
    }
    get etaAvailable() {
        return this.hasPosition && !this.stale && this.route?.state === 'ready' &&
            Number.isFinite(this.route.durationSeconds) && this.route.durationSeconds >= 0 &&
            Number.isFinite(this.route.computedAtMs) && this.now - this.route.computedAtMs < 90000;
    }
    get etaLabel() {
        if (!this.hasPosition) return 'Waiting for location';
        if (this.stale) return 'Location update paused';
        if (this.etaAvailable) return Math.max(1, Math.ceil(this.route.durationSeconds / 60)) + ' min';
        return this.route?.state === 'unavailable' ? 'ETA unavailable' : 'Calculating arrival…';
    }
    get arrivalLabel() {
        return this.etaAvailable ? 'Estimated arrival ' + new Date(this.route.computedAtMs + this.route.durationSeconds * 1000)
            .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'ETA updates when a fresh route is available.';
    }
    get trackingLabel() {
        if (!this.hasPosition) return 'Waiting for your technician to share location.';
        return this.stale ? 'The last location is shown. Waiting for the next phone update.' : 'Your technician’s live location is updating.';
    }
    get updatedLabel() {
        return this.snapshot?.capturedAtMs ? new Date(this.snapshot.capturedAtMs).toLocaleTimeString() : 'No location yet';
    }
    get waitingForKey() { return this.hasTracking && !this.snapshot.browserMapsKey; }
    get controlsDisabled() { return !this.mapReady || !this.hasPosition; }

    connectedCallback() {
        this.connected = true;
        this.messageHandler = this.handleMessage.bind(this);
        this.hashHandler = () => this.openFromAddress();
        window.addEventListener('message', this.messageHandler);
        window.addEventListener('hashchange', this.hashHandler);
        this.clockTimer = window.setInterval(() => {
            this.now = Date.now();
            if (this.snapshot && this.now >= this.snapshot.expiresAtMs) {
                this.fail('This tracking link has expired. Ask the service team for a new link.');
            } else this.sendStatus();
        }, 1000);
        this.openFromAddress();
    }

    disconnectedCallback() {
        this.connected = false;
        this.epoch += 1;
        window.clearTimeout(this.pollTimer);
        window.clearTimeout(this.requestTimer);
        window.clearInterval(this.clockTimer);
        window.removeEventListener('message', this.messageHandler);
        window.removeEventListener('hashchange', this.hashHandler);
        this.clearMap();
        this.snapshot = undefined;
        this.token = '';
        this.linkInput = '';
    }

    openFromAddress() {
        const token = readCustomerToken(window.location.href);
        if (token) this.connect(token);
        else if (this.token) {
            this.fail('Open your private customer tracking link.');
            this.token = '';
        }
    }
    handleInput(event) { this.linkInput = event.target.value; }
    handleConnect() {
        const token = readCustomerToken(this.linkInput);
        this.linkInput = '';
        if (!token) { this.error = 'Enter your complete customer tracking link or customer code.'; return; }
        this.connect(token);
    }
    handleRetry() { if (this.token) this.connect(this.token); }
    connect(token) {
        window.clearTimeout(this.pollTimer);
        window.clearTimeout(this.requestTimer);
        this.clearMap();
        this.snapshot = undefined;
        this.token = token;
        this.error = '';
        this.mapError = '';
        this.loading = true;
        this.epoch += 1;
        this.refresh(this.epoch);
    }
    async refresh(epoch) {
        if (!this.connected || epoch !== this.epoch) return;
        let timedOut = false;
        this.requestTimer = window.setTimeout(() => {
            timedOut = true;
            if (epoch === this.epoch) this.fail('Tracking could not be refreshed. Check your connection and try again.');
        }, 22000);
        try {
            const value = await getTracking({ token: this.token });
            if (!this.connected || timedOut || epoch !== this.epoch) return;
            window.clearTimeout(this.requestTimer);
            if (!value?.active || number(value.expiresAtMs) <= Date.now()) {
                this.fail('This tracking link has ended or expired. Ask the service team for a new link.');
                return;
            }
            const previousKey = this.snapshot?.browserMapsKey;
            this.snapshot = { ...value };
            for (const field of ['latitude', 'longitude', 'accuracy', 'capturedAtMs', 'receivedAtMs', 'expiresAtMs', 'customerLatitude', 'customerLongitude']) {
                this.snapshot[field] = number(value[field]);
            }
            this.now = Date.now();
            this.loading = false;
            this.error = '';
            if (previousKey && previousKey !== value.browserMapsKey) this.clearMap();
            if (value.browserMapsKey && !this.frameUrl && !this.mapError) this.openMap();
            this.sendPosition();
            this.sendStatus();
            this.pollTimer = window.setTimeout(() => this.refresh(epoch), 3000);
        } catch (error) {
            if (this.connected && epoch === this.epoch && !timedOut) {
                this.fail('This customer link is unavailable, revoked or expired, or your connection was interrupted. Retry or ask the service team for a new link.');
            }
        } finally {
            if (epoch === this.epoch) window.clearTimeout(this.requestTimer);
        }
    }
    openMap() {
        try {
            const url = new URL(resolveLiveMapPageUrl('', this.publicPublisherPageUrl, window.location.origin));
            this.channel = window.crypto.randomUUID();
            this.frameOrigin = url.origin;
            url.searchParams.set('parentOrigin', window.location.origin);
            url.searchParams.set('channel', this.channel);
            this.frameUrl = url.href;
            this.loadTimer = window.setTimeout(() => {
                this.clearMap();
                this.mapError = 'The map could not load. Please retry.';
            }, 30000);
        } catch (error) { this.mapError = 'The service team needs to configure this site’s map page.'; }
    }
    handleMessage(event) {
        const frame = this.template.querySelector('iframe');
        const data = event.data;
        if (!frame || event.source !== frame.contentWindow || event.origin !== this.frameOrigin ||
            !data || data.scope !== SCOPE || data.channel !== this.channel || data.bridgeVersion !== BRIDGE) return;
        if (data.type === 'frameReady' && !this.frameConnected) {
            this.frameConnected = true;
            this.send('initialize', { apiKey: this.snapshot.browserMapsKey,
                customer: { lat: this.snapshot.customerLatitude, lng: this.snapshot.customerLongitude } });
        } else if (data.type === 'mapReady' && this.frameConnected) {
            window.clearTimeout(this.loadTimer);
            this.mapReady = true;
            this.send('follow', { enabled: false });
            this.sendPosition();
            this.send('fitBounds');
            this.sendStatus();
        } else if (data.type === 'routeUpdated' && this.mapReady) {
            this.route = { state: data.state, durationSeconds: number(data.durationSeconds), computedAtMs: number(data.computedAtMs) };
        } else if (data.type === 'mapError') {
            this.clearMap();
            this.mapError = 'The map is temporarily unavailable. Please retry or contact the service team.';
        }
    }
    send(type, payload = {}) {
        const frame = this.template.querySelector('iframe');
        if (frame && this.frameConnected && this.channel && this.frameOrigin) {
            frame.contentWindow.postMessage({ scope: SCOPE, bridgeVersion: BRIDGE, channel: this.channel, type, ...payload }, this.frameOrigin);
        }
    }
    sendPosition() {
        if (this.mapReady && this.hasPosition) this.send('position', {
            position: { lat: this.snapshot.latitude, lng: this.snapshot.longitude }, accuracy: this.snapshot.accuracy,
            sampledAt: this.snapshot.capturedAtMs, receivedAtMs: this.snapshot.receivedAtMs, active: true, stale: this.stale
        });
    }
    sendStatus() {
        if (this.mapReady) this.send('status', { text: this.trackingLabel, active: true, stale: this.stale });
    }
    handleOverview() { this.send('fitBounds'); }
    clearMap() {
        window.clearTimeout(this.loadTimer);
        this.frameUrl = undefined;
        this.frameOrigin = undefined;
        this.channel = undefined;
        this.frameConnected = false;
        this.mapReady = false;
        this.route = undefined;
    }
    fail(message) {
        this.epoch += 1;
        window.clearTimeout(this.pollTimer);
        window.clearTimeout(this.requestTimer);
        this.loading = false;
        this.snapshot = undefined;
        this.clearMap();
        this.error = message;
    }
}
