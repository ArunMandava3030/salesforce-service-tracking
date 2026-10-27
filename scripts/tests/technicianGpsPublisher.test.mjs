import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
    new URL('../../force-app/main/default/staticresources/TechnicianGpsPublisherScript.js', import.meta.url),
    'utf8'
);

function makeHarness(runScript, options = {}) {
    let now = 1800000000000;
    let nextTimer = 1;
    const timers = new Map();
    const calls = [];
    const watches = [];
    const cleared = [];
    const mapCalls = [];
    const windowEvents = new Map();
    const documentEvents = new Map();
    const names = [
        'start', 'stop', 'status', 'expires', 'sent', 'coordinates', 'accuracy', 'captured',
        'session-recovery', 'session-input', 'session-code', 'connect', 'connect-form', 'phone-map-status'
    ];
    const nodes = Object.fromEntries(names.map((name) => [name, {
        textContent: '',
        disabled: false,
        hidden: false,
        value: '',
        listeners: {},
        addEventListener(event, callback) { this.listeners[event] = callback; },
        focus() { this.focused = true; }
    }]));
    nodes['session-recovery'].hidden = true;
    nodes['session-code'].textContent = 'Not connected';
    const attributes = {
        'data-action-get': 'TechnicianLiveTrackingController.getPhoneSession',
        'data-action-publish': 'TechnicianLiveTrackingController.publishLocation',
        'data-action-stop': 'TechnicianLiveTrackingController.stopSharing'
    };
    if (options.invitation) {
        attributes['data-publisher-mode'] = 'invitation';
        attributes['data-action-get'] = 'TechnicianGpsInvitationController.getPublisherStatus';
        attributes['data-action-publish'] = 'TechnicianGpsInvitationController.publishLocation';
        attributes['data-action-stop'] = 'TechnicianGpsInvitationController.stopPublishing';
    }
    if (options.phoneMap) {
        attributes['data-action-directions'] = options.invitation
            ? 'TechnicianGpsInvitationController.getDirections' : 'TechnicianLiveTrackingController.getPhoneDirections';
    }
    const panel = {
        getAttribute(name) { return attributes[name] || null; },
        setAttribute(name, value) { attributes[name] = value; },
        querySelector(selector) { return nodes[selector.slice(6, -1)] || null; }
    };
    const document = {
        readyState: options.loading ? 'loading' : 'complete',
        querySelector() { return options.noPanel ? null : panel; },
        addEventListener(event, callback) { documentEvents.set(event, callback); }
    };
    class MockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const snapshot = (overrides = {}) => ({
        ...(options.invitation ? {} : { sessionId: 'a01000000000001AAA' }),
        active: true,
        expired: false,
        expiresAtMs: now + 1800000,
        receivedAtMs: now,
        ...(options.invitation ? { acceptedCapturedAtMs: now } : {}),
        ...overrides
    });
    const navigator = {
        onLine: true,
        geolocation: {
            watchPosition(success, error, watchOptions) {
                const id = watches.length + 1;
                watches.push({ id, success, error, options: watchOptions });
                return id;
            },
            clearWatch(id) { cleared.push(id); }
        }
    };
    const window = {
        location: {
            href: options.href || 'https://sample.vf.force.com/apex/TechnicianGpsPublisher?sessionId=a01000000000001AAA',
            protocol: 'https:',
            reload() { window.reloaded = true; }
        },
        isSecureContext: true,
        setTimeout(callback, delay) {
            const id = nextTimer++;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        addEventListener(event, callback) { windowEvents.set(event, callback); },
        Visualforce: {
            remoting: {
                Manager: {
                    invokeAction(action, ...args) {
                        const remoteOptions = args.pop();
                        const callback = args.pop();
                        const call = { action, args, callback, options: remoteOptions, at: now };
                        calls.push(call);
                        if ((action.endsWith('.getPhoneSession') || action.endsWith('.getPublisherStatus')) && options.autoGet !== false) {
                            callback(snapshot(options.snapshot), { status: true });
                        }
                    }
                }
            }
        }
    };
    window.self = window;
    if (options.phoneMap) {
        window.TechnicianPhoneMap = { create() {
            return Object.fromEntries(['configure', 'update', 'pause', 'dispose'].map(name => [name, value => {
                mapCalls.push({ name, value });
                if (options.mapThrows === name) throw new Error('map unavailable');
                if (name === 'configure') return Promise.resolve(true);
            }]));
        } };
    }
    window.top = options.iframe ? {} : window;
    if (options.noStatus) {
        delete nodes.status;
    }
    if (options.insecure) {
        window.isSecureContext = false;
    }
    const sandbox = { window, document, navigator, URL, URLSearchParams, Date: MockDate };
    runScript(sandbox);
    function advance(milliseconds) {
        const target = now + milliseconds;
        let count = 0;
        while (true) {
            const next = [...timers.entries()]
                .filter(([, item]) => item.at <= target)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) {
                break;
            }
            if (++count > 1000) {
                throw new Error('Too many scheduled timers');
            }
            now = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
        }
        now = target;
    }
    return {
        window, navigator, nodes, calls, watches, cleared, timers, mapCalls,
        now: () => now,
        snapshot,
        advance,
        actions: (suffix) => calls.filter((call) => call.action.endsWith('.' + suffix)),
        click: (name) => nodes[name].listeners.click(),
        connect(value) {
            nodes['session-input'].value = value;
            const event = { prevented: false, preventDefault() { this.prevented = true; } };
            nodes['connect-form'].listeners.submit(event);
            return event;
        },
        event: (name, event = {}) => windowEvents.get(name)?.(event),
        domReady: () => documentEvents.get('DOMContentLoaded')?.(),
        fix(latitude = 37.7730, longitude = -122.4210, accuracy = 8, timestamp = now, index = watches.length - 1) {
            watches[index].success({ coords: { latitude, longitude, accuracy }, timestamp });
        },
        gpsError(code, index = watches.length - 1) { watches[index].error({ code }); },
        reply(call, overrides = {}) { call.callback(snapshot(overrides), { status: true }); },
        fail(call, message = 'secret-session-cookie') { call.callback(null, { status: false, message }); }
    };
}

