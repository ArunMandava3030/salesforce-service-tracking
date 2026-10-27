(function () {
    'use strict';
    const STALE_MS = 15000;
    let mapsPromise;
    const authenticationFailures = new Set();

    function loadMaps(apiKey) {
        if (window.google && window.google.maps && window.google.maps.importLibrary) {
            return Promise.resolve();
        }
        if (mapsPromise) return mapsPromise;
        mapsPromise = new Promise(function (resolve, reject) {
            let settled = false;
            function finish(ok) {
                if (settled) return;
                settled = true;
                if (ok) resolve();
                else reject(new Error('The phone map could not load. Ask the session owner to check the Maps key and allowed websites, then refresh. GPS sharing can continue.'));
            }
            window.initTechnicianPhoneMap = function () { finish(true); };
            window.gm_authFailure = function () {
                finish(false);
                authenticationFailures.forEach(function (listener) { listener(); });
            };
            const script = document.createElement('script');
            const url = new URL('https://maps.googleapis.com/maps/api/js');
            url.searchParams.set('key', apiKey);
            url.searchParams.set('loading', 'async');
            url.searchParams.set('callback', 'initTechnicianPhoneMap');
            url.searchParams.set('libraries', 'marker');
            url.searchParams.set('v', 'weekly');
            script.src = url.toString();
            script.async = true;
            script.onerror = function () { finish(false); };
            document.head.appendChild(script);
        });
        return mapsPromise;
    }

    function numeric(value) {
        if (typeof value === 'string' && value.trim() !== '') value = Number(value);
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    function validPosition(position) {
        return position && Number.isFinite(position.lat) && Number.isFinite(position.lng) &&
            Math.abs(position.lat) <= 90 && Math.abs(position.lng) <= 180;
    }

    function create(panel) {
        const find = function (name) { return panel.querySelector('[data-' + name + ']'); };
        const canvas = find('phone-map');
        let map;
        let customerMarker;
        let technicianMarker;
        let route;
        let customer;
        let latest;
        let freshnessTimer = null;
        let generation = 0;
        let disposed = false;
        let authorizationFailed = false;
        let sharing = false;
        let fitted = false;
        let cancelLoading = null;

        function stopLoading() {
            if (cancelLoading) {
                const cancel = cancelLoading;
                cancelLoading = null;
                cancel();
            }
        }

        function authenticationFailed() {
            if (disposed) return;
            authorizationFailed = true;
            pause('The Maps key could not be authorized for this phone page. Ask the session owner to check Maps setup, then refresh. GPS sharing can continue.');
        }
        authenticationFailures.add(authenticationFailed);

        function text(name, value) {
            const element = find(name);
            if (element) element.textContent = value;
        }

        function clearEta(message) {
            text('phone-eta', 'Not available');
            text('phone-route-distance', 'Not available');
            text('phone-map-status', message);
        }

        function fresh(sample) {
            return sample && validPosition(sample.position) && Number.isFinite(sample.sampledAt) &&
                sample.sampledAt > 0 && sample.sampledAt <= Date.now() + 30000 &&
                Date.now() - sample.sampledAt <= STALE_MS &&
                (!Number.isFinite(sample.receivedAtMs) || Date.now() - sample.receivedAtMs <= STALE_MS) &&
                sample.active !== false && sample.stale !== true;
        }

        function routeUpdate(result) {
            if (disposed || !sharing || !fresh(latest)) return;
            if (result.state === 'ready' && Number.isFinite(result.durationSeconds) &&
                Number.isFinite(result.distanceMeters) && result.durationSeconds >= 0 && result.distanceMeters >= 0) {
                text('phone-eta', result.durationSeconds < 60 ? 'Less than a minute' : Math.ceil(result.durationSeconds / 60) + ' min');
                text('phone-route-distance', result.distanceMeters >= 1000
                    ? (result.distanceMeters / 1000).toFixed(1) + ' km' : Math.round(result.distanceMeters) + ' m');
                text('phone-map-status', 'Road route to the customer. Estimated driving time updates as you move.');
            } else {
                clearEta(result.message || 'Waiting for a driving route to the customer.');
            }
        }

        function markerContent(label, kind) {
            const element = document.createElement('div');
            element.className = 'phone-pin ' + kind;
            element.textContent = label;
            return element;
        }

        function showPosition() {
            if (!map || !latest || !validPosition(latest.position)) return;
            if (!technicianMarker) {
                technicianMarker = new window.google.maps.marker.AdvancedMarkerElement({
                    map: map, position: latest.position, title: 'Your phone', content: markerContent('T', 'technician')
                });
            } else technicianMarker.position = latest.position;
            if (!fitted) {
                const bounds = new window.google.maps.LatLngBounds();
                bounds.extend(customer);
                bounds.extend(latest.position);
                map.fitBounds(bounds, 48);
                fitted = true;
            }
        }

        function update(sample) {
            if (disposed || authorizationFailed) return;
            window.clearTimeout(freshnessTimer);
            freshnessTimer = null;
            latest = sample;
            sharing = Boolean(sample && sample.active !== false);
            if (!sharing || !fresh(sample)) {
                if (route) route.clear();
                clearEta(sharing ? 'GPS is stale. Waiting for a fresh phone position before showing an ETA.'
                    : 'Location sharing is paused. Start sharing for a current route and ETA.');
                return;
            }
            showPosition();
            if (route) route.update(sample);
            const oldest = Number.isFinite(sample.receivedAtMs)
                ? Math.min(sample.sampledAt, sample.receivedAtMs) : sample.sampledAt;
            freshnessTimer = window.setTimeout(function () {
                freshnessTimer = null;
                if (disposed || latest !== sample) return;
                if (route) route.clear();
                clearEta('GPS is stale. Waiting for a fresh phone position before showing an ETA.');
            }, Math.max(1, oldest + STALE_MS + 1 - Date.now()));
        }

        async function configure(config) {
            if (disposed || authorizationFailed) return false;
            stopLoading();
            const currentGeneration = ++generation;
            const position = { lat: numeric(config.customerLatitude), lng: numeric(config.customerLongitude) };
            if (!canvas || !validPosition(position) || config.active !== true ||
                !(numeric(config.expiresAtMs) > Date.now()) || typeof config.browserMapsKey !== 'string' || !config.browserMapsKey.trim()) {
                clearEta('The customer map is not ready. GPS sharing can continue.');
                return false;
            }
            if (map) {
                if (latest) update(latest);
                return true;
            }
            text('phone-map-status', 'Loading the customer map...');
            try {
                const ready = await new Promise(function (resolve) {
                    let settled = false;
                    const timer = window.setTimeout(function () { finish(false); }, 25000);
                    function finish(ok) {
                        if (settled) return;
                        settled = true;
                        window.clearTimeout(timer);
                        if (generation === currentGeneration) cancelLoading = null;
                        resolve(ok);
                    }
                    cancelLoading = function () { finish(false); };
                    loadMaps(config.browserMapsKey.trim()).then(function () {
                        if (disposed || generation !== currentGeneration) return false;
                        return Promise.all([
                            window.google.maps.importLibrary('maps'), window.google.maps.importLibrary('marker')
                        ]).then(function () { return true; });
                    }).then(function (ok) { finish(ok); }, function () { finish(false); });
                });
                if (disposed || generation !== currentGeneration) return false;
                if (!ready) throw new Error('Maps loading failed.');
                customer = position;
                map = new window.google.maps.Map(canvas, {
                    center: customer, zoom: 15, mapId: 'DEMO_MAP_ID',
                    streetViewControl: false, mapTypeControl: false, fullscreenControl: true
                });
                customerMarker = new window.google.maps.marker.AdvancedMarkerElement({
                    map: map, position: customer, title: 'Customer', content: markerContent('C', 'customer')
                });
                if (!window.TechnicianRouteService) throw new Error('Route service unavailable.');
                route = window.TechnicianRouteService.create({ map: map, customer: customer, onUpdate: routeUpdate });
                clearEta('Customer shown. Start sharing to see your position, driving route, and ETA.');
                if (latest) update(latest);
                return true;
            } catch (error) {
                if (!disposed && generation === currentGeneration) {
                    clearEta('The phone map could not load. Ask the session owner to check Maps setup and refresh this page. GPS sharing can continue.');
                }
                return false;
            }
        }

        function pause(message) {
            generation += 1;
            stopLoading();
            sharing = false;
            latest = null;
            window.clearTimeout(freshnessTimer);
            freshnessTimer = null;
            if (route) route.clear();
            clearEta(message || 'Location sharing is paused.');
        }

        function dispose() {
            if (disposed) return;
            pause('Location sharing has stopped.');
            disposed = true;
            authenticationFailures.delete(authenticationFailed);
            if (route) route.dispose();
            if (customerMarker) customerMarker.map = null;
            if (technicianMarker) technicianMarker.map = null;
            route = null;
            map = null;
        }

        return { configure: configure, update: update, pause: pause, dispose: dispose };
    }

    window.TechnicianPhoneMap = { create: create };
}());
