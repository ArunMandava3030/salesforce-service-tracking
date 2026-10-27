import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(
    new URL('../../force-app/main/default/staticresources/TechnicianLiveMapScript.js', import.meta.url),
    'utf8'
);
const routeSource = readFileSync(
    new URL('../../force-app/main/default/staticresources/TechnicianRouteService.js', import.meta.url), 'utf8'
);
const VERSION = '2026-10-08.live2';
const ORIGIN = 'https://example.develop.lightning.force.com';
const FRAME_ORIGIN = 'https://example--c.develop.vf.force.com';
const SITE_ORIGIN = 'https://example.develop.my.site.com';
const CHANNEL = '0f482930-689d-4000-aabc-22ee55ff0000';
const CUSTOMER = { lat: 37.7749, lng: -122.4194 };

function eventTarget() {
    const handlers = new Map();
    return {
        handlers,
        addEventListener(type, handler) {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type).add(handler);
        },
        removeEventListener(type, handler) {
            handlers.get(type)?.delete(handler);
        },
        dispatch(type, event = {}) {
            for (const handler of Array.from(handlers.get(type) || [])) handler(event);
        }
    };
}

function harness(options = {}) {
    const messages = [];
    const scripts = [];
    const timers = new Map();
    const maps = [];
    const markers = [];
    const circles = [];
    const trails = [];
    const routeConfigurations = [];
    const routeUpdates = [];
    const routeInstances = [];
    let nextTimer = 0;
    const parentOrigin = options.origin || ORIGIN;
    const frameUrl = new URL(options.frameUrl || FRAME_ORIGIN + '/apex/TechnicianLiveMap');
    frameUrl.searchParams.set('parentOrigin', parentOrigin);
    frameUrl.searchParams.set('channel', options.channel || CHANNEL);
    let available = options.loading !== true;
    const status = {
        textContent: '',
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; }
    };
    const mapElement = {};
    const parent = {
        postMessage(data, origin) { messages.push({ data, origin }); }
    };
    const document = Object.assign(eventTarget(), {
        readyState: options.loading ? 'loading' : 'complete',
        referrer: options.referrer || '',
        querySelector(selector) {
            if (!available) return null;
            if (selector === '[data-role="live-map"]') return options.noMap ? null : mapElement;
            if (selector === '[data-role="live-map-status"]') return options.noStatus ? null : status;
            return null;
        },
        createElement() {
            return { remove() { this.removed = true; } };
        },
        head: { appendChild(script) { scripts.push(script); } }
    });
    const window = Object.assign(eventTarget(), {
        parent,
        location: {
            href: frameUrl.href,
            origin: frameUrl.origin,
            search: frameUrl.search
        },
        setTimeout(callback, duration) {
            timers.set(++nextTimer, { callback, duration });
            return nextTimer;
        },
        clearTimeout(id) { timers.delete(id); }
    });
    const google = {
        maps: {
            importLibrary() {
                return Promise.resolve({ Route: { computeRoutes: options.computeRoutes || (() => Promise.resolve({ routes: [{
                    path: [{ lat: 37.7700, lng: -122.4300 }, CUSTOMER], durationMillis: 180000, distanceMeters: 1200
                }] })) } });
            },
            Map: class {
                constructor(element, settings) {
                    this.element = element;
                    this.settings = settings;
                    this.pans = [];
                    this.bounds = [];
                    maps.push(this);
                }
                setCenter(position) { this.center = position; }
                setZoom(zoom) { this.zoom = zoom; }
                panTo(position) { this.pans.push(position); }
                fitBounds(bounds, padding) { this.bounds.push({ bounds, padding }); }
            },
            marker: {
                AdvancedMarkerElement: class {
                    constructor(settings) { Object.assign(this, settings); markers.push(this); }
                    append(pin) { this.pin = pin; }
                },
                PinElement: class {
                    constructor(settings) { Object.assign(this, settings); }
                }
            },
            Circle: class {
                constructor(settings) { Object.assign(this, settings); circles.push(this); }
                setMap(map) { this.map = map; }
                setCenter(center) { this.center = center; }
                setRadius(radius) { this.radius = radius; }
            },
            Polyline: class {
                constructor(settings) { Object.assign(this, settings); trails.push(this); }
                setPath(path) { this.path = path; }
                setMap(map) { this.map = map; }
            },
            LatLngBounds: class {
                constructor() { this.points = []; }
                extend(point) { this.points.push(point); return this; }
            },
            event: { clearInstanceListeners(map) { map.listenersCleared = true; } }
        }
    };
    if (options.realRoutes) {
        runInNewContext(routeSource, { window });
    } else if (!options.noRoutes) {
        window.TechnicianRouteService = {
            create(configuration) {
                routeConfigurations.push(configuration);
                if (options.routeCreateThrows) throw Error('Route setup failed');
                const instance = {
                    clearCount: 0, disposed: false,
                    update(value) {
                        if (options.routeUpdateThrows) throw Error('Route update failed');
                        routeUpdates.push(value);
                    },
                    clear() { this.clearCount++; },
                    dispose() { this.disposed = true; }
                };
                routeInstances.push(instance);
                configuration.onUpdate({ state: 'waiting', durationSeconds: null, distanceMeters: null,
                    computedAtMs: null, sampledAt: null, message: 'Waiting for GPS.' });
                return instance;
            }
        };
    }
    runInNewContext(source, { window, document, URL, URLSearchParams });
    function send(type, payload = {}, overrides = {}) {
        window.dispatch('message', Object.assign({
            source: parent,
            origin: parentOrigin,
            data: Object.assign({
                type, scope: 'technician-live-tracking-poc', bridgeVersion: VERSION,
                channel: CHANNEL
            }, payload)
        }, overrides));
    }
    function initialize() {
        send('initialize', { apiKey: 'test-key', customer: CUSTOMER });
    }
    function ready() {
        window.google = google;
        window.initTechnicianLiveMap();
    }
    function position(sampledAt = 1, lat = 37.7704, lng = -122.4254, accuracy = 9) {
        send('position', { position: { lat, lng }, sampledAt, accuracy });
    }
    return {
        window, document, messages, scripts, timers, maps, markers, circles, trails, status,
        routeConfigurations, routeUpdates, routeInstances,
        send, initialize, ready, position,
        domReady() {
            available = true;
            document.readyState = 'complete';
            document.dispatch('DOMContentLoaded');
        }
    };
}