function harness(options) {
    return makeHarness((sandbox) => vm.runInNewContext(source, sandbox), options);
}

test('validates before sharing and asks for GPS only after Start', () => {
    const h = harness();
    assert.equal(h.watches.length, 0);
    assert.equal(h.nodes.start.disabled, false);
    h.click('start');
    assert.equal(h.watches.length, 1);
    assert.equal(h.watches[0].options.enableHighAccuracy, true);
    assert.equal(h.watches[0].options.maximumAge, 0);
    assert.equal(h.watches[0].options.timeout, 15000);
});

test('publishes the actual timestamp and retains only the latest fix during the throttle', () => {
    const h = harness();
    h.click('start');
    const firstTimestamp = h.now();
    h.fix(37.7730, -122.4210);
    const first = h.actions('publishLocation')[0];
    assert.equal(first.args[4], firstTimestamp);
    h.reply(first);
    h.advance(1000);
    h.fix(37.7740, -122.4200);
    h.advance(1000);
    h.fix(37.7750, -122.4190);
    assert.equal(h.actions('publishLocation').length, 1);
    h.advance(999);
    assert.equal(h.actions('publishLocation').length, 1);
    h.advance(1);
    const second = h.actions('publishLocation')[1];
    assert.equal(second.args[1], 37.7750);
    assert.equal(second.args[4], firstTimestamp + 2000);
    assert.equal(second.at - first.at, 3000);
});

test('never overlaps uploads and still sends a newer timestamp at unchanged coordinates', () => {
    const h = harness();
    h.click('start');
    h.fix();
    const first = h.actions('publishLocation')[0];
    h.advance(3500);
    h.fix();
    assert.equal(h.actions('publishLocation').length, 1);
    h.reply(first);
    assert.equal(h.actions('publishLocation').length, 2);
    const second = h.actions('publishLocation')[1];
    assert.equal(second.args[1], first.args[1]);
    assert.equal(second.args[2], first.args[2]);
    assert.ok(second.args[4] > first.args[4]);
});

