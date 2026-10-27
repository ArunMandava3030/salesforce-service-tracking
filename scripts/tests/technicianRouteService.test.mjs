import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../force-app/main/default/staticresources/TechnicianRouteService.js', import.meta.url), 'utf8');
const CUSTOMER = { lat: 37.7749, lng: -122.4194 };
const START = 1800000000000;
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function routeResult(overrides = {}) {
    return { routes: [{
        durationMillis: 180000, distanceMeters: 1200,
        path: [{ lat: 37.7700, lng: -122.4300 }, CUSTOMER], ...overrides
    }] };
}

function harness(options = {}) {
    let now = START;
    let nextTimer = 0;
    const timers = new Map();
    const notices = [];
    const requests = [];
    const imports = [];
    const polylines = [];
    const map = {};
    const window = {
        setTimeout(callback, delay) {
            timers.set(++nextTimer, { callback, at: now + delay });
            return nextTimer;
        },
        clearTimeout(id) { timers.delete(id); },
        google: { maps: {
            importLibrary(name) {
                imports.push(name);
                if (options.library) return options.library();
                return Promise.resolve({ Route: {
                    computeRoutes(request) {
                        requests.push({ request, at: now });
                        return options.compute ? options.compute(request) : Promise.resolve(routeResult());
                    }
                } });
            },
            Polyline: class {
                constructor(value) {
                    if (options.polylineThrows) throw Error('Cannot render');
                    Object.assign(this, value);
                    polylines.push(this);
                }
                setMap(value) { this.map = value; }
            }
        } }
    };
    class FakeDate extends Date { static now() { return now; } }
    runInNewContext(source, { window, Date: FakeDate });
    const service = window.TechnicianRouteService.create({
        map, customer: CUSTOMER,
        onUpdate(value) {
            notices.push(plain(value));
            if (options.callbackThrows) throw Error('UI error');
        }
    });
    return {
        window, service, notices, requests, imports, polylines, map, timers,
        get now() { return now; },
        sample(overrides = {}) {
            service.update({ position: { lat: 37.7700, lng: -122.4300 }, sampledAt: now,
                receivedAtMs: now, active: true, stale: false, ...overrides });
        },
        jump(milliseconds) { now += milliseconds; },
        async advance(milliseconds) {
            const end = now + milliseconds;
            let count = 0;
            while (true) {
                const next = [...timers.entries()].filter(([, value]) => value.at <= end)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                assert.ok(++count < 200, 'Timer loop must remain bounded');
                now = next[1].at;
                timers.delete(next[0]);
                next[1].callback();
                await flush();
            }
            now = end;
            await flush();
        }
    };
}

test('waits for actual GPS and requests traffic-aware driving fields through Maps JS only', async () => {
    const h = harness();
    assert.equal(h.notices.at(-1).state, 'waiting');
    assert.equal(h.imports.length, 0);
    assert.equal(h.timers.size, 0);
    h.sample();
    await flush();
    assert.deepEqual(h.imports, ['routes']);
    assert.deepEqual(plain(h.requests[0].request), {
        origin: { lat: 37.7700, lng: -122.4300 }, destination: CUSTOMER,
        travelMode: 'DRIVING', routingPreference: 'TRAFFIC_AWARE',
        fields: ['path', 'durationMillis', 'distanceMeters']
    });
    assert.equal(h.notices.at(-1).durationSeconds, 180);
    assert.equal(h.notices.at(-1).distanceMeters, 1200);
    assert.equal(h.notices.at(-1).computedAtMs, START);
    assert.equal(h.notices.at(-1).sampledAt, START);
    assert.equal(h.polylines[0].strokeColor, '#6941c6');
    assert.equal(h.polylines[0].map, h.map);
});

test('rejects malformed coordinates, timestamps, and future samples without requesting a route', async () => {
    for (const changes of [
        { position: { lat: null, lng: null } }, { position: { lat: '37.7700', lng: -122.4300 } },
        { position: { lat: 91, lng: -122.4300 } }, { position: { lat: 37.7700, lng: -181 } },
        { sampledAt: null }, { sampledAt: '1800000000000' }, { sampledAt: Infinity },
        { sampledAt: START + 15001 }, { receivedAtMs: null }, { receivedAtMs: START + 15001 }
    ]) {
        const h = harness();
        h.sample(changes);
        await flush();
        assert.equal(h.requests.length, 0);
        assert.equal(h.notices.at(-1).state, 'waiting');
    }
});

test('old captured or received GPS remains stale even when the other timestamp is current', async () => {
    for (const changes of [{ sampledAt: START - 15001 }, { receivedAtMs: START - 15001 }, { stale: true }, { active: false }]) {
        const h = harness();
        h.sample(changes);
        await flush();
        assert.equal(h.requests.length, 0);
        assert.equal(h.notices.at(-1).state, 'stale');
        assert.equal(h.notices.at(-1).durationSeconds, null);
    }
});