test('waits for Visualforce DOM before the handshake and does not initialize twice', () => {
    const h = harness({ loading: true });
    assert.equal(h.messages.length, 0);
    h.domReady();
    h.domReady();
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].data.type, 'frameReady');
    assert.equal(h.messages[0].data.bridgeVersion, VERSION);
    assert.equal(h.messages[0].origin, ORIGIN);
    h.send('ping');
    assert.equal(h.messages.at(-1).data.type, 'frameReady');
    h.initialize();
    h.initialize();
    assert.equal(h.scripts.length, 1);
});

test('map shows only the fixed customer until a genuine position message arrives', () => {
    const h = harness();
    h.initialize();
    assert.equal(h.markers.length, 0);
    const scriptUrl = new URL(h.scripts[0].src);
    assert.equal(scriptUrl.origin, 'https://maps.googleapis.com');
    assert.equal(scriptUrl.searchParams.get('libraries'), 'marker');
    assert.equal(scriptUrl.searchParams.get('callback'), 'initTechnicianLiveMap');
    h.ready();
    assert.equal(h.markers.length, 1);
    assert.equal(h.markers[0].pin.glyphText, 'C');
    assert.equal(h.markers[0].position.lat, CUSTOMER.lat);
    assert.equal(h.markers[0].position.lng, CUSTOMER.lng);
    assert.equal(h.timers.size, 0);
    assert.equal(h.messages.at(-1).data.type, 'mapReady');
    h.position();
    assert.equal(h.markers.length, 2);
    assert.equal(h.markers[1].pin.glyphText, 'T');
    assert.equal(h.markers[1].pin.scale, 1.25);
    assert.ok(h.markers[1].zIndex > h.markers[0].zIndex);
    assert.equal(h.circles[0].radius, 9);
    assert.equal(h.maps[0].bounds.length, 0);
    assert.equal(h.maps[0].center.lat, 37.7704);
    assert.equal(h.maps[0].zoom, 17);
    assert.equal(h.messages.at(-1).data.type, 'positionRendered');
    assert.equal(h.messages.at(-1).data.sampledAt, 1);
    assert.equal(h.messages.at(-1).data.position.lat, 37.7704);
    assert.equal(h.messages.at(-1).data.position.lng, -122.4254);
    h.position(2, 37.7710, -122.4250, 6);
    assert.equal(h.markers.length, 2);
    assert.equal(h.markers[1].position.lat, 37.7710);
    assert.equal(h.circles[0].radius, 6);
    assert.equal(h.maps[0].pans.length, 1);
});

