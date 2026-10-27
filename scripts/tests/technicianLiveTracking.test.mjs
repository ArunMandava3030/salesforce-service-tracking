import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../force-app/main/default/lwc/technicianLiveTracking/technicianLiveTracking.js', import.meta.url), 'utf8');
const invitation = await import('data:text/javascript,' + encodeURIComponent(readFileSync(
    new URL('../../force-app/main/default/lwc/trackingInvitation/trackingInvitation.js', import.meta.url), 'utf8'
)));
const INVITATION_TOKEN = '0123456789abcdef'.repeat(4);
const CASE_ID = '500000000000001AAA';
const SESSION_ID = 'a01000000000001AAA';
async function settle() { for (let i = 0; i < 24; i += 1) await Promise.resolve(); }

function harness(overrides = {}, options = {}) {
    const messages = [];
    const timeouts = new Map();
    const intervals = new Map();
    const storage = new Map();
    const clipboard = [];
    const apiCalls = [];
    const events = [];
    let id = 0;
    let channelId = 0;
    let clock = 1791460800000;
    const snapshot = {
        sessionId: 'a01000000000001AAA', active: true, expired: false,
        expiresAtMs: clock + 7200000, latitude: null, longitude: null, accuracy: null,
        capturedAtMs: null, receivedAtMs: null, publisherInviteActive: false,
        customerLatitude: 37.7749, customerLongitude: -122.4194,
        publisherUrl: 'https://demo--c.develop.vf.force.com/apex/TechnicianGpsPublisher?sessionId=a01000000000001AAA',
        mapPageUrl: options.mapPageUrl || 'https://demo--c.develop.vf.force.com/apex/TechnicianLiveMap',
        ...(options.caseId ? { caseId: options.caseId, canManage: options.canManage === true, browserMapsKey: options.browserMapsKey || null } : {})
    };
    const frame = { contentWindow: { postMessage: (data, origin) => messages.push({ data, origin }) } };
    const window = {
        location: { origin: options.viewerOrigin || 'https://demo.develop.lightning.force.com' },
        crypto: { randomUUID: () => '12345678-1234-1234-1234-' + String(++channelId).padStart(12, '0') },
        sessionStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key)
        },
        addEventListener() {}, removeEventListener() {},
        setTimeout(fn, delay) { timeouts.set(++id, { fn, delay }); return id; },
        clearTimeout(key) { timeouts.delete(key); },
        setInterval(fn, delay) { intervals.set(++id, { fn, delay }); return id; },
        clearInterval(key) { intervals.delete(key); }
    };
    class ClockDate extends Date { static now() { return clock; } }
    const implementations = {
        createSession: async () => ({ ...snapshot }),
        getSession: async () => ({ ...snapshot }),
        getCaseSession: async () => ({ ...snapshot }),
        endSession: async () => ({ ...snapshot, active: false }),
        issuePublisherLink: async () => ({ token: INVITATION_TOKEN, expiresAtMs: snapshot.expiresAtMs }),
        revokePublisherLink: async () => ({ ...snapshot, publisherInviteActive: false }),
        configureMaps: async ({ apiKey }) => ({ ...component.session, browserMapsKey: apiKey }),
        issueCustomerLink: async () => ({ token: 'ab'.repeat(32), expiresAtMs: snapshot.expiresAtMs }),
        revokeCustomerLink: async () => ({ ...component.session, customerInviteActive: false }),
        ...overrides
    };
    const api = Object.fromEntries(Object.entries(implementations).map(([name, implementation]) => [
        name, args => {
            apiCalls.push({ name, args });
            return implementation(args);
        }
    ]));
    const executable = source.replace(/import[\s\S]*?from ['"][^'"]+['"];?/g, '')
        .replace(/@api\s+/g, '')
        .replace('export default class TechnicianLiveTracking extends LightningElement',
            'class TechnicianLiveTracking extends Object');
    const Component = new Function('USER_ID', 'createSession', 'getSession', 'getCaseSession', 'endSession',
        'issuePublisherLink', 'revokePublisherLink', 'configureMaps', 'issueCustomerLink', 'revokeCustomerLink',
        'DEFAULT_PUBLISHER_PAGE_URL', 'normalizePublisherPageUrl', 'buildInvitationUrl', 'resolveLiveMapPageUrl',
        'DEFAULT_CUSTOMER_PAGE_URL', 'normalizeCustomerPageUrl', 'buildCustomerUrl', 'window', 'navigator', 'URL', 'Date', 'CustomEvent',
        executable + '\nreturn TechnicianLiveTracking;')(
        '005-test-user', api.createSession, api.getSession, api.getCaseSession, api.endSession,
        api.issuePublisherLink, api.revokePublisherLink, api.configureMaps, api.issueCustomerLink, api.revokeCustomerLink,
        invitation.DEFAULT_PUBLISHER_PAGE_URL, invitation.normalizePublisherPageUrl, invitation.buildInvitationUrl,
        invitation.resolveLiveMapPageUrl,
        invitation.DEFAULT_CUSTOMER_PAGE_URL, invitation.normalizeCustomerPageUrl, invitation.buildCustomerUrl,
        window, { clipboard: { writeText: async value => { clipboard.push(value); } } }, URL, ClockDate,
        class { constructor(type) { this.type = type; } }
    );
    const component = new Component();
    component.dispatchEvent = event => events.push(event);
    component.caseId = options.caseId;
    component.trackingSessionId = options.trackingSessionId;
    if (options.publisherPageUrl !== undefined) component.publicPublisherPageUrl = options.publisherPageUrl;
    component.template = { querySelector: () => component.frameUrl ? frame : null };
    component.connectedCallback();
    const emit = (type, extra = {}, eventOverrides = {}) => component.handleFrameMessage({
        source: frame.contentWindow, origin: 'https://demo--c.develop.vf.force.com',
        data: { scope: 'technician-live-tracking-poc', channel: component.channel,
            bridgeVersion: '2026-10-08.live2', type, ...extra },
        ...eventOverrides
    });
    return { component, snapshot, messages, timeouts, intervals, storage, clipboard, apiCalls, emit, events,
        advance: milliseconds => {
            clock += milliseconds;
            for (const interval of intervals.values()) interval.fn();
        } };
}

