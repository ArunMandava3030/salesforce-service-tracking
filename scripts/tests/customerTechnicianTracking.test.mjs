import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../../force-app/main/default/lwc/customerTechnicianTracking/customerTechnicianTracking.js');
const template = read('../../force-app/main/default/lwc/customerTechnicianTracking/customerTechnicianTracking.html');
const helperSource = read('../../force-app/main/default/lwc/trackingInvitation/trackingInvitation.js');
const invitation = await import('data:text/javascript;base64,' + Buffer.from(helperSource).toString('base64'));
const token = '0123456789abcdef'.repeat(4);
const otherToken = 'abcdef0123456789'.repeat(4);
const page = 'https://sample.my.site.com/LiveTracking/s/';
const publisherPage = 'https://sample.my.site.com/LiveTracking/apex/TechnicianGpsInvite';
const baseTime = 1791800000000;
const browserKey = 'DEMO_BROWSER_KEY_NOT_A_CREDENTIAL_12345';
const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const snapshot = (overrides = {}) => ({
    active: true, expiresAtMs: baseTime + 7200000,
    customerLatitude: 37.7749, customerLongitude: -122.4194,
    latitude: 37.7710, longitude: -122.4230, accuracy: 5,
    capturedAtMs: baseTime - 1000, receivedAtMs: baseTime - 500,
    browserMapsKey: browserKey, ...overrides
});

function harness({ href = page, responses = [], configuredPage = publisherPage } = {}) {
    const calls = [];
    const posts = [];
    const listeners = new Map();
    const removed = [];
    const timers = new Map();
    const effects = { gps: [], storage: [], navigation: [], logs: [] };
    let timerId = 0;
    let channelId = 0;
    let now = baseTime;
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const timer = (kind, callback, delay) => {
        const id = ++timerId;
        timers.set(id, { kind, callback, delay });
        return id;
    };
    const storage = {
        getItem(key) { effects.storage.push(['get', key]); return null; },
        setItem(key, value) { effects.storage.push(['set', key, value]); },
        removeItem(key) { effects.storage.push(['remove', key]); }
    };
    const window = {
        location: { href, origin: new URL(href).origin,
            assign(value) { effects.navigation.push(value); }, replace(value) { effects.navigation.push(value); } },
        crypto: { randomUUID: () => 'test-channel-' + ++channelId },
        localStorage: storage, sessionStorage: storage,
        addEventListener(name, callback) { listeners.set(name, callback); },
        removeEventListener(name, callback) {
            removed.push({ name, callback });
            if (listeners.get(name) === callback) listeners.delete(name);
        },
        setTimeout: (callback, delay) => timer('timeout', callback, delay),
        clearTimeout: (id) => timers.delete(id),
        setInterval: (callback, delay) => timer('interval', callback, delay),
        clearInterval: (id) => timers.delete(id)
    };
    const frame = { contentWindow: { postMessage: (data, origin) => posts.push({ data, origin }) } };
    const bindings = {
        LightningElement: class {}, ...invitation, window, Date: Clock,
        navigator: { geolocation: {
            watchPosition: () => effects.gps.push('watch'),
            getCurrentPosition: () => effects.gps.push('read')
        } },
        console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(name => [name, (...args) => effects.logs.push(args)])),
        getTracking: (args) => {
            calls.push(args);
            const next = responses.shift();
            if (next instanceof Error) return Promise.reject(next);
            return next?.promise || Promise.resolve(next);
        }
    };
    const executable = source
        .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*/gm, '')
        .replace(/@api\s+/g, '')
        .replace('export default class CustomerTechnicianTracking', 'class CustomerTechnicianTracking');
    const Component = new Function(...Object.keys(bindings), executable + '\nreturn CustomerTechnicianTracking;')(...Object.values(bindings));
    const component = new Component();
    component.publicPublisherPageUrl = configuredPage;
    component.template = { querySelector: (selector) => selector === 'iframe' && component.frameUrl ? frame : null };
    return {
        component, calls, posts, effects, listeners, removed, timers, window, frame,
        connect() { component.connectedCallback(); },
        setNow(value) { now = value; },
        runTimer(delay, kind = 'timeout') {
            const entry = [...timers].find(([, value]) => value.delay === delay && value.kind === kind);
            assert.ok(entry, 'Expected active ' + kind + ' timer at ' + delay + 'ms');
            const [id, value] = entry;
            if (kind === 'timeout') timers.delete(id);
            value.callback();
        },
        message(type, payload = {}, eventOverrides = {}) {
            component.handleMessage({ source: frame.contentWindow, origin: component.frameOrigin,
                data: { scope: 'technician-live-tracking-poc', bridgeVersion: '2026-10-08.live2',
                    channel: component.channel, type, ...payload }, ...eventOverrides });
        },
        ready() { this.message('frameReady'); this.message('mapReady'); }
    };
}

