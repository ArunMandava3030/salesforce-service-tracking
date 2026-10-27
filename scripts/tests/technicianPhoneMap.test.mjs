import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../../force-app/main/default/staticresources/TechnicianPhoneMapScript.js');
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
    let now = 1800000000000;
    let nextTimer = 0;
    const timers = new Map();
    const nodes = Object.fromEntries(['phone-map', 'phone-map-status', 'phone-eta', 'phone-route-distance']
        .map(name => [name, { textContent: '' }]));
    const panel = { querySelector: selector => nodes[selector.slice(6, -1)] || null };
    const scripts = [];
    const maps = [];
    const markers = [];
    const routes = [];
    const libraries = [];
    const window = {
        setTimeout(fn, delay) { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
        TechnicianRouteService: {
            create(config) {
                const route = { config, updates: [], clears: 0, disposed: false,
                    update(sample) { this.updates.push(sample); },
                    clear() { this.clears += 1; },
                    dispose() { this.disposed = true; } };
                routes.push(route);
                return route;
            }
        }
    };
    const document = {
        createElement(tag) { return { tagName: tag, className: '', textContent: '' }; },
        head: { appendChild(script) { scripts.push(script); } }
    };
    class ClockDate extends Date { static now() { return now; } }
    function installGoogle() {
        window.google = { maps: {
            importLibrary(name) {
                libraries.push(name);
                return options.pendingLibraries ? new Promise(() => {}) : Promise.resolve({});
            },
            Map: class {
                constructor(canvas, config) { this.canvas = canvas; this.config = config; this.bounds = []; maps.push(this); }
                fitBounds(bounds, padding) { this.bounds.push({ points: bounds.points, padding }); }
            },
            LatLngBounds: class {
                points = [];
                extend(point) { this.points.push(point); }
            },
            marker: { AdvancedMarkerElement: class {
                constructor(config) { Object.assign(this, config); markers.push(this); }
            } }
        } };
    }
    if (options.loaded !== false) installGoogle();
    vm.runInNewContext(source, { window, document, URL, Date: ClockDate });
    const adapter = window.TechnicianPhoneMap.create(panel);
    return {
        adapter, window, scripts, maps, markers, routes, nodes, libraries, timers,
        config: overrides => ({ active: true, expiresAtMs: now + 3600000,
            customerLatitude: 37.7749, customerLongitude: -122.4194,
            browserMapsKey: 'owner-configured-test-key', ...overrides }),
        fix: overrides => ({ position: { lat: 37.7730, lng: -122.4210 }, sampledAt: now,
            receivedAtMs: now, active: true, stale: false, ...overrides }),
        finishMaps() { installGoogle(); window.initTechnicianPhoneMap(); },
        emit(result = {}) { routes.at(-1).config.onUpdate({ state: 'ready', durationSeconds: 125,
            distanceMeters: 1800, computedAtMs: now, sampledAt: now, ...result }); },
        advance(milliseconds) {
            const target = now + milliseconds;
            while (true) {
                const next = [...timers].filter(([, timer]) => timer.at <= target)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                timers.delete(next[0]);
                now = next[1].at;
                next[1].fn();
            }
            now = target;
        }
    };
}

test('configuration shows only the fixed customer until an actual GPS sample arrives', async () => {
    const h = harness();
    assert.equal(h.maps.length, 0);
    assert.equal(await h.adapter.configure(h.config()), true);
    assert.equal(h.maps.length, 1);
    assert.equal(h.markers.length, 1);
    assert.deepEqual(plain(h.markers[0].position), { lat: 37.7749, lng: -122.4194 });
    assert.equal(h.markers[0].title, 'Customer');
    assert.deepEqual(h.libraries, ['maps', 'marker']);
    assert.equal(h.routes[0].updates.length, 0);
    assert.equal(h.nodes['phone-eta'].textContent, 'Not available');
    h.adapter.dispose();
});

test('a deferred map uses the latest real phone fix and renders route time and road distance', async () => {
    const h = harness({ loaded: false });
    h.adapter.update(h.fix());
    const ready = h.adapter.configure(h.config());
    assert.equal(h.scripts.length, 1);
    const scriptUrl = new URL(h.scripts[0].src);
    assert.equal(scriptUrl.origin, 'https://maps.googleapis.com');
    assert.equal(scriptUrl.searchParams.get('callback'), 'initTechnicianPhoneMap');
    assert.equal(scriptUrl.searchParams.get('key'), 'owner-configured-test-key');
    assert.equal(scriptUrl.searchParams.has('invite'), false);
    assert.equal(scriptUrl.searchParams.has('sessionId'), false);
    h.advance(1000);
    const latest = h.fix({ position: { lat: 37.7750, lng: -122.4190 } });
    h.adapter.update(latest);
    h.finishMaps();
    assert.equal(await ready, true);
    assert.equal(h.markers.length, 2);
    assert.deepEqual(plain(h.markers[1].position), latest.position);
    assert.deepEqual(plain(h.routes[0].updates.at(-1)), latest);
    assert.deepEqual(plain(h.maps[0].bounds[0].points), [{ lat: 37.7749, lng: -122.4194 }, latest.position]);
    h.emit();
    assert.equal(h.nodes['phone-eta'].textContent, '3 min');
    assert.equal(h.nodes['phone-route-distance'].textContent, '1.8 km');
    h.advance(1000);
    h.adapter.update(h.fix({ position: { lat: 37.7760, lng: -122.4180 } }));
    assert.equal(h.markers.length, 2);
    assert.deepEqual(plain(h.markers[1].position), { lat: 37.7760, lng: -122.4180 });
    h.adapter.dispose();
});