test('creates an authenticated session and initializes only the fixed customer', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    assert.equal(h.component.statusLabel, 'Waiting for phone GPS');
    assert.equal(h.component.publisherUrl, h.snapshot.publisherUrl);
    h.component.apiKey = 'test-key';
    await h.component.handleLoadMap();
    h.emit('frameReady');
    const config = h.messages.find(item => item.data.type === 'initialize').data;
    assert.deepEqual(config.customer, { lat: 37.7749, lng: -122.4194 });
    assert.equal('technician' in config, false);
    h.emit('mapReady');
    assert.equal(h.messages.some(item => item.data.type === 'position'), false);
    h.component.disconnectedCallback();
});

test('persisted phone coordinates update the map and duplicate polls do not redraw', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    h.component.apiKey = 'test-key';
    await h.component.handleLoadMap();
    h.emit('frameReady');
    h.emit('mapReady');
    const fix = { ...h.snapshot, latitude: 37.7700, longitude: -122.4250, accuracy: 8,
        capturedAtMs: h.component.now, receivedAtMs: h.component.now };
    h.component.applySnapshot(fix);
    h.component.applySnapshot({ ...fix });
    const positions = h.messages.filter(item => item.data.type === 'position');
    assert.equal(positions.length, 1);
    assert.deepEqual(positions[0].data.position, { lat: 37.7700, lng: -122.4250 });
    assert.equal(positions[0].data.accuracy, 8);
    h.advance(16000);
    assert.equal(h.component.statusLabel, 'GPS update is stale');
    h.component.disconnectedCallback();
});

test('copies the complete phone link and its matching recovery code without the Maps key', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    h.component.apiKey = 'private-test-map-key';
    await h.component.handleCopyLink();
    await h.component.handleCopySessionCode();
    assert.deepEqual(h.clipboard, [h.snapshot.publisherUrl, h.snapshot.sessionId]);
    assert.equal(new URL(h.clipboard[0]).searchParams.get('sessionId'), h.clipboard[1]);
    assert.match(h.component.notice, /Connect session/);
    h.component.disconnectedCallback();
});

test('a poll schedules its next read only after the server responds', async () => {
    let finish;
    const h = harness({ getSession: () => new Promise(resolve => { finish = resolve; }) });
    await h.component.handleCreateSession();
    h.timeouts.clear();
    const request = h.component.pollSession();
    assert.equal(h.timeouts.size, 0);
    finish({ ...h.snapshot });
    await request;
    assert.equal(h.timeouts.size, 1);
    assert.equal(Array.from(h.timeouts.values())[0].delay, 3000);
    h.component.disconnectedCallback();
});

test('ending a session cannot be undone by an older poll response', async () => {
    let finish;
    const h = harness({ getSession: () => new Promise(resolve => { finish = resolve; }) });
    await h.component.handleCreateSession();
    const oldPoll = h.component.pollSession();
    await h.component.handleEndSession();
    finish({ ...h.snapshot, active: true, latitude: 37.6700, longitude: -122.4500 });
    await oldPoll;
    assert.equal(h.component.isActive, false);
    assert.equal(h.component.statusLabel, 'Sharing stopped');
    assert.equal(h.timeouts.size, 0);
    h.component.disconnectedCallback();
});

test('disconnect cancels timers and ignores an outstanding server response', async () => {
    let finish;
    const h = harness({ createSession: () => new Promise(resolve => { finish = resolve; }) });
    const request = h.component.handleCreateSession();
    h.component.disconnectedCallback();
    finish({ ...h.snapshot });
    await request;
    assert.equal(h.component.session, undefined);
    assert.equal(h.timeouts.size, 0);
    assert.equal(h.intervals.size, 0);
    h.component.connectedCallback();
    assert.equal(h.component.busy, false);
    h.component.disconnectedCallback();
});

test('a different map build cannot receive the API key', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    h.component.apiKey = 'test-key';
    await h.component.handleLoadMap();
    h.emit('frameReady', { bridgeVersion: 'old' });
    assert.equal(h.component.mapError.includes('different versions'), true);
    assert.equal(h.messages.some(item => item.data.type === 'initialize'), false);
    h.component.disconnectedCallback();
});

test('expired sessions stop polling and expose their final status', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    h.advance(7200001);
    h.component.schedulePoll();
    assert.equal(h.component.statusLabel, 'Session expired');
    assert.equal(h.component.createDisabled, false);
    assert.equal(h.timeouts.size, 0);
    h.component.disconnectedCallback();
});

test('poll errors retain the last known coordinates and retry', async () => {
    const h = harness({ getSession: async () => { throw new Error('offline'); } });
    await h.component.handleCreateSession();
    h.component.applySnapshot({ ...h.snapshot, latitude: 37.7700, longitude: -122.4300,
        capturedAtMs: h.component.now, receivedAtMs: h.component.now });
    await h.component.pollSession();
    assert.equal(h.component.session.latitude, 37.7700);
    assert.equal(h.component.sessionError.includes('offline'), true);
    assert.equal(h.timeouts.size, 1);
    h.component.disconnectedCallback();
});

async function harnessWithMap(overrides) {
    const h = harness(overrides);
    await h.component.handleCreateSession();
    h.component.apiKey = 'test-key';
    await h.component.handleLoadMap();
    h.emit('frameReady');
    h.emit('mapReady');
    return h;
}

function phoneFix(h, overrides = {}) {
    return {
        ...h.snapshot,
        latitude: 37.7730,
        longitude: -122.4210,
        accuracy: 8,
        capturedAtMs: h.component.now,
        receivedAtMs: h.component.now,
        ...overrides
    };
}

function renderedAcknowledgment(fix) {
    return {
        sampledAt: Number(fix.capturedAtMs),
        position: { lat: Number(fix.latitude), lng: Number(fix.longitude) }
    };
}

test('high-precision Apex decimal strings become visible phone positions and numeric map payloads', async () => {
    const h = await harnessWithMap();
    const fix = phoneFix(h, {
        latitude: '37.774912345678901',
        longitude: '-122.419412345678901',
        accuracy: '7.5000000000000001',
        capturedAtMs: String(h.component.now),
        receivedAtMs: String(h.component.now),
        expiresAtMs: String(h.snapshot.expiresAtMs)
    });
    h.component.applySnapshot(fix);
    assert.equal(h.component.hasPosition, true);
    assert.equal(h.component.waitingForPhone, false);
    assert.equal(h.component.statusLabel, 'Receiving phone GPS');
    assert.equal(h.component.session.latitude, Number(fix.latitude));
    assert.equal(h.component.session.longitude, Number(fix.longitude));
    assert.equal(h.component.session.accuracy, Number(fix.accuracy));
    assert.equal(typeof h.component.session.capturedAtMs, 'number');
    const positions = h.messages.filter(item => item.data.type === 'position');
    assert.equal(positions.length, 1);
    assert.deepEqual(positions[0].data.position, {
        lat: Number(fix.latitude), lng: Number(fix.longitude)
    });
    assert.equal(typeof positions[0].data.accuracy, 'number');
    assert.equal(typeof fix.latitude, 'string');
    assert.equal(h.component.renderedMapSample, undefined);
    assert.match(h.component.mapPositionLabel, /Waiting for the map/);
    h.emit('positionRendered', renderedAcknowledgment(fix));
    assert.equal(h.component.renderedMapSample, h.component.positionSample);
    assert.match(h.component.mapPositionLabel, /latest phone position/);
    h.component.disconnectedCallback();
});