test('private customer fragment starts only the customer capability read and never GPS, navigation, logging or storage', async () => {
    const h = harness({ href: page + '#CUSTOMER=' + token.toUpperCase(), responses: [snapshot()] });
    h.connect();
    await flush();
    assert.deepEqual(h.calls, [{ token }]);
    assert.equal(h.component.hasTracking, true);
    assert.equal(h.component.hasPosition, true);
    assert.equal(h.component.linkInput, '');
    assert.deepEqual(h.effects, { gps: [], storage: [], navigation: [], logs: [] });
    assert.match(source, /@salesforce\/apex\/TechnicianCustomerTrackingController\.getTracking/);
    assert.doesNotMatch(source, /@salesforce\/apex\/TechnicianLiveTrackingController|geolocation|publishLocation|createSession|issuePublisherLink/);
    const url = new URL(h.component.frameUrl);
    assert.equal(url.pathname, '/LiveTracking/apex/TechnicianLiveMap');
    assert.equal(url.origin, new URL(page).origin);
    assert.equal(url.hash, '');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['channel', 'parentOrigin']);
    assert.ok(!url.href.includes(token) && !url.href.includes(browserKey));
    h.component.disconnectedCallback();
});

test('empty or malformed addresses wait for explicit recovery without calling Apex', () => {
    for (const href of [page, page + '#customer=bad', page + '?customer=' + token,
        page + '#invite=' + token, page + '#customer=' + token + '&invite=' + otherToken]) {
        const h = harness({ href });
        h.connect();
        assert.deepEqual(h.calls, []);
        assert.equal(h.component.hasTracking, false);
        assert.equal(h.component.frameUrl, undefined);
        h.component.disconnectedCallback();
        assert.equal(h.timers.size, 0);
    }
});

test('manual recovery accepts customer links or codes and clears the password input', async () => {
    for (const value of [token.toUpperCase(), page + '#customer=' + token]) {
        const h = harness({ responses: [snapshot()] });
        h.connect();
        h.component.handleInput({ target: { value } });
        assert.deepEqual(h.calls, [], 'Typing does not issue a request.');
        h.component.handleConnect();
        await flush();
        assert.deepEqual(h.calls, [{ token }]);
        assert.equal(h.component.linkInput, '');
        assert.equal(h.component.hasTracking, true);
        h.component.disconnectedCallback();
    }
    const h = harness();
    h.connect();
    for (const value of ['a01000000000001AAA', page + '?customer=' + token,
        page + '#invite=' + token, page + '#customer=' + token + '&customer=' + otherToken]) {
        h.component.handleInput({ target: { value } });
        h.component.handleConnect();
        assert.equal(h.component.linkInput, '');
        assert.match(h.component.error, /customer tracking link or customer code/);
    }
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.effects.storage, []);
    h.component.disconnectedCallback();
});