test('Stop clears GPS immediately and ends the server session after an in-flight upload', () => {
    const h = harness();
    h.click('start');
    h.fix();
    const first = h.actions('publishLocation')[0];
    h.advance(100);
    h.fix(37.7740);
    h.click('stop');
    assert.equal(h.cleared.length, 1);
    assert.equal(h.actions('stopSharing').length, 0);
    h.advance(4000);
    h.fix(37.7760);
    assert.equal(h.actions('publishLocation').length, 1);
    h.reply(first);
    assert.equal(h.actions('stopSharing').length, 1);
    assert.equal(h.actions('publishLocation').length, 1);
    h.reply(h.actions('stopSharing')[0], { active: false });
    assert.match(h.nodes.status.textContent, /session has ended/);
    assert.equal(h.nodes.start.disabled, true);
});

test('failed Stop does not claim the session ended and allows a retry', () => {
    const h = harness();
    h.click('start');
    h.click('stop');
    h.fail(h.actions('stopSharing')[0]);
    assert.match(h.nodes.status.textContent, /could not confirm/);
    assert.equal(h.nodes.start.disabled, true);
    assert.equal(h.nodes.stop.disabled, false);
    h.click('stop');
    assert.equal(h.actions('stopSharing').length, 2);
});

test('three failed uploads pause GPS with bounded backoff and no sensitive server error', () => {
    const h = harness();
    h.click('start');
    h.fix();
    h.fail(h.actions('publishLocation')[0]);
    h.advance(2999);
    assert.equal(h.actions('publishLocation').length, 1);
    h.advance(1);
    h.fail(h.actions('publishLocation')[1]);
    h.advance(6000);
    h.fail(h.actions('publishLocation')[2]);
    h.advance(30000);
    assert.equal(h.actions('publishLocation').length, 3);
    assert.equal(h.cleared.length, 1);
    assert.match(h.nodes.status.textContent, /three failed uploads/);
    assert.doesNotMatch(h.nodes.status.textContent, /secret/);
    assert.equal(h.nodes.start.disabled, false);
});

test('expired sessions stop GPS and clear a scheduled upload', () => {
    const h = harness({ snapshot: { expiresAtMs: 1800000002000 } });
    h.click('start');
    h.fix();
    h.reply(h.actions('publishLocation')[0], { expiresAtMs: 1800000002000 });
    h.advance(1000);
    h.fix();
    h.advance(2000);
    assert.equal(h.actions('publishLocation').length, 1);
    assert.equal(h.cleared.length, 1);
    assert.equal(h.nodes.start.disabled, true);
    assert.match(h.nodes.status.textContent, /expired/);
});

test('permission denial stops the watcher and explains how to retry', () => {
    const h = harness();
    h.click('start');
    h.gpsError(1);
    h.fix();
    assert.equal(h.actions('publishLocation').length, 0);
    assert.equal(h.cleared.length, 1);
    assert.equal(h.nodes.start.disabled, false);
    assert.match(h.nodes.status.textContent, /permission was denied/);
});

test('offline fixes are retained only while fresh', () => {
    const h = harness();
    h.click('start');
    h.navigator.onLine = false;
    h.fix();
    assert.equal(h.actions('publishLocation').length, 0);
    h.advance(120001);
    h.navigator.onLine = true;
    h.event('online');
    assert.equal(h.actions('publishLocation').length, 0);
    h.fix();
    assert.equal(h.actions('publishLocation').length, 1);
});

test('rejects invalid bounds, nonnumeric values, and stale GPS timestamps', () => {
    const h = harness();
    h.click('start');
    h.fix(91);
    h.fix(18, 181);
    h.fix('37.7700');
    h.fix(18, 73, -1);
    h.fix(18, 73, 8, h.now() - 120001);
    h.fix(18, 73, 8, h.now() + 30001);
    assert.equal(h.actions('publishLocation').length, 0);
});

test('pagehide cancels pending sends and late callbacks cannot restart GPS', () => {
    const h = harness();
    h.click('start');
    h.fix();
    h.advance(1000);
    h.fix();
    h.event('pagehide');
    h.reply(h.actions('publishLocation')[0]);
    h.fix();
    h.advance(10000);
    assert.equal(h.actions('publishLocation').length, 1);
    assert.equal(h.actions('stopSharing').length, 0);
    assert.equal(h.cleared.length, 1);
    assert.equal(h.timers.size, 0);
    assert.match(h.nodes.status.textContent, /may still be active/);
    h.event('pageshow', { persisted: true });
    assert.equal(h.window.reloaded, true);
});

