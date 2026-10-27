import assert from 'node:assert/strict';
import test from 'node:test';

// Opt-in read-only smoke check for a public Aura Experience site, not an authenticated session.
// node --use-system-ca scripts/tests/technicianCustomerAccess.test.mjs https://SITE/LiveTracking/s/
// This sends only a fabricated customer token to getTracking. It creates no records and requests no GPS.
const suppliedUrl = process.argv[2];
const networkOptions = { skip: suppliedUrl ? false : 'Supply the public Experience site URL to check anonymous customer access.' };
const EXPECTED_REJECTION = 'This customer link is invalid, expired, or revoked.';

function extractBootstrap(html, pageUrl) {
    for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
        let url;
        try { url = new URL(match[1].replaceAll('&amp;', '&'), pageUrl); } catch { continue; }
        if (url.origin !== pageUrl.origin || url.protocol !== 'https:') continue;
        const asset = url.pathname.match(/^(.*\/sfsites)\/l\/([^/]+)\/(?:bootstrap|inline)\.js$/);
        if (!asset) continue;
        let configuration;
        try { configuration = JSON.parse(decodeURIComponent(asset[2])); } catch { continue; }
        if (configuration.app !== 'siteforce:communityApp' ||
            typeof configuration.mode !== 'string' || typeof configuration.fwuid !== 'string' ||
            !configuration.loaded || typeof configuration.loaded !== 'object') continue;
        return {
            endpoint: new URL(asset[1] + '/aura', pageUrl),
            context: {
                mode: configuration.mode,
                fwuid: configuration.fwuid,
                app: configuration.app,
                loaded: configuration.loaded,
                dn: [], globals: {}, uad: false
            }
        };
    }
    throw new Error('No supported Aura community bootstrap was found. This HTTP smoke check does not support LWR sites or login pages; verify those in a browser.');
}

function reachedCustomerValidation(value) {
    return value && Array.isArray(value.actions) && value.actions.length === 1 &&
        value.actions[0].state === 'ERROR' && Array.isArray(value.actions[0].error) &&
        value.actions[0].error.some(error => typeof error.message === 'string' && error.message.includes(EXPECTED_REJECTION));
}

async function request(url, options = {}) {
    try {
        return await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch {
        throw new Error('The anonymous site request failed. Check network access, TLS, and that the supplied public site URL needs no redirect.');
    }
}

let pagePromise;
function loadSite() {
    if (!pagePromise) pagePromise = (async () => {
        let pageUrl;
        try { pageUrl = new URL(suppliedUrl); }
        catch { throw new Error('Supply the full public HTTPS Experience site URL ending in /s/.'); }
        assert.ok(pageUrl.protocol === 'https:' && !pageUrl.username && !pageUrl.password &&
            !pageUrl.search && !pageUrl.hash && pageUrl.pathname.endsWith('/s/'),
        'Use a public HTTPS Experience site URL ending in /s/, without credentials, query parameters, or a customer fragment.');
        const response = await request(pageUrl);
        assert.equal(response.status, 200, 'The Experience site must be accessible without signing in.');
        assert.ok((response.headers.get('content-type') || '').toLowerCase().startsWith('text/html'),
            'The Experience site must return its HTML bootstrap.');
        const bootstrap = extractBootstrap(await response.text(), pageUrl);
        const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        return { pageUrl, cookies, ...bootstrap };
    })();
    return pagePromise;
}

test('the customer smoke check accepts only application rejection and never a platform authorization error', () => {
    assert.equal(reachedCustomerValidation({ actions: [{ state: 'ERROR', error: [{ message: EXPECTED_REJECTION }] }] }), true);
    for (const value of [
        {}, { message: 'No apex action available' },
        { actions: [{ state: 'ERROR', error: [{ message: 'Access denied to Apex class.' }] }] },
        { actions: [{ state: 'ERROR', error: [{ message: 'Invalid CSRF token.' }] }] },
        { actions: [{ state: 'SUCCESS', returnValue: {} }] }
    ]) assert.ok(!reachedCustomerValidation(value));
});

test('bootstrap discovery follows the rendered same-origin site prefix without executing page scripts', () => {
    const site = new URL('https://example.my.site.com/Tracking/s/');
    const configuration = { mode: 'PROD', app: 'siteforce:communityApp', fwuid: 'test-framework-version',
        loaded: { 'APPLICATION@markup://siteforce:communityApp': 'test-app-version' } };
    const asset = '/Tracking/s/sfsites/l/' + encodeURIComponent(JSON.stringify(configuration)) + '/bootstrap.js';
    const parsed = extractBootstrap('<script src="' + asset + '"></script>', site);
    assert.equal(parsed.endpoint.href, 'https://example.my.site.com/Tracking/s/sfsites/aura');
    assert.equal(parsed.context.fwuid, configuration.fwuid);
    assert.throws(() => extractBootstrap('<script src="https://different.example' + asset + '"></script>', site), /No supported Aura/);
    assert.throws(() => extractBootstrap('<html>Login</html>', site), /does not support LWR sites or login pages/);
});

test('the public Experience site provides an anonymous Aura bootstrap', networkOptions, async () => {
    await loadSite();
});

test('the guest customer action reaches capability validation without class or platform authorization failures', networkOptions, async () => {
    const { pageUrl, cookies, context, endpoint } = await loadSite();
    assert.equal(endpoint.origin, pageUrl.origin, 'All smoke-check traffic must remain on the supplied site origin.');
    const message = { actions: [{
        id: '1;a', descriptor: 'aura://ApexActionController/ACTION$execute', callingDescriptor: 'UNKNOWN',
        params: {
            namespace: '', classname: 'TechnicianCustomerTrackingController', method: 'getTracking',
            params: { token: '0'.repeat(64) }, cacheable: false, isContinuation: false
        }
    }] };
    const body = new URLSearchParams({
        message: JSON.stringify(message), 'aura.context': JSON.stringify(context),
        'aura.pageURI': pageUrl.pathname, 'aura.token': 'null'
    });
    const headers = {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        origin: pageUrl.origin, referer: pageUrl.href
    };
    if (cookies) headers.cookie = cookies;
    const response = await request(endpoint, { method: 'POST', headers, body });
    assert.equal(response.status, 200, 'The anonymous Aura request must return its normal HTTP response.');
    let result;
    try { result = JSON.parse((await response.text()).trim().replace(/^while\(1\);/, '')); }
    catch {
        // Aura can append a platform-error comment to incomplete JSON. That must fail this smoke test.
        throw new Error('The Aura response was not complete JSON. Check deployment, guest Apex-class access, and the public site runtime. Response details were withheld.');
    }
    assert.ok(reachedCustomerValidation(result),
        'Expected the application invalid/expired/revoked customer-link rejection. Class access, CSRF, routing errors, or an unexpected successful response are not passing results; response details were withheld.');
});