test('map configuration and coordinates are sent only to the exact trusted iframe handshake', async () => {
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot()] });
    h.connect(); await flush();
    for (const [payload, event] of [
        [{}, { origin: 'https://attacker.example' }], [{}, { source: {} }],
        [{ scope: 'other' }, {}], [{ channel: 'wrong' }, {}], [{ bridgeVersion: 'old' }, {}]
    ]) h.message('frameReady', payload, event);
    h.message('mapReady');
    assert.equal(h.component.frameConnected, false);
    assert.deepEqual(h.posts, []);
    h.message('frameReady');
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].data.type, 'initialize');
    assert.equal(h.posts[0].data.apiKey, browserKey);
    assert.deepEqual(h.posts[0].data.customer, { lat: 37.7749, lng: -122.4194 });
    h.message('frameReady');
    assert.equal(h.posts.length, 1, 'Repeated readiness cannot reinitialize the map.');
    h.message('mapReady');
    assert.equal(h.component.mapReady, true);
    const position = h.posts.find(({ data }) => data.type === 'position').data;
    assert.deepEqual(position.position, { lat: 37.7710, lng: -122.4230 });
    assert.equal(position.sampledAt, baseTime - 1000);
    assert.equal(position.receivedAtMs, baseTime - 500);
    assert.equal(position.stale, false);
    assert.ok(h.posts.every(({ origin }) => origin === new URL(page).origin));
    assert.ok(h.posts.every(({ data }) => !JSON.stringify(data).includes(token)));
    assert.equal([...h.timers.values()].some(value => value.delay === 30000), false);
    h.component.disconnectedCallback();
});

test('numeric Salesforce values normalize without treating missing, invalid or out-of-range coordinates as a position', async () => {
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot({
        latitude: '37.7710', longitude: '-122.4230', accuracy: '5.25',
        customerLatitude: '37.7749', customerLongitude: '-122.4194',
        capturedAtMs: String(baseTime - 1000), receivedAtMs: String(baseTime), expiresAtMs: String(baseTime + 7200000)
    })] });
    h.connect(); await flush(); h.ready();
    assert.equal(h.component.hasPosition, true);
    assert.equal(h.component.snapshot.accuracy, 5.25);
    assert.deepEqual(h.posts.find(({ data }) => data.type === 'position').data.position, { lat: 37.7710, lng: -122.4230 });
    h.component.disconnectedCallback();
    for (const [latitude, longitude] of [[null, null], ['', ''], ['NaN', '73'], [true, false], ['0x12', '73'], [91, 73], [18, -181]]) {
        const invalid = harness({ href: page + '#customer=' + token, responses: [snapshot({ latitude, longitude })] });
        invalid.connect(); await flush(); invalid.ready();
        assert.equal(invalid.component.hasPosition, false);
        assert.equal(invalid.component.etaLabel, 'Waiting for location');
        assert.equal(invalid.posts.some(({ data }) => data.type === 'position'), false);
        invalid.component.disconnectedCallback();
    }
});

test('a valid link without a browser key waits and automatically loads the map after owner configuration', async () => {
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot({ browserMapsKey: null }), snapshot()] });
    h.connect(); await flush();
    assert.equal(h.component.waitingForKey, true);
    assert.equal(h.component.frameUrl, undefined);
    assert.equal(h.component.hasTracking, true);
    h.runTimer(3000); await flush();
    assert.equal(h.component.waitingForKey, false);
    assert.ok(h.component.frameUrl);
    assert.deepEqual(h.calls, [{ token }, { token }]);
    h.component.disconnectedCallback();
});

test('a changed browser key replaces the iframe and rejects messages from the previous channel', async () => {
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot(), snapshot({ browserMapsKey: browserKey + '_new' })] });
    h.connect(); await flush(); h.ready();
    const oldChannel = h.component.channel;
    h.runTimer(3000); await flush();
    assert.notEqual(h.component.channel, oldChannel);
    assert.equal(h.component.frameConnected, false);
    const previousPosts = h.posts.length;
    h.message('frameReady', { channel: oldChannel });
    assert.equal(h.posts.length, previousPosts);
    h.message('frameReady');
    assert.equal(h.posts.at(-1).data.apiKey, browserKey + '_new');
    h.component.disconnectedCallback();
});