test('DOM readiness is respected and a missing status node never crashes initialization', () => {
    const h = harness({ loading: true, noStatus: true });
    assert.equal(h.calls.length, 0);
    h.domReady();
    h.domReady();
    assert.equal(h.actions('getPhoneSession').length, 1);
    h.click('start');
    h.fix();
    assert.equal(h.actions('publishLocation').length, 1);
});

test('requires a secure top-level page and rejects ended sessions', () => {
    const insecure = harness({ insecure: true });
    assert.equal(insecure.calls.length, 0);
    const embedded = harness({ iframe: true });
    assert.equal(embedded.calls.length, 0);
    const ended = harness({ snapshot: { active: false } });
    ended.click('start');
    assert.equal(ended.watches.length, 0);
    assert.match(ended.nodes.status.textContent, /has ended/);
});

const phonePageUrl = 'https://sample.vf.force.com/apex/TechnicianGpsPublisher';
const trackingCode = 'a01AbC000000001AAA';

test('missing URL session offers recovery and enables GPS only after validated Connect and Start', () => {
    const h = harness({ href: phonePageUrl, autoGet: false });
    assert.equal(h.nodes.start.disabled, true);
    assert.equal(h.nodes['session-recovery'].hidden, false);
    assert.equal(h.actions('getPhoneSession').length, 0);
    assert.equal(h.nodes['session-code'].textContent, 'Not connected');

    const event = h.connect(trackingCode);
    assert.equal(event.prevented, true);
    const validation = h.actions('getPhoneSession')[0];
    assert.equal(validation.args[0], trackingCode);
    assert.equal(h.nodes.start.disabled, true);
    assert.equal(h.watches.length, 0);

    h.reply(validation, { sessionId: trackingCode });
    assert.equal(h.nodes['session-code'].textContent, trackingCode);
    assert.equal(h.nodes.start.disabled, false);
    assert.equal(h.watches.length, 0);
    h.click('start');
    assert.equal(h.watches.length, 1);
    h.fix();
    assert.equal(h.actions('publishLocation')[0].args[0], trackingCode);
});

test('URL parameter names are case insensitive and record ID values retain their case', () => {
    for (const key of ['sessionId', 'sessionid', 'SESSIONID', 'SeSsIoNiD']) {
        const h = harness({
            href: phonePageUrl + '?' + key + '=' + trackingCode,
            snapshot: { sessionId: trackingCode }
        });
        assert.equal(h.actions('getPhoneSession')[0].args[0], trackingCode);
        assert.equal(h.nodes.start.disabled, false);
        assert.equal(h.watches.length, 0);
    }
});

test('URL session values and pasted full phone links allow surrounding whitespace', () => {
    const initial = harness({
        href: phonePageUrl + '?sessionid=%20' + trackingCode + '%20',
        snapshot: { sessionId: trackingCode }
    });
    assert.equal(initial.actions('getPhoneSession')[0].args[0], trackingCode);
    const recovered = harness({ href: phonePageUrl, autoGet: false });
    recovered.connect('  ' + phonePageUrl + '?SESSIONID=%20' + trackingCode + '%20\n');
    assert.equal(recovered.actions('getPhoneSession')[0].args[0], trackingCode);
    assert.equal(recovered.nodes.start.disabled, true);
});

test('recovery accepts anchored 15-character and 18-character record IDs', () => {
    for (const code of [trackingCode.slice(0, 15), trackingCode]) {
        const h = harness({ href: phonePageUrl, autoGet: false });
        h.connect('  ' + code + '  ');
        assert.equal(h.actions('getPhoneSession')[0].args[0], code);
        assert.equal(h.watches.length, 0);
    }
});

test('invalid, missing, prose, HTTP and conflicting session inputs never call Apex', () => {
    const h = harness({ href: phonePageUrl, autoGet: false });
    for (const input of [
        '',
        '   ',
        'short-code',
        'a01AbC000000001AA',
        'Please use ' + trackingCode + ' to connect',
        'javascript:alert(1)?sessionId=' + trackingCode,
        'http://sample.vf.force.com/apex/TechnicianGpsPublisher?sessionId=' + trackingCode,
        'https://[',
        phonePageUrl,
        phonePageUrl + '?sessionId=',
        phonePageUrl + '?sessionId=' + trackingCode + '&sessionId=a01000000000001AAA',
        phonePageUrl + '?SESSIONID=' + trackingCode + '&sessionid=a01000000000001AAA'
    ]) {
        h.connect(input);
        assert.equal(h.actions('getPhoneSession').length, 0, input);
        assert.equal(h.nodes.start.disabled, true, input);
        assert.equal(h.nodes['session-recovery'].hidden, false, input);
    }
});

