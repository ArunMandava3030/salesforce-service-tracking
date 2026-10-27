/* global URL, URLSearchParams */
(function () {
    'use strict';

    const SCOPE = 'technician-live-tracking-poc';
    const BRIDGE_VERSION = '2026-10-08.live2';
    const GOOGLE_LOAD_TIMEOUT_MS = 25000;
    const FRAME_READY_RETRY_MS = 500;
    const MAX_FRAME_READY_ATTEMPTS = 20;
    const MAX_TRAIL_POINTS = 100;
    const TECHNICIAN_ZOOM = 17;
    const params = new URLSearchParams(window.location.search);
    const requestedOrigin = params.get('parentOrigin') || '';
    const channel = params.get('channel') || '';
    let parentOrigin = '';
    let phase = 'waiting';
    let mapElement;
    let statusElement;
    let map;
    let customer;
    let customerMarker;
    let routeService;
    let routeState = { active: true, stale: false };
    let technicianMarker;
    let accuracyCircle;
    let trail;
    let trailPoints = [];
    let pendingPosition;
    let lastSampledAt = 0;
    let followEnabled = true;
    let googleScript;
    let loadTimer;
    let readyTimer;
    let readyAttempts = 0;
    let started = false;

    function setStatus(message, isError) {
        if (statusElement) {
            statusElement.textContent = message;
            statusElement.setAttribute('data-error', isError ? 'true' : 'false');
        }
    }

    function send(type, payload) {
        if (!parentOrigin || phase === 'disposed') {
            return;
        }
        window.parent.postMessage(
            Object.assign({}, payload || {}, {
                scope: SCOPE,
                channel: channel,
                bridgeVersion: BRIDGE_VERSION,
                type: type
            }),
            parentOrigin
        );
    }

    function clearLoadTimer() {
        if (loadTimer !== undefined) {
            window.clearTimeout(loadTimer);
            loadTimer = undefined;
        }
    }

    function clearReadyTimer() {
        if (readyTimer !== undefined) {
            window.clearTimeout(readyTimer);
            readyTimer = undefined;
        }
    }

    function announceFrameReady() {
        if (phase !== 'waiting') return;
        readyAttempts += 1;
        send('frameReady');
        if (readyAttempts < MAX_FRAME_READY_ATTEMPTS) {
            readyTimer = window.setTimeout(function () {
                readyTimer = undefined;
                announceFrameReady();
            }, FRAME_READY_RETRY_MS);
        }
    }

    function fail(message) {
        if (phase === 'failed' || phase === 'disposed') {
            return;
        }
        phase = 'failed';
        clearLoadTimer();
        clearReadyTimer();
        pendingPosition = undefined;
        if (routeService) routeService.dispose();
        setStatus(message, true);
        send('mapError', { message: message });
    }

    function validPosition(position) {
        return position &&
            typeof position.lat === 'number' &&
            typeof position.lng === 'number' &&
            Number.isFinite(position.lat) &&
            Number.isFinite(position.lng) &&
            Math.abs(position.lat) <= 90 &&
            Math.abs(position.lng) <= 180;
    }

    function createMarker(position, title, glyphText, color) {
        const marker = new window.google.maps.marker.AdvancedMarkerElement({
            map: map,
            position: position,
            title: title,
            zIndex: glyphText === 'T' ? 1000 : 100
        });
        const pin = new window.google.maps.marker.PinElement({
            background: color,
            borderColor: color,
            glyphColor: '#ffffff',
            glyphText: glyphText,
            scale: glyphText === 'T' ? 1.25 : 1
        });
        marker.append(pin);
        return marker;
    }

    function fitBounds() {
        if (!map || phase !== 'ready') {
            return;
        }
        if (!technicianMarker) {
            map.setCenter(customer);
            map.setZoom(15);
            return;
        }
        const bounds = new window.google.maps.LatLngBounds();
        bounds.extend(customer);
        bounds.extend(technicianMarker.position);
        map.fitBounds(bounds, 60);
    }

    function focusTechnician() {
        if (phase !== 'ready' || !map || !technicianMarker) {
            return;
        }
        map.setCenter(technicianMarker.position);
        map.setZoom(TECHNICIAN_ZOOM);
    }

    function updatePosition(update) {
        const position = { lat: update.position.lat, lng: update.position.lng };
        const isFirstPosition = !technicianMarker;
        if (isFirstPosition) {
            technicianMarker = createMarker(position, 'Technician phone GPS', 'T', '#0b63ce');
        } else {
            technicianMarker.position = position;
        }

        const lastPoint = trailPoints[trailPoints.length - 1];
        if (!lastPoint || lastPoint.lat !== position.lat || lastPoint.lng !== position.lng) {
            trailPoints.push(position);
            if (trailPoints.length > MAX_TRAIL_POINTS) {
                trailPoints.shift();
            }
        }
        if (!trail) {
            trail = new window.google.maps.Polyline({
                map: map,
                path: trailPoints.slice(),
                strokeColor: '#0b63ce',
                strokeOpacity: 0.65,
                strokeWeight: 3,
                clickable: false
            });
        } else {
            trail.setPath(trailPoints.slice());
        }

        if (typeof update.accuracy === 'number' &&
            Number.isFinite(update.accuracy) &&
            update.accuracy >= 0 &&
            update.accuracy <= 100000) {
            if (!accuracyCircle) {
                accuracyCircle = new window.google.maps.Circle({
                    map: map,
                    center: position,
                    radius: update.accuracy,
                    fillColor: '#0b63ce',
                    fillOpacity: 0.1,
                    strokeColor: '#0b63ce',
                    strokeOpacity: 0.3,
                    strokeWeight: 1,
                    clickable: false
                });
            } else {
                accuracyCircle.setMap(map);
                accuracyCircle.setCenter(position);
                accuracyCircle.setRadius(update.accuracy);
            }
        } else if (accuracyCircle) {
            accuracyCircle.setMap(null);
        }

        setStatus('Latest location received from the technician phone.', false);
        if (isFirstPosition) {
            if (followEnabled) {
                focusTechnician();
            } else {
                fitBounds();
            }
        } else if (followEnabled) {
            map.panTo(position);
        }
    }

    function renderPosition(update) {
        try {
            updatePosition(update);
            updateRoute(update);
            send('positionRendered', {
                sampledAt: update.sampledAt,
                position: { lat: update.position.lat, lng: update.position.lng }
            });
            return true;
        } catch (error) {
            fail('The map could not display the technician GPS position. Reload the live map and try again.');
            return false;
        }
    }

    function routeUnavailable() {
        send('routeUpdated', {
            state: 'unavailable', durationSeconds: null, distanceMeters: null,
            computedAtMs: null, sampledAt: null,
            message: 'The driving route could not load. GPS tracking is still available.'
        });
    }

    function updateRoute(update) {
        if (!routeService) return;
        try {
            routeService.update(Object.assign({}, update, routeState));
        } catch (error) {
            routeService.dispose();
            routeService = undefined;
            routeUnavailable();
        }
    }

    function receiveRouteState(data) {
        if (typeof data.active === 'boolean') routeState.active = data.active;
        if (typeof data.stale === 'boolean') routeState.stale = data.stale;
    }

    function clearPosition() {
        pendingPosition = undefined;
        lastSampledAt = 0;
        routeState = { active: true, stale: false };
        if (routeService) routeService.clear();
        trailPoints = [];
        if (technicianMarker) {
            technicianMarker.map = null;
            technicianMarker = undefined;
        }
        if (accuracyCircle) {
            accuracyCircle.setMap(null);
            accuracyCircle = undefined;
        }
        if (trail) {
            trail.setMap(null);
            trail = undefined;
        }
        if (phase === 'ready') {
            fitBounds();
            setStatus('Waiting for the technician phone to share its location.', false);
        }
    }

    function receivePosition(data) {
        if (!validPosition(data.position) ||
            typeof data.sampledAt !== 'number' ||
            !Number.isFinite(data.sampledAt) ||
            data.sampledAt <= 0 || data.sampledAt < lastSampledAt) {
            return;
        }
        receiveRouteState(data);
        if (data.sampledAt === lastSampledAt) {
            // A repeated poll may pause or stale an ETA without redrawing old GPS.
            updateRoute(routeState);
            return;
        }
        lastSampledAt = data.sampledAt;
        const update = {
            position: { lat: data.position.lat, lng: data.position.lng },
            accuracy: data.accuracy,
            sampledAt: data.sampledAt,
            receivedAtMs: data.receivedAtMs
        };
        if (phase === 'ready') {
            renderPosition(update);
        } else {
            pendingPosition = update;
        }
    }

    function onGoogleReady() {
        if (phase !== 'loading') {
            return;
        }
        clearLoadTimer();
        try {
            if (!window.google || !window.google.maps ||
                !window.google.maps.marker ||
                !window.google.maps.marker.AdvancedMarkerElement ||
                !window.google.maps.marker.PinElement) {
                fail('Google Maps could not load its map markers. Check your connection, then reload the map.');
                return;
            }
            map = new window.google.maps.Map(mapElement, {
                center: customer,
                zoom: 15,
                maxZoom: 18,
                mapId: 'DEMO_MAP_ID',
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: true,
                gestureHandling: 'cooperative'
            });
            customerMarker = createMarker(customer, 'Customer', 'C', '#18794e');
            phase = 'ready';
            try {
                routeService = window.TechnicianRouteService.create({
                    map: map,
                    customer: customer,
                    onUpdate: function (update) {
                        if (phase === 'ready') send('routeUpdated', update);
                    }
                });
                updateRoute(routeState);
            } catch (error) {
                routeUnavailable();
            }
            setStatus('Waiting for the technician phone to share its location.', false);
            if (pendingPosition) {
                const update = pendingPosition;
                pendingPosition = undefined;
                if (!renderPosition(update)) {
                    return;
                }
            }
            send('mapReady');
            if (!routeService) routeUnavailable();
        } catch (error) {
            fail('The map could not be created. Check that your Google Maps key allows this page, then reload the map.');
        }
    }

    function initialize(data) {
        if (phase === 'ready') {
            send('mapReady');
            return;
        }
        if (phase !== 'waiting') {
            return;
        }
        clearReadyTimer();
        if (typeof data.apiKey !== 'string' || !data.apiKey.trim()) {
            fail('Enter a Google Maps API key, then reload the map.');
            return;
        }
        if (!validPosition(data.customer)) {
            fail('The customer location is invalid. Reload the Salesforce page.');
            return;
        }
        customer = { lat: data.customer.lat, lng: data.customer.lng };
        phase = 'loading';
        setStatus('Loading Google Maps…', false);
        window.initTechnicianLiveMap = onGoogleReady;
        window.gm_authFailure = function () {
            fail('Google Maps rejected the API key. Check Maps JavaScript API and billing, and allow ' + window.location.origin + '/* in the key website restrictions.');
        };
        googleScript = document.createElement('script');
        googleScript.async = true;
        googleScript.onerror = function () {
            fail('Google Maps could not be downloaded. Check your network and browser restrictions, then reload the map.');
        };
        const source = new URL('https://maps.googleapis.com/maps/api/js');
        source.searchParams.set('key', data.apiKey.trim());
        source.searchParams.set('loading', 'async');
        source.searchParams.set('callback', 'initTechnicianLiveMap');
        source.searchParams.set('libraries', 'marker');
        source.searchParams.set('v', 'weekly');
        googleScript.src = source.toString();
        loadTimer = window.setTimeout(function () {
            fail('Google Maps did not finish loading. Check your API key and connection, then reload the map.');
        }, GOOGLE_LOAD_TIMEOUT_MS);
        document.head.appendChild(googleScript);
    }

    function onMessage(event) {
        if (phase === 'failed' || phase === 'disposed' ||
            event.source !== window.parent ||
            event.origin !== parentOrigin) {
            return;
        }
        const data = event.data;
        if (!data || typeof data !== 'object' ||
            data.scope !== SCOPE || data.channel !== channel ||
            data.bridgeVersion !== BRIDGE_VERSION) {
            return;
        }
        switch (data.type) {
            case 'ping':
                send('frameReady');
                if (phase === 'ready') {
                    send('mapReady');
                }
                break;
            case 'initialize':
                initialize(data);
                break;
            case 'position':
                receivePosition(data);
                break;
            case 'follow':
                if (typeof data.enabled === 'boolean') {
                    followEnabled = data.enabled;
                    if (followEnabled && phase === 'ready' && technicianMarker) {
                        focusTechnician();
                    }
                }
                break;
            case 'focusTechnician':
                followEnabled = true;
                focusTechnician();
                break;
            case 'fitBounds':
                fitBounds();
                break;
            case 'clearPosition':
                clearPosition();
                break;
            case 'status':
                receiveRouteState(data);
                updateRoute(routeState);
                if (typeof data.text === 'string') {
                    setStatus(data.text.slice(0, 300), false);
                }
                break;
            default:
                break;
        }
    }

    function dispose() {
        if (phase === 'disposed') {
            return;
        }
        phase = 'disposed';
        if (routeService) {
            routeService.dispose();
            routeService = undefined;
        }
        clearLoadTimer();
        clearReadyTimer();
        document.removeEventListener('DOMContentLoaded', start);
        window.removeEventListener('message', onMessage);
        window.removeEventListener('pagehide', dispose);
        if (googleScript) {
            googleScript.onerror = null;
            googleScript.remove();
        }
        // Late Google callbacks remain harmless after the frame is disposed.
        window.initTechnicianLiveMap = function () {};
        window.gm_authFailure = function () {};
        clearPosition();
        if (customerMarker) {
            customerMarker.map = null;
        }
        if (map && window.google && window.google.maps.event) {
            window.google.maps.event.clearInstanceListeners(map);
        }
        map = undefined;
    }

    function isAllowedParentOrigin(origin) {
        const frameUrl = new URL(window.location.href);
        if (frameUrl.protocol !== 'https:' || frameUrl.port) return false;

        // A public Sites renderer can be embedded only by pages on that exact site origin.
        // Matching a Salesforce domain suffix does not trust other customers' parent pages.
        if (frameUrl.hostname.endsWith('.my.site.com') ||
            frameUrl.hostname.endsWith('.my.salesforce-sites.com')) {
            return origin === frameUrl.origin;
        }

        // This unmanaged Visualforce page trusts only its own org's Lightning origin.
        const visualforceHost = /^([a-z0-9-]+)--c(\.(?:develop|sandbox))?\.vf\.force\.com$/i.exec(frameUrl.hostname);
        if (!visualforceHost) return false;
        const lightningOrigin = 'https://' + visualforceHost[1] +
            (visualforceHost[2] || '') + '.lightning.force.com';
        return origin === lightningOrigin;
    }

    function start() {
        if (started || phase === 'disposed') {
            return;
        }
        started = true;
        mapElement = document.querySelector('[data-role="live-map"]');
        statusElement = document.querySelector('[data-role="live-map-status"]');
        try {
            const parsedOrigin = new URL(requestedOrigin);
            if (parsedOrigin.protocol !== 'https:' ||
                parsedOrigin.origin !== requestedOrigin ||
                parsedOrigin.port ||
                !isAllowedParentOrigin(parsedOrigin.origin) ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channel) ||
                window.parent === window) {
                throw new Error('Invalid map frame configuration');
            }
            if (document.referrer && new URL(document.referrer).origin !== parsedOrigin.origin) {
                throw new Error('The parent does not match the map referrer');
            }
            parentOrigin = parsedOrigin.origin;
        } catch (error) {
            fail('Open this map from the Salesforce technician tracking component.');
            return;
        }
        if (!mapElement) {
            fail('The map area is missing. Deploy the complete live tracking POC and reload the page.');
            return;
        }
        window.addEventListener('message', onMessage);
        announceFrameReady();
    }

    window.addEventListener('pagehide', dispose);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
}());