test('missing and invalid numeric values remain missing instead of inventing zero coordinates', async () => {
    const h = await harnessWithMap();
    for (const value of [null, undefined, '', '   ', false, true, [], {}, NaN, Infinity, 'Infinity', 'bad', '0x10']) {
        h.component.applySnapshot(phoneFix(h, { latitude: value, longitude: value, accuracy: value }));
        assert.equal(h.component.session.latitude, null);
        assert.equal(h.component.session.longitude, null);
        assert.equal(h.component.session.accuracy, null);
        assert.equal(h.component.hasPosition, false);
        assert.equal(h.component.locateDisabled, true);
    }
    assert.equal(h.messages.some(item => item.data.type === 'position'), false);

    h.component.applySnapshot(phoneFix(h, { latitude: '0', longitude: '0', accuracy: '0' }));
    assert.equal(h.component.hasPosition, true);
    assert.deepEqual(h.messages.find(item => item.data.type === 'position').data.position, { lat: 0, lng: 0 });
    h.component.disconnectedCallback();
});

test('out-of-bounds coordinates never reach the map while valid geographic boundaries do', async () => {
    const h = await harnessWithMap();
    for (const [latitude, longitude] of [[90.000001, 0], [-90.000001, 0], [0, 180.000001], [0, -180.000001]]) {
        h.component.applySnapshot(phoneFix(h, { latitude, longitude }));
        assert.equal(h.component.hasPosition, false);
    }
    assert.equal(h.messages.some(item => item.data.type === 'position'), false);
    h.component.applySnapshot(phoneFix(h, { latitude: '-90', longitude: '180' }));
    assert.deepEqual(h.messages.find(item => item.data.type === 'position').data.position, { lat: -90, lng: 180 });
    h.component.disconnectedCallback();
});

test('coordinates without a usable capture timestamp cannot be sent or acknowledged as rendered', async () => {
    const h = await harnessWithMap();
    for (const capturedAtMs of [null, undefined, '', '   ', 0, -1]) {
        const fix = phoneFix(h, { capturedAtMs });
        h.component.applySnapshot(fix);
        h.emit('positionRendered', renderedAcknowledgment(fix));
        assert.equal(h.component.positionSample, '');
        assert.equal(h.component.renderedMapSample, undefined);
    }
    assert.equal(h.messages.some(item => item.data.type === 'position'), false);
    h.component.disconnectedCallback();
});

test('only the current trusted map can acknowledge the latest exact GPS sample', async () => {
    const h = await harnessWithMap();
    const first = phoneFix(h);
    h.component.applySnapshot(first);
    const acknowledgment = renderedAcknowledgment(first);
    const invalidMessages = [
        [{ ...acknowledgment, sampledAt: first.capturedAtMs - 1 }],
        [{ ...acknowledgment, position: { lat: first.latitude + 0.01, lng: first.longitude } }],
        [{ ...acknowledgment, bridgeVersion: '2026-10-08.live1' }],
        [{ ...acknowledgment, channel: 'another-channel' }],
        [{ ...acknowledgment, scope: 'another-component' }],
        [acknowledgment, { origin: 'https://untrusted.example' }],
        [acknowledgment, { source: {} }]
    ];
    for (const [data, event] of invalidMessages) {
        h.emit('positionRendered', data, event);
        assert.equal(h.component.renderedMapSample, undefined);
    }
    h.emit('positionRendered', acknowledgment);
    const firstRenderedSample = h.component.renderedMapSample;
    assert.equal(firstRenderedSample, h.component.positionSample);

    h.advance(1000);
    const second = phoneFix(h, { capturedAtMs: String(h.component.now) });
    h.component.applySnapshot(second);
    assert.notEqual(h.component.positionSample, firstRenderedSample);
    assert.match(h.component.mapPositionLabel, /Waiting for the map/);
    h.emit('positionRendered', acknowledgment);
    assert.equal(h.component.renderedMapSample, firstRenderedSample);
    h.emit('positionRendered', renderedAcknowledgment(second));
    assert.equal(h.component.renderedMapSample, h.component.positionSample);
    h.component.disconnectedCallback();
});

test('reloading the map resets its acknowledgment and rejects an acknowledgment from the old channel', async () => {
    const h = await harnessWithMap();
    const fix = phoneFix(h);
    h.component.applySnapshot(fix);
    h.emit('positionRendered', renderedAcknowledgment(fix));
    assert.equal(h.component.renderedMapSample, h.component.positionSample);
    const oldChannel = h.component.channel;

    await h.component.handleLoadMap();
    assert.equal(h.component.renderedMapSample, undefined);
    assert.equal(h.component.mapReady, false);
    assert.notEqual(h.component.channel, oldChannel);
    h.emit('frameReady');
    h.emit('mapReady');
    assert.equal(h.component.renderedMapSample, undefined);
    h.emit('positionRendered', { ...renderedAcknowledgment(fix), channel: oldChannel });
    assert.equal(h.component.renderedMapSample, undefined);
    h.emit('positionRendered', renderedAcknowledgment(fix));
    assert.equal(h.component.renderedMapSample, h.component.positionSample);
    h.component.disconnectedCallback();
});