test('a conflicting initial URL session is rejected and can be recovered explicitly', () => {
    const h = harness({
        href: phonePageUrl + '?sessionid=' + trackingCode + '&SESSIONID=a01000000000001AAA',
        autoGet: false
    });
    assert.equal(h.actions('getPhoneSession').length, 0);
    assert.equal(h.nodes.start.disabled, true);
    assert.equal(h.nodes['session-recovery'].hidden, false);
    h.connect(trackingCode);
    assert.equal(h.actions('getPhoneSession')[0].args[0], trackingCode);
});

test('failed owner validation keeps GPS blocked and allows a fresh Connect attempt', () => {
    const h = harness({ autoGet: false });
    const first = h.actions('getPhoneSession')[0];
    h.fail(first);
    assert.equal(h.nodes['session-code'].textContent, 'Not connected');
    assert.equal(h.nodes.start.disabled, true);
    assert.equal(h.nodes['session-recovery'].hidden, false);
    assert.equal(h.nodes.connect.disabled, false);
    assert.equal(h.watches.length, 0);
    h.connect(trackingCode);
    const retry = h.actions('getPhoneSession')[1];
    assert.equal(retry.args[0], trackingCode);
    h.reply(retry, { sessionId: trackingCode });
    assert.equal(h.nodes['session-code'].textContent, trackingCode);
    assert.equal(h.nodes.start.disabled, false);
    assert.equal(h.watches.length, 0);
});

test('validation times out after 22 seconds and late responses cannot override a retry', () => {
    const h = harness({ autoGet: false });
    const first = h.actions('getPhoneSession')[0];
    h.advance(21999);
    assert.equal(h.nodes.start.disabled, true);
    h.advance(1);
    assert.equal(h.nodes['session-recovery'].hidden, false);
    assert.equal(h.nodes.connect.disabled, false);
    h.reply(first);
    assert.equal(h.nodes.start.disabled, true);

    h.connect(trackingCode);
    const retry = h.actions('getPhoneSession')[1];
    h.reply(first);
    assert.equal(h.nodes.start.disabled, true);
    h.reply(retry, { sessionId: trackingCode });
    assert.equal(h.nodes.start.disabled, false);
    h.reply(first, { active: false, expired: true });
    assert.equal(h.nodes.start.disabled, false);
    assert.equal(h.watches.length, 0);
});

test('ended and expired recovery sessions never enable GPS', () => {
    for (const snapshot of [
        { active: false },
        { active: false, expired: true },
        { active: true, expiresAtMs: 1799999999999 }
    ]) {
        const h = harness({ href: phonePageUrl, autoGet: false });
        h.connect(trackingCode);
        h.reply(h.actions('getPhoneSession')[0], { sessionId: trackingCode, ...snapshot });
        assert.equal(h.nodes['session-code'].textContent, 'Not connected');
        assert.equal(h.nodes.start.disabled, true);
        h.click('start');
        assert.equal(h.watches.length, 0);
    }
});

test('a connected session cannot be replaced by submitting another code', () => {
    const h = harness();
    h.connect(trackingCode);
    assert.equal(h.actions('getPhoneSession').length, 1);
    h.click('start');
    h.fix();
    assert.equal(h.actions('publishLocation')[0].args[0], 'a01000000000001AAA');
});

test('pagehide invalidates pending validation and clears its timeout', () => {
    const h = harness({ autoGet: false });
    h.event('pagehide');
    h.reply(h.actions('getPhoneSession')[0]);
    h.advance(22000);
    assert.equal(h.nodes.start.disabled, true);
    assert.equal(h.watches.length, 0);
    assert.equal(h.timers.size, 0);
});

test('connected tracking code uses the validated server ID and falls back to the submitted ID', () => {
    for (const returnedId of [trackingCode, undefined]) {
        const h = harness({ href: phonePageUrl, autoGet: false });
        const submittedId = trackingCode.slice(0, 15);
        h.connect(submittedId);
        assert.equal(h.nodes['session-code'].textContent, 'Not connected');
        h.reply(h.actions('getPhoneSession')[0], { sessionId: returnedId });
        assert.equal(h.nodes['session-code'].textContent, returnedId || submittedId);
        assert.equal(h.watches.length, 0);
    }
});