test('GPS older than fifteen seconds clears ETA and late route callbacks cannot restore it', async () => {
    const h = harness();
    await h.adapter.configure(h.config());
    h.adapter.update(h.fix());
    h.emit();
    h.advance(15000);
    assert.equal(h.nodes['phone-eta'].textContent, '3 min');
    h.advance(1);
    assert.equal(h.nodes['phone-eta'].textContent, 'Not available');
    assert.equal(h.nodes['phone-route-distance'].textContent, 'Not available');
    assert.equal(h.routes[0].clears, 1);
    h.emit();
    assert.equal(h.nodes['phone-eta'].textContent, 'Not available');
    h.adapter.update(h.fix());
    h.emit({ durationSeconds: 45, distanceMeters: 190 });
    assert.equal(h.nodes['phone-eta'].textContent, 'Less than a minute');
    assert.equal(h.nodes['phone-route-distance'].textContent, '190 m');
    h.adapter.dispose();
});

test('paused, stale, and invalid positions do not invent a technician or request a route', async () => {
    const h = harness();
    await h.adapter.configure(h.config());
    for (const sample of [
        h.fix({ active: false }), h.fix({ stale: true }),
        h.fix({ sampledAt: 0 }), h.fix({ sampledAt: 1799999984999 }),
        h.fix({ position: { lat: 91, lng: 73 } }), h.fix({ position: { lat: null, lng: 73 } })
    ]) h.adapter.update(sample);
    assert.equal(h.markers.length, 1);
    assert.equal(h.routes[0].updates.length, 0);
    assert.equal(h.nodes['phone-eta'].textContent, 'Not available');
    h.adapter.dispose();
});

test('pause clears route and ETA, and disposal releases markers and prevents future updates', async () => {
    const h = harness();
    await h.adapter.configure(h.config());
    h.adapter.update(h.fix());
    h.emit();
    h.adapter.pause('Sharing paused.');
    assert.equal(h.nodes['phone-eta'].textContent, 'Not available');
    assert.equal(h.timers.size, 0);
    h.emit();
    assert.equal(h.nodes['phone-map-status'].textContent, 'Sharing paused.');
    h.adapter.dispose();
    assert.equal(h.routes[0].disposed, true);
    assert.ok(h.markers.every(marker => marker.map === null));
    const calls = h.routes[0].updates.length;
    h.adapter.update(h.fix());
    assert.equal(h.routes[0].updates.length, calls);
    assert.equal(await h.adapter.configure(h.config()), false);
});

test('disposal during Maps loading cancels deadlines and drops the late Google callback', async () => {
    const h = harness({ loaded: false });
    const request = h.adapter.configure(h.config());
    assert.equal(h.timers.size, 1);
    h.adapter.dispose();
    assert.equal(h.timers.size, 0);
    assert.equal(await request, false);
    h.finishMaps();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.maps.length, 0);
    assert.equal(h.routes.length, 0);
});

test('missing setup, script failures, and library timeouts leave GPS-independent map errors', async () => {
    const missing = harness({ loaded: false });
    assert.equal(await missing.adapter.configure(missing.config({ browserMapsKey: null })), false);
    assert.equal(await missing.adapter.configure(missing.config({ customerLatitude: null })), false);
    assert.equal(missing.scripts.length, 0);
    assert.equal(missing.nodes['phone-eta'].textContent, 'Not available');
    missing.adapter.dispose();

    const failed = harness({ loaded: false });
    const scriptRequest = failed.adapter.configure(failed.config());
    failed.scripts[0].onerror();
    assert.equal(await scriptRequest, false);
    assert.match(failed.nodes['phone-map-status'].textContent, /GPS sharing can continue/);
    assert.equal(failed.timers.size, 0);
    failed.adapter.dispose();

    const stalled = harness({ pendingLibraries: true });
    const libraryRequest = stalled.adapter.configure(stalled.config());
    stalled.advance(25000);
    assert.equal(await libraryRequest, false);
    assert.equal(stalled.maps.length, 0);
    assert.equal(stalled.timers.size, 0);
    stalled.adapter.dispose();
});

test('a Maps authentication failure after initialization clears ETA and suppresses more route calls', async () => {
    const h = harness({ loaded: false });
    const request = h.adapter.configure(h.config());
    h.finishMaps();
    await request;
    h.adapter.update(h.fix());
    h.emit();
    h.window.gm_authFailure();
    assert.equal(h.nodes['phone-eta'].textContent, 'Not available');
    assert.match(h.nodes['phone-map-status'].textContent, /could not be authorized/);
    const calls = h.routes[0].updates.length;
    h.adapter.update(h.fix());
    assert.equal(h.routes[0].updates.length, calls);
    h.adapter.dispose();
});

test('both phone pages load the shared route adapter in order and preserve remoting and Google referrers', () => {
    for (const name of ['TechnicianGpsInvite', 'TechnicianGpsPublisher']) {
        const page = read('../../force-app/main/default/pages/' + name + '.page');
        assert.match(page, /<meta name="referrer" content="strict-origin-when-cross-origin"/);
        const route = page.indexOf('URLFOR($Resource.TechnicianRouteService)');
        const adapter = page.indexOf('URLFOR($Resource.TechnicianPhoneMapScript)');
        const publisher = page.indexOf('URLFOR($Resource.TechnicianGpsPublisherScript)');
        assert.ok(route > 0 && route < adapter && adapter < publisher);
        assert.match(page, /data-action-directions=/);
        assert.match(page, /data-phone-eta=/);
        assert.doesNotMatch(page, /<a\b|Navigate|Start navigation|label="Google Maps API key"/i);
    }
});