test('a missing status element does not crash either success or failure', () => {
    const success = harness({ noStatus: true });
    success.initialize();
    success.ready();
    success.position();
    assert.equal(success.markers.length, 2);
    const failure = harness({ noStatus: true });
    failure.initialize();
    failure.scripts[0].onerror();
    assert.equal(failure.messages.at(-1).data.type, 'mapError');
});

test('a missing map area produces a clear error without loading Google', () => {
    const h = harness({ noMap: true, noStatus: true });
    assert.equal(h.messages.at(-1).data.type, 'mapError');
    assert.match(h.messages.at(-1).data.message, /map area is missing/);
    h.initialize();
    assert.equal(h.scripts.length, 0);
});

test('rejects messages from another window, origin, channel, scope, or bridge version', () => {
    const h = harness();
    const payload = { apiKey: 'test-key', customer: CUSTOMER };
    h.send('initialize', payload, { origin: 'https://attacker.example' });
    h.send('initialize', payload, { source: {} });
    h.send('initialize', { ...payload, channel: 'wrong-channel' });
    h.send('initialize', { ...payload, scope: 'wrong-scope' });
    h.send('initialize', { ...payload, bridgeVersion: 'old' });
    assert.equal(h.scripts.length, 0);
    h.initialize();
    assert.equal(h.scripts.length, 1);
});

test('rejects untrusted parent URL suffixes and non-UUID channels', () => {
    for (const options of [
        { origin: 'https://example.lightning.force.com.attacker.example' },
        { origin: 'http://example.lightning.force.com' },
        { origin: 'https://example.lightning.force.com/path' },
        { channel: 'not-a-session-channel' }
    ]) {
        const h = harness(options);
        assert.equal(h.messages.length, 0);
        assert.equal(h.scripts.length, 0);
        assert.match(h.status.textContent, /Open this map/);
    }
});

test('a public Salesforce Sites map connects only to its own Experience origin', () => {
    for (const siteOrigin of [SITE_ORIGIN, 'https://example.my.salesforce-sites.com']) {
        const h = harness({
            origin: siteOrigin,
            frameUrl: siteOrigin + '/LiveTracking/apex/TechnicianLiveMap',
            referrer: siteOrigin + '/LiveTracking/s/'
        });
        assert.equal(h.messages[0].data.type, 'frameReady');
        assert.equal(h.messages[0].origin, siteOrigin);
        h.initialize();
        h.ready();
        h.position();
        assert.equal(h.markers.length, 2);
        assert.equal(h.messages.at(-1).data.type, 'positionRendered');
        assert.equal(h.messages.at(-1).origin, siteOrigin);
    }
});