test('locating the technician requires a ready map and GPS and restores follow mode', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    h.component.applySnapshot(phoneFix(h));
    assert.equal(h.component.locateDisabled, true);
    h.component.handleLocateTechnician();
    assert.equal(h.messages.some(item => item.data.type === 'focusTechnician'), false);

    h.component.applySnapshot({ ...h.snapshot });
    h.component.apiKey = 'test-key';
    await h.component.handleLoadMap();
    h.emit('frameReady');
    h.emit('mapReady');
    assert.equal(h.component.locateDisabled, true);
    h.component.handleLocateTechnician();
    assert.equal(h.messages.some(item => item.data.type === 'focusTechnician'), false);

    h.component.applySnapshot(phoneFix(h));
    assert.equal(h.component.locateDisabled, false);
    h.component.handleFitMap();
    assert.equal(h.component.followTechnician, false);
    h.component.handleLocateTechnician();
    assert.equal(h.component.followTechnician, true);
    assert.equal(h.messages.filter(item => item.data.type === 'focusTechnician').length, 1);
    h.component.clearMap();
    h.component.handleLocateTechnician();
    assert.equal(h.messages.filter(item => item.data.type === 'focusTechnician').length, 1);
    h.component.disconnectedCallback();
});

test('the one-second clock marks a saved map position stale without pretending another server read occurred', async () => {
    const h = await harnessWithMap();
    assert.equal([...h.intervals.values()][0].delay, 1000);
    const fix = phoneFix(h);
    h.component.applySnapshot(fix);
    h.emit('positionRendered', renderedAcknowledgment(fix));
    const lastReadAt = h.component.lastReadAt;
    const capturedLabel = h.component.capturedLabel;
    const statusCount = h.messages.filter(item => item.data.type === 'status').length;

    h.advance(1000);
    assert.equal(h.messages.filter(item => item.data.type === 'status').length, statusCount);
    h.advance(15000);
    assert.equal(h.component.stale, true);
    assert.equal(h.component.lastReadAt, lastReadAt);
    assert.equal(h.component.capturedLabel, capturedLabel);
    assert.match(h.component.mapPositionLabel, /not current/);
    assert.match(h.messages.filter(item => item.data.type === 'status').at(-1).data.text, /stale.*last saved/i);

    h.component.applySnapshot({ ...fix, active: false });
    assert.equal(h.component.lastReadAt, lastReadAt + 16000);
    assert.equal(h.component.lastReadLabel, new Date(lastReadAt + 16000).toLocaleTimeString());
    assert.equal(h.component.capturedLabel, new Date(fix.capturedAtMs).toLocaleTimeString());
    assert.match(h.messages.filter(item => item.data.type === 'status').at(-1).data.text, /Sharing stopped.*last saved/);
    assert.match(h.component.mapPositionLabel, /not current/);
    h.component.disconnectedCallback();
});

test('a new sample in the same displayed second restores the detailed map footer after the position update', async () => {
    const h = await harnessWithMap();
    h.component.applySnapshot(phoneFix(h));
    const firstFooter = h.messages.filter(item => item.data.type === 'status').at(-1).data.text;
    const messageCount = h.messages.length;
    h.advance(100);
    h.component.applySnapshot(phoneFix(h));
    const updates = h.messages.slice(messageCount);
    assert.deepEqual(updates.map(item => item.data.type), ['position', 'status']);
    assert.equal(updates[1].data.text, firstFooter);
    assert.equal(h.component.renderedMapSample, undefined);
    h.component.disconnectedCallback();
});

test('a private session never creates an invitation automatically and invitation issuance requires an active session', async () => {
    const h = harness();
    assert.equal(h.component.invitationDisabled, true);
    await h.component.handleCreateInvitation();
    await h.component.handleRevokeInvitation();
    assert.deepEqual(h.apiCalls, []);

    await h.component.handleCreateSession();
    assert.deepEqual(h.apiCalls.map(call => call.name), ['createSession']);
    assert.equal(h.component.invitationDisabled, false);
    assert.equal(h.component.revokeInvitationDisabled, true);
    assert.equal(h.component.hasInvitationUrl, false);
    assert.equal(h.component.session.publisherInviteActive, false);

    await h.component.handleCreateInvitation();
    assert.deepEqual(h.apiCalls.at(-1), {
        name: 'issuePublisherLink', args: { sessionId: h.snapshot.sessionId }
    });
    assert.equal(h.component.session.publisherInviteActive, true);
    assert.equal(h.component.revokeInvitationDisabled, false);
    h.component.disconnectedCallback();
});

test('an explicitly issued invitation uses only a URL fragment and never persists its token', async () => {
    const h = harness({ issuePublisherLink: async () => ({ token: INVITATION_TOKEN.toUpperCase() }) });
    await h.component.handleCreateSession();
    h.component.apiKey = 'private-test-map-key';
    assert.equal(h.component.publicPublisherPageUrl, invitation.DEFAULT_PUBLISHER_PAGE_URL);
    h.component.publicPublisherPageUrl = '  https://example.my.site.com/Tracking/apex/TechnicianGpsInvite  ';
    await h.component.handleCreateInvitation();

    const link = new URL(h.component.invitationUrl);
    assert.equal(link.href, 'https://example.my.site.com/Tracking/apex/TechnicianGpsInvite#invite=' + INVITATION_TOKEN);
    assert.equal(link.search, '');
    assert.equal(link.hash, '#invite=' + INVITATION_TOKEN);
    assert.equal(link.href.includes(h.snapshot.sessionId), false);
    assert.equal(link.href.includes(h.component.apiKey), false);
    assert.deepEqual([...h.storage], [[h.component.storageKey, h.snapshot.sessionId]]);
    assert.equal(JSON.stringify([...h.storage]).includes(INVITATION_TOKEN), false);
    await h.component.handleCopyInvitation();
    assert.deepEqual(h.clipboard, [link.href]);
    assert.equal(h.messages.length, 0);
    h.component.disconnectedCallback();
});

test('replacing an invitation hides the old link, pauses polling, and ignores the previous poll response', async () => {
    let finishPoll;
    let finishGrant;
    let issued = 0;
    const replacementToken = 'f'.repeat(64);
    const h = harness({
        getSession: () => new Promise(resolve => { finishPoll = resolve; }),
        issuePublisherLink: () => ++issued === 1
            ? Promise.resolve({ token: INVITATION_TOKEN })
            : new Promise(resolve => { finishGrant = resolve; })
    });
    await h.component.handleCreateSession();
    await h.component.handleCreateInvitation();
    assert.equal(h.component.hasInvitationUrl, true);
    const oldEpoch = h.component.sessionEpoch;
    const oldPoll = h.component.pollSession();
    const rotation = h.component.handleCreateInvitation();
    assert.ok(h.component.sessionEpoch > oldEpoch);
    assert.equal(h.component.invitationUrl, '');
    assert.equal(h.component.invitationBusy, true);
    assert.equal(h.component.createDisabled, true);
    assert.equal(h.component.stopDisabled, true);
    assert.equal(h.component.invitationDisabled, true);
    assert.equal(h.timeouts.size, 0);
    await h.component.handleCreateInvitation();
    assert.equal(issued, 2);

    finishGrant({ token: replacementToken });
    await rotation;
    const newLink = h.component.invitationUrl;
    assert.equal(new URL(newLink).hash, '#invite=' + replacementToken);
    assert.equal(h.component.invitationBusy, false);
    assert.equal(h.timeouts.size, 1);
    finishPoll({ ...h.snapshot, publisherInviteActive: false });
    await oldPoll;
    assert.equal(h.component.invitationUrl, newLink);
    assert.equal(h.component.session.publisherInviteActive, true);
    assert.equal(h.timeouts.size, 1);
    assert.deepEqual([...h.storage.values()], [h.snapshot.sessionId]);
    h.component.disconnectedCallback();
});

