(function () {
    'use strict';

    const UPLOAD_INTERVAL_MS = 3000;
    const MAX_FIX_AGE_MS = 120000;
    const MAX_UPLOAD_FAILURES = 3;
    const SESSION_CHECK_TIMEOUT_MS = 22000;
    const DIRECTIONS_RETRY_MS = 10000;

    // Parameter names can change case during a Salesforce redirect. Record IDs must not.
    function readSessionId(value) {
        const input = typeof value === 'string' ? value.trim() : '';
        const validId = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
        if (validId.test(input)) {
            return input;
        }
        try {
            const url = new URL(input);
            if (url.protocol !== 'https:') {
                return null;
            }
            const candidates = [];
            url.searchParams.forEach(function (candidate, name) {
                if (name.toLowerCase() === 'sessionid') {
                    candidates.push(candidate.trim());
                }
            });
            if (candidates.length && candidates.every(function (candidate) {
                return validId.test(candidate) && candidate === candidates[0];
            })) {
                return candidates[0];
            }
        } catch (error) {
            // A partial link or arbitrary text is not a tracking-session ID.
        }
        return null;
    }

    function readInvitationToken(value) {
        const input = typeof value === 'string' ? value.trim() : '';
        const validToken = /^[a-fA-F0-9]{64}$/;
        if (validToken.test(input)) {
            return input.toLowerCase();
        }
        try {
            const url = new URL(input);
            if (url.protocol !== 'https:') return null;
            let queryInvitation = false;
            url.searchParams.forEach(function (candidate, name) {
                if (name.toLowerCase() === 'invite' || name.toLowerCase() === 'customer') queryInvitation = true;
            });
            if (queryInvitation) return null;
            const candidates = [];
            let customerLink = false;
            new URLSearchParams(url.hash.slice(1)).forEach(function (candidate, name) {
                if (name.toLowerCase() === 'invite') candidates.push(candidate.trim().toLowerCase());
                if (name.toLowerCase() === 'customer') customerLink = true;
            });
            if (customerLink) return null;
            if (candidates.length && candidates.every(function (candidate) {
                return validToken.test(candidate) && candidate === candidates[0];
            })) {
                return candidates[0];
            }
        } catch (error) {
            // Invitations are accepted only as a code or in an HTTPS link fragment.
        }
        return null;
    }

    function initialize() {
        const panel = document.querySelector('[data-phone-publisher]');
        if (!panel || panel.getAttribute('data-initialized') === 'true') {
            return;
        }
        panel.setAttribute('data-initialized', 'true');

        const find = function (name) {
            return panel.querySelector('[data-' + name + ']');
        };
        const startButton = find('start');
        const stopButton = find('stop');
        const status = find('status');
        const recovery = find('session-recovery');
        const sessionInput = find('session-input');
        const connectButton = find('connect');
        const connectForm = find('connect-form');
        const invitationMode = panel.getAttribute('data-publisher-mode') === 'invitation';
        let publisherCredential;
        const state = {
            validated: false,
            validating: false,
            validationTimer: null,
            sharing: false,
            ended: false,
            destroyed: false,
            stopRequested: false,
            stopInFlight: false,
            stopFailed: false,
            generation: 0,
            watchId: null,
            uploadTimer: null,
            expiryTimer: null,
            expiresAtMs: null,
            pending: null,
            lastFix: null,
            inFlight: false,
            lastSendAt: null,
            nextAttemptAt: 0,
            failures: 0
        };
        let phoneMap = null;
        let directionsTimer = null;
        let directionsTimeout = null;
        let directionsInFlight = false;
        let directionsEpoch = 0;
        let directionsReady = false;
        if (window.TechnicianPhoneMap && typeof window.TechnicianPhoneMap.create === 'function') {
            try { phoneMap = window.TechnicianPhoneMap.create(panel); } catch (error) {
                text(find('phone-map-status'), 'The phone map could not start. GPS sharing is still available.');
            }
        }

        function text(element, value) {
            if (element) {
                element.textContent = value;
            }
        }

        function message(value) {
            text(status, value);
        }

        function mapAction(name, value) {
            if (!phoneMap) return undefined;
            try { return phoneMap[name](value); } catch (error) {
                text(find('phone-map-status'), 'The phone map is unavailable. GPS sharing can continue.');
                return undefined;
            }
        }

        function stopDirections() {
            directionsEpoch += 1;
            directionsInFlight = false;
            directionsReady = false;
            window.clearTimeout(directionsTimer);
            window.clearTimeout(directionsTimeout);
            directionsTimer = null;
            directionsTimeout = null;
            mapAction('pause', 'Location sharing is paused. Start sharing for a current route and ETA.');
        }

        function publishPhonePosition() {
            if (!phoneMap || !state.sharing || !state.lastFix) return;
            mapAction('update', {
                position: { lat: state.lastFix.latitude, lng: state.lastFix.longitude },
                sampledAt: state.lastFix.capturedAtMs,
                receivedAtMs: Date.now(),
                active: true,
                stale: Date.now() - state.lastFix.capturedAtMs > 15000
            });
        }

        function requestDirections() {
            if (!phoneMap || !state.validated || state.ended || state.destroyed ||
                state.stopRequested || state.stopFailed || directionsInFlight || directionsReady) return;
            if (state.expiresAtMs <= Date.now()) { endLocally(endedMessage(true)); return; }
            window.clearTimeout(directionsTimer);
            directionsTimer = null;
            directionsInFlight = true;
            const epoch = directionsEpoch;
            let settled = false;
            function finish() {
                if (settled || epoch !== directionsEpoch || state.destroyed) return false;
                settled = true;
                directionsInFlight = false;
                window.clearTimeout(directionsTimeout);
                directionsTimeout = null;
                return true;
            }
            function retry() {
                if (state.ended || state.destroyed || state.stopRequested || epoch !== directionsEpoch) return;
                directionsTimer = window.setTimeout(requestDirections, DIRECTIONS_RETRY_MS);
            }
            directionsTimeout = window.setTimeout(function () {
                if (finish()) {
                    text(find('phone-map-status'), 'The route setup did not respond. Retrying; GPS sharing can continue.');
                    retry();
                }
            }, SESSION_CHECK_TIMEOUT_MS);
            remote('directions', [publisherCredential], function (config) {
                if (!finish()) return;
                if (!applySession(config)) return;
                if (typeof config.browserMapsKey !== 'string' || !config.browserMapsKey.trim()) {
                    text(find('phone-map-status'), 'Waiting for the session owner to load the map. You can start sharing GPS now.');
                    retry();
                    return;
                }
                directionsReady = true;
                // The adapter handles map-loading errors separately from GPS sharing.
                Promise.resolve(mapAction('configure', config)).then(function () {
                    if (epoch === directionsEpoch && !state.destroyed && !state.ended) publishPhonePosition();
                }).catch(function () {
                    if (epoch === directionsEpoch && !state.destroyed) {
                        text(find('phone-map-status'), 'The phone map could not load. Ask the session owner to check Maps setup, then refresh. GPS sharing can continue.');
                    }
                });
            }, function (event) {
                if (!finish()) return;
                if (invitationMode && event && typeof event.message === 'string' &&
                    event.message.includes('This phone link is invalid, expired, or revoked.')) {
                    endLocally(endedMessage(false));
                    return;
                }
                text(find('phone-map-status'), 'The route setup could not be checked. Retrying; GPS sharing can continue.');
                retry();
            });
        }

        function endedMessage(expired) {
            if (invitationMode) {
                return expired
                    ? 'This invitation has expired. Ask the person watching the map for a new phone link.'
                    : 'This invitation is no longer active. Ask the person watching the map for a new phone link.';
            }
            return expired
                ? 'This tracking session has expired. Create a new phone link on your laptop.'
                : 'This tracking session has ended. Create a new phone link on your laptop.';
        }

        function buttons() {
            if (startButton) {
                startButton.disabled = !state.validated || state.sharing ||
                    state.ended || state.stopRequested || state.stopFailed || state.destroyed;
            }
            if (stopButton) {
                stopButton.disabled = !state.validated || state.ended ||
                    state.stopRequested || state.destroyed;
            }
            if (connectButton) {
                connectButton.disabled = state.validating || state.validated || state.destroyed;
            }
            if (sessionInput) {
                sessionInput.disabled = state.validating || state.validated || state.destroyed;
            }
        }

        function showRecovery(value) {
            if (recovery) {
                recovery.hidden = false;
            }
            message(value);
            buttons();
        }

        function clearValidationTimer() {
            if (state.validationTimer !== null) {
                window.clearTimeout(state.validationTimer);
                state.validationTimer = null;
            }
        }

        function validateSession(value) {
            if (state.validated || state.validating || state.destroyed) {
                return;
            }
            if (window.location.protocol !== 'https:' || window.isSecureContext === false) {
                message('Phone GPS requires HTTPS. Open the secure Salesforce phone link from your laptop.');
                return;
            }
            if (window.self !== window.top) {
                message('Open this phone link directly in your phone browser to share GPS.');
                return;
            }
            const candidate = invitationMode ? readInvitationToken(value) : readSessionId(value);
            if (!candidate) {
                showRecovery(invitationMode
                    ? 'This invitation link is incomplete or invalid. Ask the person watching the map for the complete phone invitation link, paste it below, and tap Connect invitation.'
                    : 'The tracking session is missing from this link or is invalid. Copy the complete phone link or tracking session code from your laptop, paste it below, and tap Connect session.');
                return;
            }
            publisherCredential = candidate;
            state.ended = false;
            state.validating = true;
            text(find('session-code'), 'Not connected');
            buttons();
            message(invitationMode ? 'Checking your phone invitation...' : 'Checking your Salesforce tracking session...');

            // A timed-out request must not enable Start later, including after a retry.
            let settled = false;
            function finish() {
                if (settled || state.destroyed) {
                    return false;
                }
                settled = true;
                clearValidationTimer();
                state.validating = false;
                buttons();
                return true;
            }
            state.validationTimer = window.setTimeout(function () {
                if (finish()) {
                    showRecovery(invitationMode
                        ? 'Salesforce did not respond. Check your connection, then paste the invitation link below and tap Connect invitation to retry.'
                        : 'Salesforce did not respond. Check your connection, then paste the phone link or tracking code below and tap Connect session to retry.');
                }
            }, SESSION_CHECK_TIMEOUT_MS);
            remote('get', [publisherCredential], function (snapshot) {
                if (!finish()) {
                    return;
                }
                if (!applySession(snapshot)) {
                    if (recovery) recovery.hidden = false;
                    return;
                }
                state.validated = true;
                if (invitationMode && sessionInput) sessionInput.value = '';
                if (!invitationMode) text(find('session-code'), snapshot.sessionId || publisherCredential);
                if (recovery) recovery.hidden = true;
                buttons();
                message(invitationMode
                    ? 'Invitation connected. Tap Start sharing and allow location access to send your phone GPS to the map.'
                    : 'Ready. Tap Start sharing and allow location access to send your phone GPS to the laptop.');
                requestDirections();
            }, function () {
                if (finish()) {
                    showRecovery(invitationMode
                        ? 'This invitation could not be opened. Check your connection or ask the person watching the map for a new phone link.'
                        : 'This tracking session could not be opened. Sign in as the same Salesforce user as your laptop, then paste the current phone link or tracking code below and tap Connect session.');
                }
            });
        }

        function cancelUploadTimer() {
            if (state.uploadTimer !== null) {
                window.clearTimeout(state.uploadTimer);
                state.uploadTimer = null;
            }
        }

        function stopGps() {
            state.generation += 1;
            state.sharing = false;
            state.pending = null;
            cancelUploadTimer();
            stopDirections();
            if (state.watchId !== null && navigator.geolocation) {
                navigator.geolocation.clearWatch(state.watchId);
                state.watchId = null;
            }
            buttons();
        }

        function endLocally(value) {
            state.ended = true;
            stopGps();
            if (state.validated) mapAction('dispose');
            if (state.expiryTimer !== null) {
                window.clearTimeout(state.expiryTimer);
                state.expiryTimer = null;
            }
            message(value);
        }

        function applySession(snapshot) {
            if (!snapshot || snapshot.active !== true || snapshot.expired === true) {
                endLocally(endedMessage(snapshot && snapshot.expired));
                return false;
            }
            const expiresAtMs = Number(snapshot.expiresAtMs);
            if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
                endLocally(endedMessage(true));
                return false;
            }
            state.expiresAtMs = expiresAtMs;
            if (state.expiryTimer !== null) {
                window.clearTimeout(state.expiryTimer);
            }
            state.expiryTimer = window.setTimeout(function () {
                endLocally(endedMessage(true));
            }, Math.min(expiresAtMs - Date.now(), 2147483647));
            text(find('expires'), new Date(expiresAtMs).toLocaleString());
            return true;
        }

        function remote(actionName, args, success, failure) {
            const action = panel.getAttribute('data-action-' + actionName);
            const manager = window.Visualforce && window.Visualforce.remoting &&
                window.Visualforce.remoting.Manager;
            if (!action || !manager || typeof manager.invokeAction !== 'function') {
                failure();
                return;
            }
            try {
                manager.invokeAction.apply(manager, [action].concat(args, [
                    function (result, event) {
                        if (state.destroyed) {
                            return;
                        }
                        if (event && event.status === true) {
                            success(result);
                        } else {
                            failure(event);
                        }
                    },
                    { escape: true, timeout: 20000 }
                ]));
            } catch (error) {
                failure();
            }
        }

        function isFresh(fix) {
            return fix && fix.capturedAtMs >= Date.now() - MAX_FIX_AGE_MS &&
                fix.capturedAtMs <= Date.now() + 30000;
        }

        function finishStop() {
            if (!state.stopRequested || state.inFlight || state.stopInFlight || state.destroyed) {
                return;
            }
            state.stopInFlight = true;
            remote('stop', [publisherCredential], function (snapshot) {
                state.stopInFlight = false;
                state.stopRequested = false;
                state.stopFailed = false;
                if (snapshot && snapshot.active === true) {
                    stopFailed();
                    return;
                }
                endLocally(invitationMode
                    ? 'Sharing stopped. This phone invitation is no longer active.'
                    : 'Sharing stopped. The Salesforce tracking session has ended.');
            }, stopFailed);
        }

        function stopFailed() {
            state.stopInFlight = false;
            state.stopRequested = false;
            state.stopFailed = true;
            buttons();
            message(invitationMode
                ? 'Phone GPS is stopped, but Salesforce could not confirm that the invitation ended. Tap Stop sharing to retry.'
                : 'Phone GPS is stopped, but Salesforce could not confirm that the session ended. Tap Stop sharing to retry.');
        }

        function scheduleUpload() {
            cancelUploadTimer();
            if (!state.sharing || state.destroyed || state.stopRequested || state.inFlight || !state.pending) {
                return;
            }
            if (!isFresh(state.pending)) {
                state.pending = null;
                message('Waiting for a fresh GPS position. Keep this page open.');
                return;
            }
            if (navigator.onLine === false) {
                message('Your phone is offline. The latest fresh GPS position will be sent when the connection returns.');
                return;
            }
            const throttleUntil = state.lastSendAt === null ? 0 : state.lastSendAt + UPLOAD_INTERVAL_MS;
            const delay = Math.max(0, throttleUntil - Date.now(), state.nextAttemptAt - Date.now());
            if (delay > 0) {
                state.uploadTimer = window.setTimeout(function () {
                    state.uploadTimer = null;
                    scheduleUpload();
                }, delay);
                return;
            }
            const fix = state.pending;
            const generation = state.generation;
            state.pending = null;
            state.inFlight = true;
            state.lastSendAt = Date.now();

            function settled() {
                state.inFlight = false;
                if (state.stopRequested) {
                    finishStop();
                    return false;
                }
                if (!state.sharing || generation !== state.generation) {
                    scheduleUpload();
                    return false;
                }
                return true;
            }

            remote('publish', [
                publisherCredential, fix.latitude, fix.longitude, fix.accuracy, fix.capturedAtMs
            ], function (snapshot) {
                if (!settled() || !applySession(snapshot)) {
                    return;
                }
                state.failures = 0;
                state.nextAttemptAt = 0;
                const receivedAtMs = Number(snapshot.receivedAtMs);
                text(find('sent'), new Date(Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now()).toLocaleTimeString());
                message(invitationMode
                    ? 'Sharing live GPS with the map. Keep this page open and the phone screen awake.'
                    : 'Sharing live GPS with your laptop. Keep this page open and the phone screen awake.');
                scheduleUpload();
            }, function (event) {
                if (!settled()) {
                    return;
                }
                if (invitationMode && event && typeof event.message === 'string' &&
                    event.message.includes('This phone link is invalid, expired, or revoked.')) {
                    endLocally(endedMessage(false));
                    return;
                }
                state.failures += 1;
                if (state.failures >= MAX_UPLOAD_FAILURES) {
                    stopGps();
                    message(invitationMode
                        ? 'GPS sharing paused after three failed uploads. Check your connection or ask the person watching the map for a new phone invitation.'
                        : 'GPS sharing paused after three failed uploads. Check your connection and Salesforce sign-in, then tap Start sharing to retry.');
                    return;
                }
                if (!state.pending && isFresh(fix)) {
                    state.pending = fix;
                }
                state.nextAttemptAt = Date.now() + UPLOAD_INTERVAL_MS * Math.pow(2, state.failures - 1);
                message('Salesforce could not save the latest position. Retrying while this page stays open.');
                scheduleUpload();
            });
        }

        function positionReceived(position, generation) {
            if (!state.sharing || state.destroyed || generation !== state.generation || !position || !position.coords) {
                return;
            }
            const latitude = position.coords.latitude;
            const longitude = position.coords.longitude;
            const accuracy = position.coords.accuracy;
            const capturedAtMs = position.timestamp;
            if (![latitude, longitude, accuracy, capturedAtMs].every(Number.isFinite) ||
                latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || accuracy < 0) {
                message('The phone returned an invalid GPS position. Waiting for a fresh position.');
                return;
            }
            const fix = { latitude: latitude, longitude: longitude, accuracy: accuracy, capturedAtMs: capturedAtMs };
            if (!isFresh(fix)) {
                message('The phone returned an old GPS position. Waiting for a fresh position.');
                return;
            }
            if (state.lastFix && state.lastFix.capturedAtMs >= capturedAtMs) {
                return;
            }
            state.lastFix = fix;
            state.pending = fix;
            text(find('coordinates'), latitude.toFixed(6) + ', ' + longitude.toFixed(6));
            text(find('accuracy'), Math.round(accuracy) + ' metres');
            text(find('captured'), new Date(capturedAtMs).toLocaleTimeString());
            publishPhonePosition();
            scheduleUpload();
        }

        function positionFailed(error, generation) {
            if (!state.sharing || state.destroyed || generation !== state.generation) {
                return;
            }
            if (error && error.code === 1) {
                stopGps();
                message('Location permission was denied. Allow location for this site in your browser and phone settings, then tap Start sharing.');
            } else if (error && error.code === 2) {
                message('GPS is unavailable. Turn on phone location services and move somewhere with a clearer signal.');
            } else {
                message('Waiting for GPS took too long. Keep location services enabled; the phone will continue trying.');
            }
        }

        function startSharing() {
            if (!state.validated || state.sharing || state.ended || state.destroyed || state.stopRequested || state.stopFailed) {
                return;
            }
            if (state.expiresAtMs <= Date.now()) {
                endLocally(endedMessage(true));
                return;
            }
            if (!navigator.geolocation) {
                message('This browser does not support phone GPS. Open this link in Safari or Chrome on your phone.');
                return;
            }
            state.generation += 1;
            const generation = state.generation;
            state.sharing = true;
            state.failures = 0;
            state.nextAttemptAt = 0;
            state.lastFix = null;
            requestDirections();
            buttons();
            message('Waiting for phone GPS. Allow location access when your browser asks.');
            try {
                const watchId = navigator.geolocation.watchPosition(function (position) {
                    positionReceived(position, generation);
                }, function (error) {
                    positionFailed(error, generation);
                }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
                if (state.sharing && generation === state.generation) {
                    state.watchId = watchId;
                } else {
                    navigator.geolocation.clearWatch(watchId);
                }
            } catch (error) {
                stopGps();
                message('The browser could not start GPS. Check location permission and open this link directly in your phone browser.');
            }
        }

        function stopSharing() {
            if (!state.validated || state.ended || state.destroyed || state.stopRequested) {
                return;
            }
            state.stopRequested = true;
            stopGps();
            mapAction('dispose');
            message(invitationMode
                ? 'GPS is stopped. Ending this phone invitation...'
                : 'GPS is stopped. Ending the Salesforce tracking session...');
            finishStop();
        }

        if (startButton) {
            startButton.addEventListener('click', startSharing);
        }
        if (stopButton) {
            stopButton.addEventListener('click', stopSharing);
        }
        if (connectForm) {
            connectForm.addEventListener('submit', function (event) {
                event.preventDefault();
                validateSession(sessionInput ? sessionInput.value : '');
            });
        }
        window.addEventListener('online', function () {
            if (state.sharing && !state.destroyed) {
                scheduleUpload();
            }
        });
        window.addEventListener('pagehide', function () {
            state.destroyed = true;
            clearValidationTimer();
            stopGps();
            mapAction('dispose');
            if (state.expiryTimer !== null) {
                window.clearTimeout(state.expiryTimer);
                state.expiryTimer = null;
            }
            message(invitationMode
                ? 'This phone stopped sending GPS. The invitation may still be active.'
                : 'This phone stopped sending GPS. The Salesforce session may still be active.');
        });
        window.addEventListener('pageshow', function (event) {
            if (event.persisted) {
                window.location.reload();
            }
        });
        buttons();

        validateSession(window.location.href);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
}());