test('private Visualforce maps derive the exact matching org Lightning origin', () => {
    for (const [frameOrigin, parentOrigin] of [
        ['https://example--c.vf.force.com', 'https://example.lightning.force.com'],
        [FRAME_ORIGIN, ORIGIN],
        ['https://example--uat--c.sandbox.vf.force.com', 'https://example--uat.sandbox.lightning.force.com']
    ]) {
        const h = harness({ origin: parentOrigin, frameUrl: frameOrigin + '/apex/TechnicianLiveMap' });
        assert.equal(h.messages[0].origin, parentOrigin);
        h.initialize();
        assert.equal(h.scripts.length, 1);
    }
});

test('another Salesforce tenant or a mismatched public/private origin cannot control the map', () => {
    for (const options of [
        { origin: 'https://other.develop.lightning.force.com' },
        { origin: SITE_ORIGIN },
        { origin: 'https://other.develop.my.site.com', frameUrl: SITE_ORIGIN + '/LiveTracking/apex/TechnicianLiveMap' },
        { origin: ORIGIN, frameUrl: SITE_ORIGIN + '/LiveTracking/apex/TechnicianLiveMap' },
        { origin: 'https://attacker.example', frameUrl: 'https://attacker.example/apex/TechnicianLiveMap' },
        { origin: SITE_ORIGIN, frameUrl: 'http://example.develop.my.site.com/LiveTracking/apex/TechnicianLiveMap' },
        { origin: ORIGIN, frameUrl: 'https://example--c.develop.vf.force.com.attacker.example/apex/TechnicianLiveMap' }
    ]) {
        const h = harness(options);
        assert.equal(h.messages.length, 0);
        h.initialize();
        assert.equal(h.scripts.length, 0);
        assert.equal(h.timers.size, 0);
        assert.match(h.status.textContent, /Open this map/);
    }
});

test('a present referrer must match the approved parent while an omitted referrer remains supported', () => {
    for (const referrer of ['', ORIGIN + '/', ORIGIN + '/lightning/page/home']) {
        const h = harness({ referrer });
        assert.equal(h.messages[0].data.type, 'frameReady');
    }
    for (const referrer of ['https://other.develop.lightning.force.com/', 'about:blank', 'not a URL']) {
        const h = harness({ referrer });
        assert.equal(h.messages.length, 0);
        assert.equal(h.timers.size, 0);
        h.initialize();
        assert.equal(h.scripts.length, 0);
    }
});

test('the frame retries its own ready handshake a bounded number of times without a parent ping', () => {
    const h = harness();
    let iterations = 0;
    while (h.timers.size) {
        assert.ok(++iterations < 25, 'Ready retries must be bounded');
        const [id, timer] = h.timers.entries().next().value;
        assert.equal(timer.duration, 500);
        h.timers.delete(id);
        timer.callback();
    }
    assert.equal(h.messages.length, 20);
    assert.ok(h.messages.every((entry) => entry.data.type === 'frameReady'));
    assert.equal(h.scripts.length, 0);
    h.initialize();
    h.ready();
    assert.equal(h.messages.at(-1).data.type, 'mapReady');
});

test('initialization stops ready retries and a delayed retry cannot repeat the handshake', () => {
    const h = harness();
    const readyRetry = h.timers.values().next().value.callback;
    h.initialize();
    assert.equal(h.timers.size, 1);
    assert.equal(h.timers.values().next().value.duration, 25000);
    const count = h.messages.length;
    readyRetry();
    assert.equal(h.messages.length, count);
    h.ready();
    assert.equal(h.timers.size, 0);
});

test('failed initialization and pagehide cancel an outstanding ready retry', () => {
    const failed = harness();
    const failedRetry = failed.timers.values().next().value.callback;
    failed.send('initialize', { apiKey: '', customer: CUSTOMER });
    assert.equal(failed.timers.size, 0);
    const failedCount = failed.messages.length;
    failedRetry();
    assert.equal(failed.messages.length, failedCount);
    assert.equal(failed.messages.at(-1).data.type, 'mapError');

    const closed = harness();
    const closedRetry = closed.timers.values().next().value.callback;
    closed.window.dispatch('pagehide');
    assert.equal(closed.timers.size, 0);
    const closedCount = closed.messages.length;
    closedRetry();
    assert.equal(closed.messages.length, closedCount);
});