test('revocation applies the returned GPS snapshot and removes the invitation without ending the session', async () => {
    let revokedSnapshot;
    const h = await harnessWithMap({ revokePublisherLink: async () => revokedSnapshot });
    await h.component.handleCreateInvitation();
    revokedSnapshot = phoneFix(h, {
        latitude: '37.774912345678901', longitude: '-122.419412345678901',
        publisherInviteActive: false
    });
    await h.component.handleRevokeInvitation();
    assert.deepEqual(h.apiCalls.at(-1), {
        name: 'revokePublisherLink', args: { sessionId: h.snapshot.sessionId }
    });
    assert.equal(h.component.invitationUrl, '');
    assert.equal(h.component.session.publisherInviteActive, false);
    assert.equal(h.component.isActive, true);
    assert.equal(h.component.revokeInvitationDisabled, true);
    assert.equal(h.component.session.latitude, Number(revokedSnapshot.latitude));
    assert.equal(h.messages.filter(item => item.data.type === 'position').length, 1);
    assert.equal(h.timeouts.size, 1);
    await h.component.handleCopyInvitation();
    assert.deepEqual(h.clipboard, []);
    h.component.disconnectedCallback();
});

test('an invitation grant received after disconnect is discarded and cannot restart polling', async () => {
    let finishGrant;
    const h = harness({ issuePublisherLink: () => new Promise(resolve => { finishGrant = resolve; }) });
    await h.component.handleCreateSession();
    const issuance = h.component.handleCreateInvitation();
    assert.equal(h.component.invitationBusy, true);
    h.component.disconnectedCallback();
    finishGrant({ token: INVITATION_TOKEN });
    await issuance;
    assert.equal(h.component.invitationUrl, '');
    assert.equal(h.component.invitationNotice, '');
    assert.equal(h.component.invitationBusy, false);
    assert.equal(h.component.session.publisherInviteActive, false);
    assert.equal(h.timeouts.size, 0);
    assert.equal(h.intervals.size, 0);
});

test('an invalid public publisher URL prevents issuing a token and leaves ordinary polling intact', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    const originalEpoch = h.component.sessionEpoch;
    const originalTimer = h.component.pollTimer;
    for (const pageUrl of [
        '', 'not a URL',
        'http://example.my.site.com/apex/TechnicianGpsInvite',
        'https://unrelated.example/apex/TechnicianGpsInvite',
        'https://example.my.site.com/apex/TechnicianGpsInvite?invite=unsafe',
        'https://example.my.site.com/apex/TechnicianGpsInvite#invite=unsafe'
    ]) {
        h.component.publicPublisherPageUrl = pageUrl;
        await h.component.handleCreateInvitation();
        assert.equal(h.apiCalls.some(call => call.name === 'issuePublisherLink'), false);
        assert.equal(h.component.invitationBusy, false);
        assert.equal(h.component.hasInvitationUrl, false);
        assert.ok(h.component.invitationError);
        assert.equal(h.component.sessionEpoch, originalEpoch);
        assert.equal(h.timeouts.has(originalTimer), true);
    }
    h.component.disconnectedCallback();
});

test('failed invitation issuance restores controls and polling and can be retried explicitly', async () => {
    let issued = 0;
    const h = harness({ issuePublisherLink: async () => {
        if (++issued === 1) throw { body: { message: 'Invitation could not be created.' } };
        return { token: INVITATION_TOKEN };
    } });
    await h.component.handleCreateSession();
    await h.component.handleCreateInvitation();
    assert.equal(h.component.hasInvitationUrl, false);
    assert.equal(h.component.invitationError, 'Invitation could not be created.');
    assert.equal(h.component.invitationDisabled, false);
    assert.equal(h.component.session.publisherInviteActive, false);
    assert.equal(h.timeouts.size, 1);
    await h.component.handleCreateInvitation();
    assert.equal(h.component.invitationError, '');
    assert.equal(h.component.hasInvitationUrl, true);
    assert.equal(issued, 2);
    h.component.disconnectedCallback();
});

test('ending or expiring a session disables invitation issuance, revocation, and copying', async () => {
    for (const endMode of ['ended', 'expired']) {
        const h = harness();
        await h.component.handleCreateSession();
        await h.component.handleCreateInvitation();
        if (endMode === 'ended') {
            await h.component.handleEndSession();
            assert.equal(h.component.invitationUrl, '');
        } else {
            h.advance(7200001);
        }
        assert.equal(h.component.isActive, false);
        assert.equal(h.component.invitationDisabled, true);
        assert.equal(h.component.revokeInvitationDisabled, true);
        const requestCount = h.apiCalls.length;
        await h.component.handleCreateInvitation();
        await h.component.handleRevokeInvitation();
        await h.component.handleCopyInvitation();
        assert.equal(h.apiCalls.length, requestCount);
        assert.deepEqual(h.clipboard, []);
        h.component.disconnectedCallback();
    }
});

test('a refreshed server snapshot removes a link that was revoked elsewhere', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    await h.component.handleCreateInvitation();
    assert.equal(h.component.hasInvitationUrl, true);
    await h.component.pollSession();
    assert.equal(h.component.hasInvitationUrl, false);
    assert.equal(h.component.session.publisherInviteActive, false);
    assert.equal(h.component.isActive, true);
    h.component.disconnectedCallback();
});

const SITE_ORIGIN = 'https://demo.develop.my.site.com';
const SITE_PUBLISHER_URL = SITE_ORIGIN + '/LiveTracking/apex/TechnicianGpsInvite';