const invitationCode = '0123456789abcdef'.repeat(4);
const invitePageUrl = 'https://sample.my.site.com/LiveTracking/apex/TechnicianGpsInvite';

function invitationHarness(options = {}) {
    return harness({
        invitation: true,
        href: invitePageUrl + '#invite=' + invitationCode,
        ...options
    });
}

test('a guest invitation validates its token and starts GPS only after explicit Start', () => {
    const h = invitationHarness();
    const validation = h.actions('getPublisherStatus')[0];
    assert.deepEqual(validation.args, [invitationCode]);
    assert.equal(h.actions('getPhoneSession').length, 0);
    assert.equal(h.watches.length, 0);
    assert.equal(h.nodes.start.disabled, false);
    assert.equal(h.nodes['session-code'].textContent, 'Not connected');

    h.click('start');
    h.fix(37.7740, -122.4210, 6);
    const upload = h.actions('publishLocation')[0];
    assert.equal(upload.action, 'TechnicianGpsInvitationController.publishLocation');
    assert.equal(upload.args[0], invitationCode);
    assert.equal(upload.args.length, 5);
    assert.equal(upload.args[1], 37.7740);
    assert.equal(upload.args[4], h.now());
    h.reply(upload);
    assert.match(h.nodes.status.textContent, /Sharing live GPS with the map/);
    const renderedText = Object.values(h.nodes).map(node => node.textContent).join(' ');
    assert.equal(renderedText.includes(invitationCode), false);
    assert.doesNotMatch(renderedText, /a01000000000001AAA/);
});

test('invitation recovery accepts only a full fragment link or a 64-hex code and clears the pasted secret after connecting', () => {
    for (const input of [
        '  ' + invitationCode.toUpperCase() + '  ',
        ' ' + invitePageUrl + '#INVITE=%20' + invitationCode.toUpperCase() + '%20 ',
        invitePageUrl + '#invite=' + invitationCode + '&INVITE=' + invitationCode.toUpperCase()
    ]) {
        const h = invitationHarness({ href: invitePageUrl, autoGet: false });
        assert.equal(h.nodes.start.disabled, true);
        h.connect(input);
        const validation = h.actions('getPublisherStatus')[0];
        assert.equal(validation.args[0], invitationCode);
        assert.equal(h.watches.length, 0);
        h.reply(validation);
        assert.equal(h.nodes.start.disabled, false);
        assert.equal(h.nodes['session-input'].value, '');
        assert.equal(h.nodes['session-code'].textContent, 'Not connected');
    }
});

test('guest invitation mode rejects record IDs, query tokens and malformed or conflicting fragments before Apex', () => {
    const h = invitationHarness({ href: invitePageUrl, autoGet: false });
    for (const input of [
        '',
        trackingCode,
        phonePageUrl + '?sessionId=' + trackingCode,
        invitePageUrl + '?invite=' + invitationCode,
        invitePageUrl + '?INVITE=' + invitationCode + '#invite=' + invitationCode,
        invitePageUrl + '?customer=' + 'f'.repeat(64) + '#invite=' + invitationCode,
        invitePageUrl + '#customer=' + 'f'.repeat(64) + '&invite=' + invitationCode,
        invitePageUrl + '#invite=' + invitationCode + '&CUSTOMER=' + 'f'.repeat(64),
        invitePageUrl + '#invite=',
        invitePageUrl + '#invite=' + invitationCode.slice(0, 63),
        invitePageUrl + '#invite=' + 'g'.repeat(64),
        invitePageUrl + '#invite=' + invitationCode + '&invite=' + 'f'.repeat(64),
        invitePageUrl + '#invite=' + invitationCode + '&invite=',
        'http://sample.my.site.com/LiveTracking/apex/TechnicianGpsInvite#invite=' + invitationCode,
        'Use this invitation ' + invitationCode
    ]) {
        h.connect(input);
        assert.equal(h.actions('getPublisherStatus').length, 0, input);
        assert.equal(h.actions('getPhoneSession').length, 0, input);
        assert.equal(h.nodes.start.disabled, true, input);
    }
});