test('the stateless map script is available to the public Salesforce Sites renderer', () => {
    const metadata = readFileSync(
        new URL('../../force-app/main/default/staticresources/TechnicianLiveMapScript.resource-meta.xml', import.meta.url),
        'utf8'
    );
    assert.match(metadata, /<cacheControl>Public<\/cacheControl>/);
});

test('retains the latest valid GPS message that arrives while Maps is loading', () => {
    const h = harness();
    h.initialize();
    h.position(2, 37.7700, -122.4300);
    h.position(3, 37.7710, -122.4290);
    h.position(1, 37.6700, -122.4500);
    assert.equal(h.markers.length, 0);
    h.ready();
    assert.equal(h.markers.length, 2);
    assert.equal(h.markers[1].position.lat, 37.7710);
});

test('ignores invalid coordinates and stale or nonnumeric samples', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.position(0);
    h.position('1');
    h.position(1, NaN);
    h.position(1, 91);
    h.position(1, 37.7700, -181);
    h.position(1, '37.7700');
    assert.equal(h.markers.length, 1);
    h.position(10);
    h.position(9, 19, 74);
    h.position(10, 19, 74);
    assert.equal(h.markers[1].position.lat, 37.7704);
});

test('accuracy circles hide for unknown accuracy; enabling follow focuses the technician', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.position();
    h.send('follow', { enabled: false });
    h.position(2, 37.7710, -122.4250, null);
    assert.equal(h.maps[0].pans.length, 0);
    assert.equal(h.circles[0].map, null);
    h.send('follow', { enabled: true });
    assert.equal(h.maps[0].center.lat, 37.7710);
    assert.equal(h.maps[0].zoom, 17);
    h.position(3, 37.7720, -122.4240, 5);
    assert.equal(h.maps[0].pans.length, 1);
    assert.equal(h.circles[0].map, h.maps[0]);
    h.send('fitBounds');
    assert.equal(h.maps[0].bounds.length, 1);
});

test('GPS trail contains at most 100 observed positions; clearing removes the previous session', () => {
    const h = harness();
    h.initialize();
    h.ready();
    for (let i = 1; i <= 120; i++) h.position(i, 37.6700 + i / 10000, -122.4300);
    assert.equal(h.trails[0].path.length, 100);
    h.send('clearPosition');
    assert.equal(h.markers[1].map, null);
    assert.equal(h.trails[0].map, null);
    assert.equal(h.circles[0].map, null);
    assert.equal(h.maps[0].center.lat, CUSTOMER.lat);
    h.position(1);
    assert.equal(h.markers.length, 3);
});

test('the first far-away phone fix gets a useful technician zoom instead of a country overview', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.position(1, 28.6139, 77.2090);
    assert.equal(h.maps[0].center.lat, 28.6139);
    assert.equal(h.maps[0].center.lng, 77.2090);
    assert.equal(h.maps[0].zoom, 17);
    assert.equal(h.maps[0].bounds.length, 0);

    h.maps[0].setZoom(14);
    h.position(2, 28.6140, 77.2091);
    assert.equal(h.maps[0].zoom, 14);
    assert.equal(h.maps[0].pans.at(-1).lat, 28.6140);
});

test('overview stays deliberate and Locate technician restores follow with a close zoom', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.send('follow', { enabled: false });
    h.position(1, 28.6139, 77.2090);
    assert.equal(h.maps[0].bounds.length, 1);
    assert.equal(h.maps[0].bounds[0].bounds.points.length, 2);
    assert.equal(h.maps[0].bounds[0].bounds.points[0].lat, CUSTOMER.lat);
    assert.equal(h.maps[0].bounds[0].bounds.points[1].lat, 28.6139);

    h.maps[0].setZoom(5);
    h.send('focusTechnician');
    assert.equal(h.maps[0].center.lat, 28.6139);
    assert.equal(h.maps[0].zoom, 17);
    h.position(2, 28.6140, 77.2091);
    assert.equal(h.maps[0].pans.length, 1);
    assert.equal(h.maps[0].bounds.length, 1);
});