test('Experience viewers load the map from their own site path without putting credentials or session data in its URL', async () => {
    const h = harness({}, { viewerOrigin: SITE_ORIGIN, publisherPageUrl: SITE_PUBLISHER_URL });
    await h.component.handleCreateSession();
    await h.component.handleCreateInvitation();
    h.component.apiKey = 'desktop-only-map-key';
    await h.component.handleLoadMap();
    const url = new URL(h.component.frameUrl);
    assert.equal(url.origin, SITE_ORIGIN);
    assert.equal(url.pathname, '/LiveTracking/apex/TechnicianLiveMap');
    assert.equal(url.searchParams.get('parentOrigin'), SITE_ORIGIN);
    assert.equal(url.searchParams.get('channel'), h.component.channel);
    assert.deepEqual([...url.searchParams.keys()].sort(), ['channel', 'parentOrigin']);
    assert.equal(url.hash, '');
    assert.equal(url.href.includes(h.component.apiKey), false);
    assert.equal(url.href.includes(h.snapshot.sessionId), false);
    assert.equal(url.href.includes(INVITATION_TOKEN), false);
    assert.equal(h.component.session.mapPageUrl, h.snapshot.mapPageUrl);
    assert.equal(h.component.frameConnected, false);
    assert.equal(h.messages.length, 0);
    h.component.disconnectedCallback();
});

test('the trusted Experience site frame receives GPS and acknowledges the exact saved sample', async () => {
    const h = harness({}, { viewerOrigin: SITE_ORIGIN, publisherPageUrl: SITE_PUBLISHER_URL });
    await h.component.handleCreateSession();
    h.component.apiKey = '  desktop-only-map-key  ';
    const fix = phoneFix(h);
    h.component.applySnapshot(fix);
    await h.component.handleLoadMap();
    h.emit('frameReady', {}, { origin: SITE_ORIGIN });
    assert.equal(h.component.frameConnected, true);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].data.type, 'initialize');
    assert.equal(h.messages[0].data.apiKey, 'desktop-only-map-key');
    assert.equal(h.messages.some(item => item.data.type === 'position'), false);
    h.emit('mapReady', {}, { origin: SITE_ORIGIN });
    assert.equal(h.component.mapReady, true);
    assert.deepEqual(h.messages.find(item => item.data.type === 'position').data.position, {
        lat: fix.latitude, lng: fix.longitude
    });
    assert.equal(h.component.renderedMapSample, undefined);
    h.emit('positionRendered', renderedAcknowledgment(fix), { origin: SITE_ORIGIN });
    assert.equal(h.component.renderedMapSample, h.component.positionSample);
    assert.equal(h.messages.every(item => item.origin === SITE_ORIGIN), true);
    h.component.disconnectedCallback();
});

test('a ready message from the org frame or another window cannot receive the Experience map key', async () => {
    const h = harness({}, { viewerOrigin: SITE_ORIGIN, publisherPageUrl: SITE_PUBLISHER_URL });
    await h.component.handleCreateSession();
    h.component.apiKey = 'desktop-only-map-key';
    await h.component.handleLoadMap();
    for (const event of [
        { origin: 'https://demo--c.develop.vf.force.com' },
        { origin: 'https://other.develop.my.site.com' },
        { origin: 'https://untrusted.example' },
        { origin: SITE_ORIGIN, source: {} }
    ]) {
        h.emit('frameReady', {}, event);
        assert.equal(h.component.frameConnected, false);
        assert.equal(h.messages.length, 0);
    }
    h.emit('frameReady', {}, { origin: SITE_ORIGIN });
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].origin, SITE_ORIGIN);
    assert.equal(h.messages[0].data.apiKey, h.component.apiKey);
    h.component.disconnectedCallback();
});

test('map controls and early map-ready messages send nothing before a trusted frame-ready handshake', async () => {
    for (const options of [{}, { viewerOrigin: SITE_ORIGIN, publisherPageUrl: SITE_PUBLISHER_URL }]) {
        const h = harness({}, options);
        await h.component.handleCreateSession();
        h.component.apiKey = 'desktop-only-map-key';
        await h.component.handleLoadMap();
        const origin = options.viewerOrigin || 'https://demo--c.develop.vf.force.com';
        h.component.applySnapshot(phoneFix(h));
        h.component.handleFollowChange({ target: { checked: false } });
        h.component.handleFitMap();
        h.component.handleLocateTechnician();
        h.emit('mapReady', {}, { origin });
        assert.equal(h.component.mapReady, false);
        assert.equal(h.messages.length, 0);
        h.emit('frameReady', {}, { origin });
        assert.deepEqual(h.messages.map(item => item.data.type), ['initialize']);
        h.component.disconnectedCallback();
    }
});

test('mismatched Experience configuration fails closed without creating a frame or sending the map key', async () => {
    const h = harness({}, {
        viewerOrigin: SITE_ORIGIN,
        publisherPageUrl: 'https://another.my.site.com/LiveTracking/apex/TechnicianGpsInvite'
    });
    await h.component.handleCreateSession();
    h.component.apiKey = 'desktop-only-map-key';
    await h.component.handleLoadMap();
    assert.equal(h.component.frameUrl, undefined);
    assert.equal(h.component.frameOrigin, undefined);
    assert.equal(h.component.channel, undefined);
    assert.equal(h.component.isLoading, false);
    assert.match(h.component.mapError, /this Experience site/);
    assert.equal(h.component.mapKeyHelp.includes('another.my.site.com'), false);
    h.emit('frameReady', {}, { origin: 'https://another.my.site.com' });
    assert.equal(h.messages.length, 0);
    h.component.disconnectedCallback();
});

test('Lightning retains its own authenticated org frame and rejects another org map URL', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    h.component.apiKey = 'desktop-only-map-key';
    await h.component.handleLoadMap();
    assert.equal(new URL(h.component.frameUrl).origin, 'https://demo--c.develop.vf.force.com');
    h.emit('frameReady');
    assert.equal(h.messages[0].origin, 'https://demo--c.develop.vf.force.com');
    assert.equal(h.messages[0].data.apiKey, h.component.apiKey);
    h.component.disconnectedCallback();

    const wrongOrg = harness({}, { mapPageUrl: 'https://other--c.develop.vf.force.com/apex/TechnicianLiveMap' });
    await wrongOrg.component.handleCreateSession();
    wrongOrg.component.apiKey = 'desktop-only-map-key';
    await wrongOrg.component.handleLoadMap();
    assert.equal(wrongOrg.component.frameUrl, undefined);
    assert.match(wrongOrg.component.mapError, /this Salesforce org/);
    assert.equal(wrongOrg.messages.length, 0);
    wrongOrg.component.disconnectedCallback();
});