test('customer ETA requires both a recent route and fresh captured and received GPS timestamps', async () => {
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot()] });
    h.connect(); await flush(); h.ready();
    h.message('routeUpdated', { state: 'ready', durationSeconds: '121', computedAtMs: String(baseTime) });
    assert.equal(h.component.etaLabel, '3 min');
    assert.match(h.component.arrivalLabel, /^Estimated arrival /);
    h.setNow(baseTime + 16000); h.runTimer(1000, 'interval');
    assert.equal(h.component.stale, true);
    assert.equal(h.component.etaAvailable, false);
    assert.equal(h.component.etaLabel, 'Location update paused');
    assert.doesNotMatch(h.component.arrivalLabel, /^Estimated arrival /);
    assert.equal(h.posts.at(-1).data.stale, true);
    for (const value of [null, baseTime - 16000]) {
        h.component.now = baseTime;
        h.component.snapshot = snapshot({ receivedAtMs: value });
        assert.equal(h.component.etaAvailable, false);
        h.component.snapshot = snapshot({ capturedAtMs: value });
        assert.equal(h.component.etaAvailable, false);
    }
    h.component.snapshot = snapshot();
    h.message('routeUpdated', { state: 'ready', durationSeconds: 120, computedAtMs: baseTime - 90000 });
    assert.equal(h.component.etaAvailable, false);
    for (const durationSeconds of [-1, null, 'bad']) {
        h.message('routeUpdated', { state: 'ready', durationSeconds, computedAtMs: baseTime });
        assert.equal(h.component.etaAvailable, false);
    }
    h.message('routeUpdated', { state: 'unavailable' });
    assert.equal(h.component.etaLabel, 'ETA unavailable');
    h.component.disconnectedCallback();
});

test('an older response cannot overwrite the newly entered customer link', async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    const h = harness({ href: page + '#customer=' + token, responses: [oldRequest, newRequest] });
    h.connect();
    h.component.handleInput({ target: { value: otherToken } });
    h.component.handleConnect();
    newRequest.resolve(snapshot({ latitude: 37.7720 })); await flush();
    const currentChannel = h.component.channel;
    oldRequest.resolve(snapshot({ latitude: 19 })); await flush();
    assert.equal(h.component.token, otherToken);
    assert.equal(h.component.snapshot.latitude, 37.7720);
    assert.equal(h.component.channel, currentChannel);
    assert.equal([...h.timers.values()].filter(value => value.delay === 3000).length, 1);
    h.component.disconnectedCallback();
});

test('a revoked link clears coordinates, ETA, iframe and pending poll instead of keeping a previous location visible', async () => {
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot(), new Error('server details should stay private')] });
    h.connect(); await flush(); h.ready();
    h.message('routeUpdated', { state: 'ready', durationSeconds: 60, computedAtMs: baseTime });
    h.runTimer(3000); await flush();
    assert.equal(h.component.snapshot, undefined);
    assert.equal(h.component.frameUrl, undefined);
    assert.equal(h.component.route, undefined);
    assert.equal(h.component.mapReady, false);
    assert.equal(h.component.loading, false);
    assert.match(h.component.error, /revoked or expired/);
    assert.doesNotMatch(h.component.error, /server details/);
    assert.ok([...h.timers.values()].every(value => value.kind === 'interval'));
    h.component.disconnectedCallback();
    assert.equal(h.timers.size, 0);
});

test('request timeout rejects late responses and retry can reopen the same private link', async () => {
    const late = deferred();
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot(), late, snapshot()] });
    h.connect(); await flush(); h.ready();
    h.runTimer(3000); h.runTimer(22000);
    assert.equal(h.component.snapshot, undefined);
    assert.equal(h.component.frameUrl, undefined);
    assert.match(h.component.error, /could not be refreshed/);
    late.resolve(snapshot()); await flush();
    assert.equal(h.component.snapshot, undefined);
    assert.ok([...h.timers.values()].every(value => value.kind === 'interval'));
    h.component.handleRetry(); await flush();
    assert.equal(h.component.hasTracking, true);
    assert.equal(h.component.error, '');
    assert.deepEqual(h.calls, [{ token }, { token }, { token }]);
    h.component.disconnectedCallback();
});