test('Locate before GPS never invents a technician and focuses the eventual first fix', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.send('follow', { enabled: false });
    h.send('focusTechnician');
    assert.equal(h.markers.length, 1);
    assert.equal(h.maps[0].bounds.length, 0);
    h.position(1, 28.6139, 77.2090);
    assert.equal(h.maps[0].center.lat, 28.6139);
    assert.equal(h.maps[0].zoom, 17);
});

test('only applied samples receive rendering acknowledgments, including fresh stationary fixes', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.position(3);
    h.position(3);
    h.position(2);
    h.position(4, 91);
    h.position(4);
    const acknowledgments = h.messages.filter((entry) => entry.data.type === 'positionRendered');
    assert.equal(acknowledgments.length, 2);
    assert.equal(acknowledgments[0].data.sampledAt, 3);
    assert.equal(acknowledgments[1].data.sampledAt, 4);
    assert.equal(acknowledgments[1].data.position.lat, 37.7704);
    assert.equal(acknowledgments[1].data.position.lng, -122.4254);
    assert.equal(acknowledgments[1].data.bridgeVersion, VERSION);
    assert.equal(acknowledgments[1].origin, ORIGIN);
});

test('a marker rendering exception reports a terminal error without acknowledging the sample', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.window.google.maps.marker.AdvancedMarkerElement = class {
        constructor() { throw new Error('Marker failed'); }
    };
    h.position();
    assert.equal(h.messages.at(-1).data.type, 'mapError');
    assert.match(h.messages.at(-1).data.message, /could not display the technician GPS/);
    assert.equal(h.messages.filter((entry) => entry.data.type === 'positionRendered').length, 0);
    assert.equal(h.markers.length, 1);
    const count = h.messages.length;
    h.position(2);
    h.send('focusTechnician');
    assert.equal(h.messages.length, count);
});

test('a runtime map update failure cannot acknowledge a new sample after an earlier success', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.position();
    h.maps[0].panTo = function () { throw new Error('Map pan failed'); };
    h.position(2, 37.7710, -122.4250);
    assert.equal(h.messages.at(-1).data.type, 'mapError');
    const acknowledgments = h.messages.filter((entry) => entry.data.type === 'positionRendered');
    assert.equal(acknowledgments.length, 1);
    assert.equal(acknowledgments[0].data.sampledAt, 1);
});

test('Google authorization and network failures cannot be revived by late callbacks', () => {
    for (const trigger of [
        h => h.window.gm_authFailure(),
        h => h.scripts[0].onerror(),
        h => Array.from(h.timers.values())[0].callback()
    ]) {
        const h = harness();
        h.initialize();
        trigger(h);
        assert.equal(h.messages.at(-1).data.type, 'mapError');
        assert.equal(h.timers.size, 0);
        h.ready();
        h.initialize();
        h.position();
        assert.equal(h.maps.length, 0);
        assert.equal(h.scripts.length, 1);
    }
});

test('pagehide removes the bridge, timers and map objects and ignores late callbacks', () => {
    const loading = harness();
    loading.initialize();
    loading.window.dispatch('pagehide');
    assert.equal(loading.timers.size, 0);
    assert.equal(loading.scripts[0].removed, true);
    assert.equal(loading.window.handlers.get('message').size, 0);
    loading.ready();
    assert.equal(loading.maps.length, 0);

    const ready = harness();
    ready.initialize();
    ready.ready();
    ready.position();
    ready.window.dispatch('pagehide');
    assert.equal(ready.markers[0].map, null);
    assert.equal(ready.markers[1].map, null);
    assert.equal(ready.circles[0].map, null);
    assert.equal(ready.trails[0].map, null);
    assert.equal(ready.maps[0].listenersCleared, true);
    const count = ready.messages.length;
    ready.send('ping');
    assert.equal(ready.messages.length, count);
});