test('Google Maps website-key guidance names the actual map origin for each viewer', async () => {
    for (const [options, expectedOrigin, otherOrigin] of [
        [{}, 'https://demo--c.develop.vf.force.com', SITE_ORIGIN],
        [{ viewerOrigin: SITE_ORIGIN, publisherPageUrl: SITE_PUBLISHER_URL }, SITE_ORIGIN, 'https://demo--c.develop.vf.force.com']
    ]) {
        const h = harness({}, options);
        await h.component.handleCreateSession();
        assert.equal(h.component.mapKeyHelp.includes(expectedOrigin + '/*'), true);
        assert.equal(h.component.mapKeyHelp.includes(otherOrigin), false);
        h.component.disconnectedCallback();
    }
});

test('map connection timeouts distinguish site access, org-session access, and Google Maps loading', async () => {
    for (const options of [{}, { viewerOrigin: SITE_ORIGIN, publisherPageUrl: SITE_PUBLISHER_URL }]) {
        for (const frameReady of [false, true]) {
            const h = harness({}, options);
            await h.component.handleCreateSession();
            h.component.apiKey = 'desktop-only-map-key';
            await h.component.handleLoadMap();
            const timer = h.timeouts.get(h.component.loadTimer);
            assert.equal(timer.delay, 30000);
            if (frameReady) h.emit('frameReady', {}, {
                origin: options.viewerOrigin || 'https://demo--c.develop.vf.force.com'
            });
            timer.fn();
            assert.equal(h.component.isLoading, false);
            assert.equal(h.component.frameUrl, undefined);
            if (frameReady) assert.match(h.component.mapError, /Google Maps did not finish loading/);
            else if (options.viewerOrigin) assert.match(h.component.mapError, /site map.*TechnicianLiveMapScript is Public/);
            else assert.match(h.component.mapError, /org map.*session\/cookie settings/);
            h.component.disconnectedCallback();
        }
    }
});

test('saving the shared browser key completes before a frame opens and does not expose the key in URLs', async () => {
    let finish;
    const h = harness({ configureMaps: () => new Promise(resolve => { finish = resolve; }) });
    await h.component.handleCreateSession();
    h.component.apiKey = '  browser-key-for-this-session  ';
    const loading = h.component.handleLoadMap();
    assert.equal(h.component.busy, true);
    assert.equal(h.component.stopDisabled, true);
    assert.equal(h.component.frameUrl, undefined);
    const call = h.apiCalls.find(value => value.name === 'configureMaps');
    assert.equal(call.args.apiKey, 'browser-key-for-this-session');
    finish({ ...h.snapshot, browserMapsKey: call.args.apiKey });
    await loading;
    assert.equal(h.component.busy, false);
    assert.ok(h.component.frameUrl);
    assert.equal(h.component.frameUrl.includes('browser-key'), false);
    assert.equal([...h.storage.values()].some(value => value.includes('browser-key')), false);
    h.component.disconnectedCallback();
});

test('a timed-out map configuration cannot later open a frame or block session controls', async () => {
    let finish;
    const h = harness({ configureMaps: () => new Promise(resolve => { finish = resolve; }) });
    await h.component.handleCreateSession();
    h.component.apiKey = 'browser-key-for-this-session';
    const loading = h.component.handleLoadMap();
    const timer = h.timeouts.get(h.component.loadTimer);
    assert.equal(timer.delay, 22000);
    timer.fn();
    assert.equal(h.component.busy, false);
    assert.match(h.component.mapError, /could not be saved/);
    finish({ ...h.snapshot, browserMapsKey: h.component.apiKey });
    await loading;
    assert.equal(h.component.frameUrl, undefined);
    assert.ok(h.timeouts.has(h.component.pollTimer));
    h.component.disconnectedCallback();
});

test('customer viewing links have a separate fragment capability and independent revocation', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    await h.component.handleCreateInvitation();
    const phoneLink = h.component.invitationUrl;
    await h.component.handleCreateCustomerLink();
    const customerLink = new URL(h.component.customerUrl);
    assert.equal(customerLink.search, '');
    assert.equal(customerLink.hash, '#customer=' + 'ab'.repeat(32));
    assert.equal(customerLink.href.includes(h.component.sessionId), false);
    assert.equal(h.component.invitationUrl, phoneLink);
    await h.component.handleCopyCustomerLink();
    assert.equal(h.clipboard.at(-1), customerLink.href);
    await h.component.handleRevokeCustomerLink();
    assert.equal(h.component.customerUrl, '');
    assert.equal(h.component.isActive, true);
    assert.equal(h.component.invitationUrl, phoneLink);
    assert.ok(h.apiCalls.some(value => value.name === 'revokeCustomerLink'));
    h.component.disconnectedCallback();
});

test('invalid customer page configuration and disconnected issuance cannot expose a customer token', async () => {
    let finish;
    const h = harness({ issueCustomerLink: () => new Promise(resolve => { finish = resolve; }) });
    await h.component.handleCreateSession();
    h.component.publicCustomerPageUrl = 'https://untrusted.example/';
    await h.component.handleCreateCustomerLink();
    assert.equal(h.apiCalls.some(value => value.name === 'issueCustomerLink'), false);
    assert.ok(h.component.customerError);
    h.component.publicCustomerPageUrl = invitation.DEFAULT_CUSTOMER_PAGE_URL;
    const issuance = h.component.handleCreateCustomerLink();
    h.component.disconnectedCallback();
    finish({ token: 'ab'.repeat(32), expiresAtMs: h.snapshot.expiresAtMs });
    await issuance;
    assert.equal(h.component.customerUrl, '');
    assert.equal(h.component.customerBusy, false);
});

test('driving ETA accepts the trusted routing result and disappears when GPS becomes stale', async () => {
    const h = harness();
    await h.component.handleCreateSession();
    h.snapshot.latitude = 37.7800;
    h.snapshot.longitude = -122.4200;
    h.snapshot.capturedAtMs = h.component.now;
    h.snapshot.receivedAtMs = h.component.now;
    h.component.applySnapshot(h.snapshot);
    h.component.apiKey = 'browser-key';
    await h.component.handleLoadMap();
    h.emit('frameReady'); h.emit('mapReady');
    h.emit('routeUpdated', { state: 'ready', durationSeconds: 420, computedAtMs: h.component.now }, { origin: 'https://foreign.example' });
    assert.notEqual(h.component.etaLabel, '7 min');
    h.emit('routeUpdated', { state: 'ready', durationSeconds: 420, computedAtMs: h.component.now });
    assert.equal(h.component.etaLabel, '7 min');
    h.advance(16000);
    assert.equal(h.component.etaLabel, 'ETA paused');
    assert.equal(h.messages.at(-1).data.stale, true);
    h.component.disconnectedCallback();
});