test('GPS expiration removes the route and ETA without another position message', async () => {
    const h = harness();
    h.sample();
    await flush();
    await h.advance(15000);
    assert.equal(h.notices.at(-1).state, 'ready');
    await h.advance(1);
    assert.equal(h.notices.at(-1).state, 'stale');
    assert.equal(h.notices.at(-1).durationSeconds, null);
    assert.equal(h.notices.at(-1).computedAtMs, null);
    assert.equal(h.polylines[0].map, null);
    assert.equal(h.timers.size, 0);
});

test('duplicate GPS polls and older out-of-order samples never refresh the capture age', async () => {
    const h = harness();
    h.sample();
    await flush();
    await h.advance(10000);
    h.sample({ sampledAt: START, position: { lat: 20, lng: 75 } });
    h.sample({ sampledAt: START - 1 });
    await h.advance(5001);
    assert.equal(h.notices.at(-1).state, 'stale');
    assert.equal(h.requests.length, 1);
});

test('throttles frequent GPS to one request per 30 seconds and uses the newest fix at the deadline', async () => {
    const h = harness();
    h.sample();
    await flush();
    for (let i = 1; i <= 9; i++) {
        await h.advance(3000);
        h.sample({ position: { lat: 37.7700 + i / 10000, lng: -122.4300 } });
        await flush();
    }
    assert.equal(h.requests.length, 1);
    await h.advance(2999);
    assert.equal(h.requests.length, 1);
    await h.advance(1);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].at - h.requests[0].at, 30000);
    assert.ok(Math.abs(h.requests[1].request.origin.lat - 37.7709) < 1e-10);
    assert.equal(h.notices.at(-1).sampledAt, START + 27000);
    assert.equal(h.polylines[0].map, null);
    assert.equal(h.polylines[1].map, h.map);
});

test('route timeout hides ETA, ignores the late result, and never overlaps the unabortable call', async () => {
    const pending = deferred();
    const h = harness({ compute: () => pending.promise });
    h.sample();
    await flush();
    await h.advance(10000);
    h.sample();
    await h.advance(2000);
    assert.equal(h.notices.at(-1).state, 'unavailable');
    assert.match(h.notices.at(-1).message, /too long/);
    for (let i = 0; i < 3; i++) { await h.advance(10000); h.sample(); }
    await flush();
    assert.equal(h.requests.length, 1);
    pending.resolve(routeResult());
    await flush();
    assert.equal(h.notices.filter(value => value.state === 'ready' && value.sampledAt === START).length, 0);
    assert.equal(h.requests.length, 2, 'A new call starts only after the earlier promise settles');
});

test('a timed-out library import cannot start computeRoutes when it eventually resolves', async () => {
    const pending = deferred();
    let computations = 0;
    const h = harness({ library: () => pending.promise });
    h.sample();
    await flush();
    await h.advance(12000);
    pending.resolve({ Route: { computeRoutes() { computations++; return routeResult(); } } });
    await flush();
    assert.equal(computations, 0);
    assert.equal(h.notices.at(-1).state, 'unavailable');
});

test('slow library loading still leaves 30 seconds between actual computeRoutes calls', async () => {
    const pending = deferred();
    const computations = [];
    const h = harness({ library: () => pending.promise });
    h.sample();
    await flush();
    await h.advance(5000);
    pending.resolve({ Route: { computeRoutes() {
        computations.push(h.now);
        return Promise.resolve(routeResult());
    } } });
    await flush();
    assert.equal(computations[0], START + 5000);
    for (let i = 0; i < 5; i++) { await h.advance(5000); h.sample(); }
    await flush();
    assert.equal(computations.length, 1);
    await h.advance(5000);
    assert.equal(computations.length, 2);
    assert.equal(computations[1] - computations[0], 30000);
});

test('GPS that expires during library loading never starts a billable route request', async () => {
    const pending = deferred();
    let computations = 0;
    const h = harness({ library: () => pending.promise });
    h.sample({ sampledAt: START - 14000 });
    await flush();
    h.jump(2000);
    pending.resolve({ Route: { computeRoutes() { computations++; return routeResult(); } } });
    await flush();
    assert.equal(computations, 0);
    assert.equal(h.notices.at(-1).state, 'stale');
});

test('no route, malformed metrics, and invalid returned paths hide ETA rather than inventing a duration', async () => {
    for (const answer of [
        { routes: [] }, routeResult({ durationMillis: Infinity }), routeResult({ durationMillis: -1 }),
        routeResult({ distanceMeters: '1200' }), routeResult({ path: [] }),
        routeResult({ path: [{ lat: 91, lng: 73 }, CUSTOMER] })
    ]) {
        const h = harness({ compute: () => Promise.resolve(answer) });
        h.sample();
        await flush();
        assert.equal(h.notices.at(-1).state, 'unavailable');
        assert.equal(h.notices.at(-1).durationSeconds, null);
        assert.equal(h.polylines.length, 0);
    }
});

