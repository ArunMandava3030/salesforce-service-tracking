(function () {
    'use strict';

    const REQUEST_INTERVAL_MS = 30000;
    const REQUEST_TIMEOUT_MS = 12000;
    const GPS_MAX_AGE_MS = 15000;
    const ROUTE_MAX_AGE_MS = 90000;

    function validPosition(value) {
        return value && Number.isFinite(value.lat) && Number.isFinite(value.lng) &&
            Math.abs(value.lat) <= 90 && Math.abs(value.lng) <= 180;
    }

    function create(options) {
        if (!options || !options.map || !validPosition(options.customer)) {
            throw new Error('A map and valid customer coordinates are required.');
        }
        const map = options.map;
        const customer = { lat: options.customer.lat, lng: options.customer.lng };
        let disposed = false;
        let generation = 0;
        let latest;
        let active = true;
        let explicitlyStale = false;
        let route;
        let polyline;
        let flight;
        let nextRequestAt = 0;
        let requestedSampledAt = 0;
        let wakeTimer;
        let failureMessage = '';
        let lastNotice = '';

        function emit(state, message) {
            if (disposed) return;
            const ready = state === 'ready' && route;
            const notice = {
                state: state,
                durationSeconds: ready ? route.durationSeconds : null,
                distanceMeters: ready ? route.distanceMeters : null,
                computedAtMs: ready ? route.computedAtMs : null,
                sampledAt: ready ? route.sampledAt : latest ? latest.sampledAt : null,
                message: message
            };
            const signature = JSON.stringify(notice);
            if (signature === lastNotice) return;
            lastNotice = signature;
            // A consumer's UI error must not interrupt GPS or leak a rejected promise.
            if (typeof options.onUpdate === 'function') {
                try { options.onUpdate(notice); } catch (error) { /* Isolate the consumer. */ }
            }
        }

        function clearWakeTimer() {
            if (wakeTimer !== undefined) window.clearTimeout(wakeTimer);
            wakeTimer = undefined;
        }

        function removeRoute() {
            route = undefined;
            if (polyline) {
                try { polyline.setMap(null); } catch (error) { /* The map may be disposed. */ }
                polyline = undefined;
            }
        }

        function invalidateFlight() {
            if (flight) {
                flight.invalid = true;
                window.clearTimeout(flight.timer);
            }
            // computeRoutes cannot be aborted. Keep its lock until it actually settles.
        }

        function fresh(sample, now) {
            return sample && now - sample.sampledAt <= GPS_MAX_AGE_MS &&
                now - sample.receivedAtMs <= GPS_MAX_AGE_MS &&
                sample.sampledAt <= now + GPS_MAX_AGE_MS;
        }

        function usable(call) {
            return !disposed && flight === call && !call.invalid && call.generation === generation;
        }

        function unavailable(message) {
            removeRoute();
            failureMessage = message;
            emit('unavailable', message);
        }

        function applyResult(result, call) {
            if (!usable(call)) return;
            const now = Date.now();
            if (!active || explicitlyStale || !fresh(latest, now) || !fresh(call.sample, now)) {
                call.invalid = true;
                return;
            }
            const answer = result && result.routes && result.routes[0];
            if (!answer || !Number.isFinite(answer.durationMillis) || answer.durationMillis < 0 ||
                !Number.isFinite(answer.distanceMeters) || answer.distanceMeters < 0 ||
                !Array.isArray(answer.path) || answer.path.length < 2) {
                unavailable('No driving route is available for these locations.');
                return;
            }
            const path = answer.path.map(function (point) {
                return {
                    lat: typeof point.lat === 'function' ? point.lat() : point.lat,
                    lng: typeof point.lng === 'function' ? point.lng() : point.lng
                };
            });
            if (!path.every(validPosition)) {
                unavailable('The driving route could not be displayed.');
                return;
            }
            const nextPolyline = new window.google.maps.Polyline({
                path: path,
                strokeColor: '#6941c6',
                strokeOpacity: 0.85,
                strokeWeight: 6,
                zIndex: 2,
                clickable: false
            });
            nextPolyline.setMap(map);
            removeRoute();
            polyline = nextPolyline;
            route = {
                durationSeconds: answer.durationMillis / 1000,
                distanceMeters: answer.distanceMeters,
                computedAtMs: now,
                sampledAt: call.sample.sampledAt
            };
            failureMessage = '';
            emit('ready', 'Driving estimate to the customer, based on current traffic.');
        }

        function requestRoute(now) {
            const call = {
                generation: generation,
                sample: latest,
                invalid: false
            };
            flight = call;
            requestedSampledAt = call.sample.sampledAt;
            nextRequestAt = now + REQUEST_INTERVAL_MS;
            failureMessage = '';
            if (!route) emit('loading', 'Calculating the driving route and arrival estimate…');
            call.timer = window.setTimeout(function () {
                if (!usable(call)) return;
                call.invalid = true;
                unavailable('The driving route took too long to load. GPS tracking is still available.');
                refresh();
            }, REQUEST_TIMEOUT_MS);

            Promise.resolve().then(function () {
                if (!usable(call)) return undefined;
                if (!window.google || !window.google.maps || !window.google.maps.importLibrary) {
                    throw new Error('The Routes library is unavailable.');
                }
                return window.google.maps.importLibrary('routes');
            }).then(function (library) {
                if (!usable(call)) return undefined;
                if (!active || explicitlyStale || !fresh(latest, Date.now()) || !fresh(call.sample, Date.now())) {
                    call.invalid = true;
                    return undefined;
                }
                if (!library || !library.Route || typeof library.Route.computeRoutes !== 'function') {
                    throw new Error('The Routes library is unavailable.');
                }
                // Library loading also takes time: space the actual billable calls, not only their setup.
                nextRequestAt = Math.max(nextRequestAt, Date.now() + REQUEST_INTERVAL_MS);
                return library.Route.computeRoutes({
                    origin: call.sample.position,
                    destination: customer,
                    travelMode: 'DRIVING',
                    routingPreference: 'TRAFFIC_AWARE',
                    fields: ['path', 'durationMillis', 'distanceMeters']
                });
            }).then(function (result) {
                applyResult(result, call);
            }).catch(function () {
                if (usable(call)) {
                    unavailable('Driving route unavailable. Check Routes API access, billing, and your connection. GPS tracking is still available.');
                }
            }).finally(function () {
                window.clearTimeout(call.timer);
                if (flight === call) flight = undefined;
                if (!disposed) refresh();
            });
        }

        function refresh() {
            clearWakeTimer();
            if (disposed) return;
            const now = Date.now();
            if (!active || explicitlyStale || (latest && !fresh(latest, now))) {
                invalidateFlight();
                removeRoute();
                emit('stale', active ? 'Waiting for a fresh GPS location before estimating arrival.' :
                    'Location sharing is paused or ended.');
                return;
            }
            if (!latest) {
                emit('waiting', 'Waiting for the technician phone GPS.');
                return;
            }
            if (route && now - route.computedAtMs > ROUTE_MAX_AGE_MS) {
                removeRoute();
                failureMessage = '';
                emit('stale', 'The driving estimate has expired. Waiting for an updated route.');
            }
            if (!flight && latest.sampledAt !== requestedSampledAt && now >= nextRequestAt) {
                requestRoute(now);
            }
            if (route) {
                emit('ready', 'Driving estimate to the customer, based on current traffic.');
            } else if (failureMessage) {
                emit('unavailable', failureMessage);
            } else {
                emit('loading', 'Calculating the driving route and arrival estimate…');
            }

            let wakeAt = Math.min(latest.sampledAt, latest.receivedAtMs) + GPS_MAX_AGE_MS + 1;
            if (route) wakeAt = Math.min(wakeAt, route.computedAtMs + ROUTE_MAX_AGE_MS + 1);
            if (!flight && latest.sampledAt !== requestedSampledAt && nextRequestAt > now) {
                wakeAt = Math.min(wakeAt, nextRequestAt);
            }
            wakeTimer = window.setTimeout(refresh, Math.max(1, wakeAt - now));
        }

        function update(value) {
            if (disposed || !value || typeof value !== 'object') return;
            if (typeof value.active === 'boolean') active = value.active;
            if (typeof value.stale === 'boolean') explicitlyStale = value.stale;
            const now = Date.now();
            if (validPosition(value.position) && Number.isFinite(value.sampledAt) &&
                value.sampledAt > 0 && value.sampledAt <= now + GPS_MAX_AGE_MS &&
                (!latest || value.sampledAt > latest.sampledAt)) {
                const receivedAtMs = value.receivedAtMs === undefined ? now : value.receivedAtMs;
                if (Number.isFinite(receivedAtMs) && receivedAtMs > 0 && receivedAtMs <= now + GPS_MAX_AGE_MS) {
                    latest = {
                        position: { lat: value.position.lat, lng: value.position.lng },
                        sampledAt: value.sampledAt,
                        receivedAtMs: receivedAtMs
                    };
                }
            }
            refresh();
        }

        function clear() {
            if (disposed) return;
            generation += 1;
            invalidateFlight();
            clearWakeTimer();
            latest = undefined;
            requestedSampledAt = 0;
            active = true;
            explicitlyStale = false;
            failureMessage = '';
            removeRoute();
            emit('waiting', 'Waiting for the technician phone GPS.');
        }

        function dispose() {
            if (disposed) return;
            disposed = true;
            generation += 1;
            invalidateFlight();
            clearWakeTimer();
            latest = undefined;
            removeRoute();
        }

        emit('waiting', 'Waiting for the technician phone GPS.');
        return { update: update, clear: clear, dispose: dispose };
    }

    window.TechnicianRouteService = Object.freeze({ create: create });
}());