test('Case session opens independently of owner storage and other agents cannot call owner mutations', async () => {
    const h = harness({}, { caseId: CASE_ID, trackingSessionId: SESSION_ID });
    await settle();
    assert.equal(h.component.sessionId, SESSION_ID);
    assert.equal(h.component.isReadOnly, true);
    assert.equal(h.component.waitingForOwnerKey, true);
    assert.equal(h.component.showCreateSession, false);
    assert.deepEqual(h.apiCalls[0], { name: 'getCaseSession', args: { caseId: CASE_ID, sessionId: SESSION_ID } });
    await h.component.handleCreateSession();
    await h.component.handleEndSession();
    await h.component.handleCreateInvitation();
    await h.component.handleRevokeInvitation();
    await h.component.handleCreateCustomerLink();
    await h.component.handleRevokeCustomerLink();
    await h.component.handleCopyLink();
    await h.component.handleCopySessionCode();
    h.component.handleKeyChange({ target: { value: 'unwanted-key-change' } });
    assert.equal(h.component.apiKey, '');
    assert.equal(h.clipboard.length, 0);
    assert.equal(h.apiCalls.every(call => call.name === 'getCaseSession'), true);
    assert.equal(h.storage.size, 0);
    h.component.disconnectedCallback();
});

test('Case viewer loads the shared map key without saving configuration and keeps reading live Case GPS', async () => {
    const h = harness({}, { caseId: CASE_ID, trackingSessionId: SESSION_ID, browserMapsKey: 'shared-browser-key' });
    await settle();
    assert.ok(h.component.frameUrl);
    assert.equal(h.apiCalls.some(call => call.name === 'configureMaps'), false);
    h.emit('frameReady'); h.emit('mapReady');
    assert.equal(h.messages.find(message => message.data.type === 'initialize').data.apiKey, 'shared-browser-key');
    Object.assign(h.snapshot, { latitude: 37.7800, longitude: -122.4100, capturedAtMs: h.component.now, receivedAtMs: h.component.now });
    await h.component.pollSession();
    assert.deepEqual(h.messages.find(message => message.data.type === 'position').data.position, { lat: 37.7800, lng: -122.4100 });
    assert.equal(h.apiCalls.every(call => call.name === 'getCaseSession'), true);
    assert.equal(h.storage.size, 0);
    h.component.disconnectedCallback();
});

test('Case read failure clears the map, key and coordinates and requires an explicit retry', async () => {
    let rejectRead = false;
    const h = harness({ getCaseSession: async () => {
        if (rejectRead) throw new Error('Case access is unavailable.');
        return { ...h.snapshot, latitude: 37.7800, longitude: -122.4100 };
    } }, { caseId: CASE_ID, trackingSessionId: SESSION_ID, browserMapsKey: 'shared-browser-key' });
    await settle();
    assert.ok(h.component.frameUrl);
    rejectRead = true;
    await h.component.pollSession();
    assert.equal(h.component.session, undefined);
    assert.equal(h.component.apiKey, '');
    assert.equal(h.component.frameUrl, undefined);
    assert.equal(h.timeouts.has(h.component.pollTimer), false);
    assert.match(h.component.sessionError, /Case access/);
    rejectRead = false;
    await h.component.handleRetrySession();
    await settle();
    assert.equal(h.component.sessionId, SESSION_ID);
    h.component.disconnectedCallback();
});

test('Case read timeout and disconnect reject late GPS responses without restoring access', async () => {
    for (const disconnect of [false, true]) {
        let finish;
        const h = harness({ getCaseSession: () => new Promise(resolve => { finish = resolve; }) },
            { caseId: CASE_ID, trackingSessionId: SESSION_ID });
        await settle();
        if (disconnect) h.component.disconnectedCallback();
        else [...h.timeouts.values()].find(timer => timer.delay === 22000).fn();
        await settle();
        finish({ ...h.snapshot, browserMapsKey: 'late-key', latitude: 37.7800, longitude: -122.4100 });
        await settle();
        assert.equal(h.component.session, undefined);
        assert.equal(h.component.frameUrl, undefined);
        assert.equal(h.component.apiKey, '');
        if (!disconnect) assert.match(h.component.sessionError, /timed out/);
        h.component.disconnectedCallback();
    }
});

test('a mismatched Case response cannot open a different session and missing manage flag never grants controls', async () => {
    const h = harness({ getCaseSession: async () => ({ ...h.snapshot, caseId: '500000000000002AAA' }) },
        { caseId: CASE_ID, trackingSessionId: SESSION_ID });
    await settle();
    assert.equal(h.component.session, undefined);
    assert.match(h.component.sessionError, /does not belong/);
    h.component.applySnapshot({ ...h.snapshot, canManage: undefined });
    assert.equal(h.component.canManageSession, false);
    h.component.disconnectedCallback();
});

test('a Case viewer waiting for map setup automatically connects when the owner saves its key', async () => {
    const h = harness({}, { caseId: CASE_ID, trackingSessionId: SESSION_ID });
    await settle();
    assert.equal(h.component.frameUrl, undefined);
    h.snapshot.browserMapsKey = 'new-owner-browser-key';
    await h.component.pollSession();
    await settle();
    assert.ok(h.component.frameUrl);
    assert.equal(h.component.showKeyControls, false);
    assert.equal(h.apiCalls.some(call => call.name === 'configureMaps'), false);
    h.component.disconnectedCallback();
});

test('Case owner end notifies history while ended sessions remain visible without polling or creating another session', async () => {
    const h = harness({}, { caseId: CASE_ID, trackingSessionId: SESSION_ID, canManage: true });
    await settle();
    assert.equal(h.component.canManageSession, true);
    await h.component.handleEndSession();
    assert.equal(h.component.isHistorySession, true);
    assert.deepEqual(h.events.map(event => event.type), ['sessionended']);
    assert.equal(h.timeouts.has(h.component.pollTimer), false);
    assert.equal(h.component.loadDisabled, true);
    assert.equal(h.component.sessionId, SESSION_ID);
    assert.equal(h.storage.size, 0);
    h.component.disconnectedCallback();
});