test('guest Stop waits for an in-flight upload and revokes only the invitation endpoint', () => {
    const h = invitationHarness();
    h.click('start');
    h.fix();
    const upload = h.actions('publishLocation')[0];
    h.click('stop');
    assert.equal(h.cleared.length, 1);
    assert.equal(h.actions('stopPublishing').length, 0);
    h.reply(upload);
    const stop = h.actions('stopPublishing')[0];
    assert.deepEqual(stop.args, [invitationCode]);
    assert.equal(h.actions('stopSharing').length, 0);
    h.reply(stop, { active: false });
    assert.match(h.nodes.status.textContent, /invitation is no longer active/);
    assert.doesNotMatch(h.nodes.status.textContent, /tracking session has ended/);
    assert.equal(h.nodes.start.disabled, true);
});

test('revoked, expired and rejected invitations keep GPS blocked without leaking a token or asking for Salesforce login', () => {
    for (const snapshot of [
        { active: false },
        { active: false, expired: true },
        { active: true, expiresAtMs: 1799999999999 }
    ]) {
        const h = invitationHarness({ autoGet: false });
        h.reply(h.actions('getPublisherStatus')[0], snapshot);
        assert.equal(h.nodes.start.disabled, true);
        assert.match(h.nodes.status.textContent, /new phone link/);
        assert.doesNotMatch(h.nodes.status.textContent, /sign in|sign-in/i);
        h.click('start');
        assert.equal(h.watches.length, 0);
    }
    const denied = invitationHarness({ autoGet: false });
    denied.fail(denied.actions('getPublisherStatus')[0]);
    assert.equal(denied.nodes.start.disabled, true);
    assert.match(denied.nodes.status.textContent, /new phone link/);
    assert.doesNotMatch(denied.nodes.status.textContent, /sign in|sign-in|secret-session-cookie/i);
    assert.equal(denied.nodes.status.textContent.includes(invitationCode), false);
});

test('invitation expiry clears GPS and pending sends without ending the owner session', () => {
    const h = invitationHarness({ snapshot: { expiresAtMs: 1800000002000 } });
    h.click('start');
    h.fix();
    h.reply(h.actions('publishLocation')[0], { expiresAtMs: 1800000002000 });
    h.advance(1000);
    h.fix();
    h.advance(1000);
    assert.equal(h.cleared.length, 1);
    assert.equal(h.actions('publishLocation').length, 1);
    assert.equal(h.actions('stopSharing').length, 0);
    assert.equal(h.nodes.start.disabled, true);
    assert.match(h.nodes.status.textContent, /invitation has expired/);
});

test('a delayed guest validation cannot unlock sharing after its timeout or override a replacement invitation', () => {
    const h = invitationHarness({ autoGet: false });
    const initial = h.actions('getPublisherStatus')[0];
    h.advance(22000);
    assert.equal(h.nodes.start.disabled, true);
    assert.equal(h.nodes['session-recovery'].hidden, false);
    const replacementCode = 'f'.repeat(64);
    h.connect(replacementCode);
    h.reply(initial);
    assert.equal(h.nodes.start.disabled, true);
    h.reply(h.actions('getPublisherStatus')[1]);
    h.click('start');
    h.fix();
    assert.equal(h.actions('publishLocation')[0].args[0], replacementCode);
    assert.equal(Object.values(h.nodes).some(node => node.textContent.includes(replacementCode)), false);
});

test('the private publisher does not treat an invitation token as an owner tracking record ID', () => {
    const h = harness({ href: phonePageUrl, autoGet: false });
    h.connect(invitationCode);
    assert.equal(h.calls.length, 0);
    assert.equal(h.nodes.start.disabled, true);
    h.connect(trackingCode);
    assert.equal(h.actions('getPhoneSession')[0].args[0], trackingCode);
});