test('disconnect clears all timers, listeners, coordinates and in-memory capability and ignores a late response', async () => {
    const late = deferred();
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot(), late] });
    h.connect(); await flush(); h.ready();
    h.runTimer(3000);
    h.component.linkInput = token;
    h.component.disconnectedCallback();
    assert.equal(h.timers.size, 0);
    assert.equal(h.listeners.size, 0);
    assert.deepEqual(h.removed.map(({ name }) => name).sort(), ['hashchange', 'message']);
    assert.equal(h.component.snapshot, undefined);
    assert.equal(h.component.frameUrl, undefined);
    assert.equal(h.component.token, '');
    assert.equal(h.component.linkInput, '');
    late.resolve(snapshot()); await flush();
    assert.equal(h.component.snapshot, undefined);
    assert.equal(h.timers.size, 0);
});

test('ended, expired or invalid expiry responses cannot expose a customer map or location', async () => {
    for (const value of [null, snapshot({ active: false }), snapshot({ expiresAtMs: baseTime }),
        snapshot({ expiresAtMs: null }), snapshot({ expiresAtMs: 'invalid' })]) {
        const h = harness({ href: page + '#customer=' + token, responses: [value] });
        h.connect(); await flush();
        assert.equal(h.component.hasTracking, false);
        assert.equal(h.component.frameUrl, undefined);
        assert.match(h.component.error, /ended or expired/);
        h.component.disconnectedCallback();
    }
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot({ expiresAtMs: baseTime + 1000 })] });
    h.connect(); await flush(); h.ready();
    h.setNow(baseTime + 1000); h.runTimer(1000, 'interval');
    assert.equal(h.component.snapshot, undefined);
    assert.equal(h.component.frameUrl, undefined);
    assert.match(h.component.error, /expired/);
    h.component.disconnectedCallback();
});

test('hash changes switch customer capability and removing the fragment clears the current map', async () => {
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot(), snapshot({ latitude: 37.7720 })] });
    h.connect(); await flush();
    h.window.location.href = page + '#customer=' + otherToken;
    h.listeners.get('hashchange')(); await flush();
    assert.equal(h.component.snapshot.latitude, 37.7720);
    assert.deepEqual(h.calls, [{ token }, { token: otherToken }]);
    h.window.location.href = page;
    h.listeners.get('hashchange')();
    assert.equal(h.component.snapshot, undefined);
    assert.equal(h.component.frameUrl, undefined);
    assert.match(h.component.error, /private customer tracking link/);
    h.component.disconnectedCallback();
});

test('map load timeout and map errors clear the frame while keeping generic recovery messages', async () => {
    for (const trigger of ['timeout', 'message']) {
        const h = harness({ href: page + '#customer=' + token, responses: [snapshot()] });
        h.connect(); await flush();
        if (trigger === 'timeout') h.runTimer(30000);
        else h.message('mapError', { message: 'secret error ' + browserKey });
        assert.equal(h.component.frameUrl, undefined);
        assert.equal(h.component.mapReady, false);
        assert.equal(h.component.route, undefined);
        assert.ok(h.component.mapError);
        assert.ok(!h.component.mapError.includes(browserKey));
        h.component.disconnectedCallback();
    }
});

test('an unrelated configured site cannot receive customer map configuration', async () => {
    const h = harness({ href: page + '#customer=' + token, responses: [snapshot()],
        configuredPage: 'https://other.my.site.com/LiveTracking/apex/TechnicianGpsInvite' });
    h.connect(); await flush();
    assert.equal(h.component.frameUrl, undefined);
    assert.match(h.component.mapError, /configure this site/);
    assert.deepEqual(h.posts, []);
    h.component.disconnectedCallback();
});

test('customer markup supports password recovery, a trusted map and ETA without owner or publisher controls', () => {
    assert.match(template, /<lightning-input\b[^>]*type="password"[^>]*value=\{linkInput\}/);
    assert.match(template, /onclick=\{handleConnect\}/);
    assert.match(template, /<iframe\b[^>]*src=\{frameUrl\}/);
    assert.match(template, /\{etaLabel\}/);
    assert.match(template, /\{arrivalLabel\}/);
    assert.doesNotMatch(template, /c-technician-live-tracking|c-technician-invitation-entry|Start sharing|Create session|Generate.*link|type="url"/i);
    assert.doesNotMatch(template, />\s*\{(?:token|linkInput|browserMapsKey)\}\s*</);
});