test('request errors and drawing errors stay isolated from the consumer', async () => {
    for (const options of [
        { compute: () => Promise.reject(Error('denied')) },
        { library: () => Promise.reject(Error('network')) },
        { library: () => Promise.resolve({}) }, { polylineThrows: true }
    ]) {
        const h = harness(options);
        h.sample();
        await flush();
        assert.equal(h.notices.at(-1).state, 'unavailable');
        assert.equal(h.notices.at(-1).durationSeconds, null);
        assert.match(h.notices.at(-1).message, /GPS tracking is still available/);
    }
});

test('consumer callback exceptions never prevent a successful route from rendering', async () => {
    const h = harness({ callbackThrows: true });
    h.sample();
    await flush();
    assert.equal(h.notices.at(-1).state, 'ready');
    assert.equal(h.polylines[0].map, h.map);
});

test('pausing or an explicit stale update hides route immediately and invalidates in-flight results', async () => {
    const pending = deferred();
    const h = harness({ compute: () => pending.promise });
    h.sample();
    await flush();
    h.service.update({ active: false });
    assert.equal(h.notices.at(-1).state, 'stale');
    pending.resolve(routeResult());
    await flush();
    assert.equal(h.polylines.length, 0);
    assert.equal(h.notices.at(-1).durationSeconds, null);
    await h.advance(30000);
    h.sample();
    await flush();
    assert.equal(h.notices.at(-1).state, 'ready');
    h.service.update({ stale: true });
    assert.equal(h.notices.at(-1).state, 'stale');
    assert.equal(h.polylines.at(-1).map, null);
});

test('clearing a session invalidates late results and retains request spacing across the reset', async () => {
    const pending = deferred();
    const h = harness({ compute: () => pending.promise });
    h.sample();
    await flush();
    h.service.clear();
    assert.equal(h.notices.at(-1).state, 'waiting');
    assert.equal(h.timers.size, 0);
    await h.advance(1000);
    h.sample();
    await flush();
    assert.equal(h.requests.length, 1);
    pending.resolve(routeResult());
    await flush();
    assert.equal(h.polylines.length, 0);
    assert.equal(h.requests.length, 1);
    await h.advance(10000);
    h.sample();
    await h.advance(10000);
    h.sample();
    await h.advance(9000);
    assert.equal(h.requests.length, 2);
    assert.equal(h.notices.at(-1).sampledAt, START + 21000);
});

test('a route over 90 seconds old is hidden even when a suspended tab resumes with fresh GPS', async () => {
    const pending = deferred();
    let count = 0;
    const h = harness({ compute: () => ++count === 1 ? Promise.resolve(routeResult()) : pending.promise });
    h.sample();
    await flush();
    h.jump(90001); // Simulate a suspended browser: old timeouts have not run yet.
    h.sample();
    await flush();
    assert.equal(h.polylines[0].map, null);
    assert.equal(h.notices.at(-1).durationSeconds, null);
    assert.ok(h.notices.some(value => value.state === 'stale' && /expired/.test(value.message)));
});

test('dispose removes the route, cancels every timer, and ignores late work or subsequent updates', async () => {
    const ready = harness();
    ready.sample();
    await flush();
    ready.service.dispose();
    assert.equal(ready.polylines[0].map, null);
    assert.equal(ready.timers.size, 0);
    const count = ready.notices.length;
    ready.sample();
    ready.service.clear();
    ready.service.dispose();
    await flush();
    assert.equal(ready.notices.length, count);

    const pending = deferred();
    const loading = harness({ compute: () => pending.promise });
    loading.sample();
    await flush();
    loading.service.dispose();
    assert.equal(loading.timers.size, 0);
    pending.resolve(routeResult());
    await flush();
    assert.equal(loading.polylines.length, 0);
});

test('returned LatLng objects are normalized and an actual zero-duration route remains valid', async () => {
    const h = harness({ compute: () => Promise.resolve(routeResult({
        durationMillis: 0, distanceMeters: 0,
        path: [{ lat: () => 37.7700, lng: () => -122.4300 }, CUSTOMER]
    })) });
    h.sample();
    await flush();
    assert.equal(h.notices.at(-1).state, 'ready');
    assert.equal(h.notices.at(-1).durationSeconds, 0);
    assert.deepEqual(plain(h.polylines[0].path[0]), { lat: 37.7700, lng: -122.4300 });
});

test('invalid map setup fails synchronously and the resource remains public for invited phones', () => {
    const h = harness();
    assert.throws(() => h.window.TechnicianRouteService.create({ map: {}, customer: { lat: null, lng: null } }), /valid customer/);
    const metadata = readFileSync(new URL('../../force-app/main/default/staticresources/TechnicianRouteService.resource-meta.xml', import.meta.url), 'utf8');
    assert.match(metadata, /<cacheControl>Public<\/cacheControl>/);
});