test('the map initializes routing with the fixed customer and forwards actual GPS freshness fields', () => {
    const h = harness();
    h.initialize();
    h.ready();
    assert.equal(h.routeConfigurations.length, 1);
    assert.equal(h.routeConfigurations[0].map, h.maps[0]);
    assert.equal(h.routeConfigurations[0].customer.lat, CUSTOMER.lat);
    assert.equal(h.routeConfigurations[0].customer.lng, CUSTOMER.lng);
    assert.equal(h.routeUpdates.some(value => value.position), false);
    h.send('position', { position: { lat: 37.7700, lng: -122.4300 }, sampledAt: 100,
        receivedAtMs: 110, accuracy: 5, active: true, stale: false });
    const update = h.routeUpdates.at(-1);
    assert.equal(update.position.lat, 37.7700);
    assert.equal(update.sampledAt, 100);
    assert.equal(update.receivedAtMs, 110);
    assert.equal(update.active, true);
    assert.equal(update.stale, false);
    assert.equal(h.messages.at(-1).data.type, 'positionRendered');
});

test('route updates retain the exact trusted bridge envelope and do not invent marker acknowledgments', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.routeConfigurations[0].onUpdate({ state: 'ready', durationSeconds: 240, distanceMeters: 1700,
        computedAtMs: 200, sampledAt: 100, message: 'Driving estimate' });
    const message = h.messages.at(-1);
    assert.equal(message.data.type, 'routeUpdated');
    assert.equal(message.data.durationSeconds, 240);
    assert.equal(message.data.distanceMeters, 1700);
    assert.equal(message.data.sampledAt, 100);
    assert.equal(message.data.bridgeVersion, VERSION);
    assert.equal(message.data.channel, CHANNEL);
    assert.equal(message.data.scope, 'technician-live-tracking-poc');
    assert.equal(message.origin, ORIGIN);
    assert.equal(h.markers.length, 1);
    assert.equal(h.messages.filter(item => item.data.type === 'positionRendered').length, 0);
});

test('duplicate GPS and status messages can stale or stop routing without redrawing the technician', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.position(100);
    h.send('position', { position: { lat: 37.7700, lng: -122.4300 }, sampledAt: 100, stale: true });
    assert.equal(h.routeUpdates.at(-1).stale, true);
    assert.equal(h.routeUpdates.at(-1).position, undefined);
    h.send('status', { text: 'Session ended.', active: false });
    assert.equal(h.routeUpdates.at(-1).active, false);
    assert.equal(h.messages.filter(item => item.data.type === 'positionRendered').length, 1);
    assert.equal(h.markers.length, 2);
    const count = h.routeUpdates.length;
    h.send('status', { active: true }, { origin: 'https://attacker.example' });
    assert.equal(h.routeUpdates.length, count);
});

test('route creation, resource, or update failures keep the original GPS marker working', () => {
    for (const options of [{ noRoutes: true }, { routeCreateThrows: true }, { routeUpdateThrows: true }]) {
        const h = harness(options);
        h.initialize();
        h.ready();
        h.position();
        h.position(2);
        assert.equal(h.markers.length, 2);
        assert.equal(h.messages.filter(item => item.data.type === 'mapError').length, 0);
        assert.ok(h.messages.some(item => item.data.type === 'routeUpdated' && item.data.state === 'unavailable'));
        assert.equal(h.messages.filter(item => item.data.type === 'positionRendered').length, 2);
    }
});