test('phone map configuration is fetched only after validation and never starts GPS', () => {
    for (const invitation of [false, true]) {
        const h = invitation ? invitationHarness({ phoneMap: true, autoGet: false }) : harness({ phoneMap: true, autoGet: false });
        const validation = h.actions(invitation ? 'getPublisherStatus' : 'getPhoneSession')[0];
        const action = invitation ? 'getDirections' : 'getPhoneDirections';
        assert.equal(h.actions(action).length, 0);
        h.reply(validation);
        assert.equal(h.actions(action).length, 1);
        assert.equal(h.actions(action)[0].args[0], invitation ? invitationCode : 'a01000000000001AAA');
        h.reply(h.actions(action)[0], {
            customerLatitude: 37.7749, customerLongitude: -122.4194, browserMapsKey: 'owner-configured-browser-key'
        });
        assert.equal(h.mapCalls.filter(call => call.name === 'configure').length, 1);
        assert.equal(h.watches.length, 0);
        assert.equal(h.nodes.start.disabled, false);
        const visible = Object.values(h.nodes).map(node => node.textContent).join(' ');
        assert.equal(visible.includes('owner-configured-browser-key'), false);
        h.event('pagehide');
    }
});

test('missing map setup retries every ten seconds without blocking GPS or overlapping configuration calls', () => {
    const h = invitationHarness({ phoneMap: true });
    const first = h.actions('getDirections')[0];
    h.click('start');
    assert.equal(h.actions('getDirections').length, 1);
    h.fix();
    assert.equal(h.actions('publishLocation').length, 1);
    assert.equal(h.mapCalls.filter(call => call.name === 'update').length, 1);
    h.reply(first, { browserMapsKey: null });
    h.advance(9999);
    assert.equal(h.actions('getDirections').length, 1);
    h.advance(1);
    assert.equal(h.actions('getDirections').length, 2);
    h.advance(10000);
    assert.equal(h.actions('getDirections').length, 2);
    h.reply(h.actions('getDirections')[1], {
        customerLatitude: 37.7749, customerLongitude: -122.4194, browserMapsKey: 'owner-configured-browser-key'
    });
    h.advance(10000);
    assert.equal(h.actions('getDirections').length, 2);
    h.event('pagehide');
});

test('late configuration after Stop, expiry, or pagehide cannot load a map or schedule a retry', () => {
    for (const operation of ['stop', 'expiry', 'pagehide']) {
        const h = invitationHarness({ phoneMap: true, snapshot: { expiresAtMs: 1800000001000 } });
        const config = h.actions('getDirections')[0];
        if (operation === 'stop') h.click('stop');
        else if (operation === 'expiry') h.advance(1000);
        else h.event('pagehide');
        h.reply(config, { browserMapsKey: 'owner-configured-browser-key', customerLatitude: 37.7749, customerLongitude: -122.4194 });
        h.advance(30000);
        assert.equal(h.mapCalls.some(call => call.name === 'configure'), false);
        assert.equal(h.actions('getDirections').length, 1);
        assert.equal(h.mapCalls.some(call => call.name === 'dispose'), true);
    }
});

test('configuration timeout permits a bounded retry and ignores the old response', () => {
    const h = invitationHarness({ phoneMap: true });
    const old = h.actions('getDirections')[0];
    h.advance(22000);
    h.advance(10000);
    assert.equal(h.actions('getDirections').length, 2);
    h.reply(old, { browserMapsKey: 'old-key' });
    assert.equal(h.mapCalls.some(call => call.name === 'configure'), false);
    h.event('pagehide');
    assert.equal(h.timers.size, 0);
});

test('an explicitly revoked invitation stops GPS and directions immediately without disclosing server errors', () => {
    for (const failedAction of ['getDirections', 'publishLocation']) {
        const h = invitationHarness({ phoneMap: true });
        h.click('start');
        h.fix();
        h.fail(h.actions(failedAction)[0], 'This phone link is invalid, expired, or revoked. Ask the session owner for a new link.');
        assert.equal(h.cleared.length, 1);
        assert.equal(h.nodes.start.disabled, true);
        assert.equal(h.mapCalls.some(call => call.name === 'dispose'), true);
        h.advance(30000);
        assert.equal(h.actions('getDirections').length, 1);
        assert.match(h.nodes.status.textContent, /no longer active/);
    }
});

test('a map-adapter error cannot prevent the real GPS upload', () => {
    const h = invitationHarness({ phoneMap: true, mapThrows: 'update' });
    h.click('start');
    h.fix();
    assert.equal(h.actions('publishLocation').length, 1);
    assert.match(h.nodes['phone-map-status'].textContent, /GPS sharing can continue/);
    h.event('pagehide');
});