test('clearPosition clears the route while map failure or pagehide disposes it and suppresses late callbacks', () => {
    const h = harness();
    h.initialize();
    h.ready();
    h.position();
    h.send('clearPosition');
    assert.equal(h.routeInstances[0].clearCount, 1);
    h.window.dispatch('pagehide');
    assert.equal(h.routeInstances[0].disposed, true);
    const count = h.messages.length;
    h.routeConfigurations[0].onUpdate({ state: 'ready', durationSeconds: 30 });
    assert.equal(h.messages.length, count);

    const failed = harness();
    failed.initialize();
    failed.ready();
    failed.window.gm_authFailure();
    assert.equal(failed.routeInstances[0].disposed, true);
    const errorCount = failed.messages.length;
    failed.routeConfigurations[0].onUpdate({ state: 'ready', durationSeconds: 30 });
    assert.equal(failed.messages.length, errorCount);
});

test('the Visualforce page loads the shared route resource before the map bridge and labels its path', () => {
    const page = readFileSync(new URL('../../force-app/main/default/pages/TechnicianLiveMap.page', import.meta.url), 'utf8');
    assert.ok(page.indexOf('$Resource.TechnicianRouteService') < page.indexOf('$Resource.TechnicianLiveMapScript'));
    assert.match(page, /Driving route/);
});

test('the real shared service draws a road route and reports ETA after an actual map GPS acknowledgment', async () => {
    const h = harness({ realRoutes: true });
    h.initialize();
    h.ready();
    const sampledAt = Date.now();
    h.position(sampledAt);
    for (let i = 0; i < 16; i++) await Promise.resolve();
    const acknowledgment = h.messages.find(item => item.data.type === 'positionRendered');
    const route = h.messages.find(item => item.data.type === 'routeUpdated' && item.data.state === 'ready');
    assert.equal(acknowledgment.data.sampledAt, sampledAt);
    assert.equal(route.data.sampledAt, sampledAt);
    assert.equal(route.data.durationSeconds, 180);
    assert.equal(h.markers.length, 2);
    assert.equal(h.trails.length, 2);
    assert.equal(h.trails[0].strokeColor, '#0b63ce');
    assert.equal(h.trails[1].strokeColor, '#6941c6');
    h.send('status', { active: false, text: 'Session ended.' });
    assert.equal(h.messages.at(-1).data.state, 'stale');
    assert.equal(h.messages.at(-1).data.durationSeconds, null);
    assert.equal(h.trails[1].map, null);
    assert.equal(h.markers[1].map, h.maps[0]);
    h.window.dispatch('pagehide');
    assert.equal(h.timers.size, 0);
});

test('the real shared service refuses stale GPS ETA while retaining its observed marker', async () => {
    let requests = 0;
    const h = harness({ realRoutes: true, computeRoutes: () => { requests++; return Promise.resolve({ routes: [] }); } });
    h.initialize();
    h.ready();
    h.position(Date.now() - 20000);
    for (let i = 0; i < 16; i++) await Promise.resolve();
    assert.equal(requests, 0);
    assert.equal(h.markers.length, 2);
    assert.ok(h.messages.some(item => item.data.type === 'routeUpdated' && item.data.state === 'stale'));
    assert.equal(h.messages.filter(item => item.data.type === 'positionRendered').length, 1);
});

test('a Google routing rejection leaves the map ready and accepts the next real GPS marker', async () => {
    const h = harness({ realRoutes: true, computeRoutes: () => Promise.reject(Error('denied')) });
    h.initialize();
    h.ready();
    const sampledAt = Date.now();
    h.position(sampledAt);
    for (let i = 0; i < 16; i++) await Promise.resolve();
    assert.equal(h.messages.at(-1).data.type, 'routeUpdated');
    assert.equal(h.messages.at(-1).data.state, 'unavailable');
    h.position(sampledAt + 1, 37.7710, -122.4290);
    assert.equal(h.markers[1].position.lat, 37.7710);
    assert.equal(h.messages.at(-1).data.type, 'positionRendered');
    assert.equal(h.messages.filter(item => item.data.type === 'mapError').length, 0);
});
