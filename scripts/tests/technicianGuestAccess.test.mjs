import test from 'node:test';
import assert from 'node:assert/strict';

// Opt-in, read-only deployment check; no Salesforce login or local CLI credentials are used.
// node --use-system-ca scripts/tests/technicianGuestAccess.test.mjs <public-HTTPS-page-URL>
// Only getPublisherStatus is invoked, with a fabricated token that was never issued.
const suppliedUrl = process.argv[2];
const networkOptions = { skip: suppliedUrl ? false : 'Supply a public TechnicianGpsInvite URL to check the deployed site.' };
const policies = new Set([
    'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin',
    'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'
]);

function decodeAttribute(value) {
    return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
        const names = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
        const lower = entity.toLowerCase();
        if (names[lower]) return names[lower];
        const numeric = lower.startsWith('&#x')
            ? Number.parseInt(lower.slice(3, -1), 16) : Number.parseInt(lower.slice(2, -1), 10);
        return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
            ? String.fromCodePoint(numeric) : entity;
    });
}

function attributes(tag) {
    const values = new Map();
    for (const match of tag.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        values.set(match[1].toLowerCase(), decodeAttribute(match[2] ?? match[3] ?? match[4] ?? ''));
    }
    return values;
}

function effectivePolicy(header, html) {
    let policy = 'strict-origin-when-cross-origin';
    for (const candidate of (header || '').split(',')) {
        const value = candidate.trim().toLowerCase();
        if (policies.has(value)) policy = value;
    }
    // Browsers apply valid document meta policies after the response-header policy.
    for (const match of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<meta\b[^>]*>/gi)) {
        const values = attributes(match[0]);
        if ((values.get('name') || '').toLowerCase() !== 'referrer') continue;
        const value = (values.get('content') || '').trim().toLowerCase();
        if (policies.has(value)) policy = value;
    }
    return policy;
}

function sameOriginReferer(policy, pageUrl) {
    if (policy === 'no-referrer') return undefined;
    if (policy === 'origin' || policy === 'strict-origin') return pageUrl.origin + '/';
    // All requests in this test are HTTPS and same-origin; fragments are always excluded.
    return pageUrl.origin + pageUrl.pathname + pageUrl.search;
}

function sameOriginUrl(value, base, label) {
    let url;
    try { url = new URL(value, base); } catch { throw new Error(label + ' URL is invalid.'); }
    assert.ok(url.protocol === 'https:' && url.origin === base.origin && !url.username && !url.password,
        label + ' must stay on the supplied HTTPS site origin.');
    url.hash = '';
    return url;
}

async function request(url, label, options = {}) {
    try {
        return await fetch(url, {
            ...options, redirect: 'error', signal: AbortSignal.timeout(20000)
        });
    } catch {
        // Do not expose response bodies, request headers, cookies, or provider tokens in failures.
        throw new Error(label + ' request failed. Check network access, TLS, and that this exact URL needs no redirect.');
    }
}

let pagePromise;
function loadPage() {
    if (!pagePromise) pagePromise = (async () => {
        let pageUrl;
        try { pageUrl = new URL(suppliedUrl); }
        catch { throw new Error('Supply a complete public HTTPS TechnicianGpsInvite page URL.'); }
        assert.ok(pageUrl.protocol === 'https:' && !pageUrl.username && !pageUrl.password &&
            !pageUrl.search && !pageUrl.hash && pageUrl.pathname.endsWith('/TechnicianGpsInvite'),
        'Use the public HTTPS TechnicianGpsInvite page URL without credentials, a query, or an invitation fragment.');
        const page = await request(pageUrl, 'Public page');
        assert.equal(page.status, 200, 'The public invitation page must return HTTP 200 without signing in.');
        const html = await page.text();
        const panel = [...html.matchAll(/<main\b[^>]*>/gi)]
            .map(match => attributes(match[0]))
            .find(values => values.has('data-phone-publisher'));
        assert.ok(panel && panel.get('data-publisher-mode') === 'invitation',
            'The response must be the invitation publisher page, not login or error HTML.');
        const cookie = page.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        const policy = effectivePolicy(page.headers.get('referrer-policy'), html);
        const referer = sameOriginReferer(policy, pageUrl);
        const headers = {};
        if (cookie) headers.cookie = cookie;
        if (referer) headers.referer = referer;
        return { pageUrl, html, panel, headers };
    })();
    return pagePromise;
}

function remotingConfiguration(html, fullAction) {
    const methodName = 'getPublisherStatus';
    assert.ok(typeof fullAction === 'string' && fullAction.endsWith('.' + methodName),
        'The invitation page must register the read-only getPublisherStatus action.');
    const controller = fullAction.slice(0, -(methodName.length + 1));
    for (const match of html.matchAll(/RemotingProviderImpl\(\s*(\{[^\r\n]+\})\s*\)\s*\);/g)) {
        let provider;
        try { provider = JSON.parse(match[1]); } catch { continue; }
        const action = provider.actions?.[controller]?.ms?.find(method => method.name === methodName);
        if (action && typeof provider.service === 'string' && provider.vf?.vid) {
            return { provider, action, controller, methodName };
        }
    }
    throw new Error('The rendered page did not register the expected Visualforce remoting provider.');
}

test('referrer checks follow the effective page policy rather than silently adding a missing Referer', () => {
    const url = new URL('https://example.my.site.com/LiveTracking/apex/TechnicianGpsInvite');
    const blocked = effectivePolicy('strict-origin-when-cross-origin', '<meta name="referrer" content="no-referrer" />');
    assert.equal(sameOriginReferer(blocked, url), undefined);
    const allowed = effectivePolicy('no-referrer', '<meta name="referrer" content="same-origin" />');
    assert.equal(sameOriginReferer(allowed, url), url.href);
    assert.equal(sameOriginReferer(effectivePolicy('strict-origin', ''), url), url.origin + '/');
    assert.equal(sameOriginReferer(effectivePolicy(null, ''), url), url.href);
});

test('signed-out access returns the actual public invitation page', networkOptions, async () => {
    await loadPage();
});

test('the exact generated GPS publisher resource is accessible anonymously as JavaScript', networkOptions, async () => {
    const { pageUrl, html, headers } = await loadPage();
    const resourceSources = [...html.matchAll(/<script\b[^>]*>/gi)]
        .map(match => attributes(match[0]).get('src'))
        .filter(value => value && /(?:^|\/)TechnicianGpsPublisherScript(?:[/?#]|$)/.test(value));
    assert.equal(resourceSources.length, 1, 'Expected exactly one generated GPS publisher script URL.');
    const resourceUrl = sameOriginUrl(resourceSources[0], pageUrl, 'Publisher resource');
    const response = await request(resourceUrl, 'Publisher resource', { headers });
    assert.equal(response.status, 200, 'The publisher resource must be available to signed-out guests.');
    assert.ok(/^(?:application|text)\/(?:javascript|ecmascript)(?:;|$)/i.test(response.headers.get('content-type') || ''),
        'The resource must have a JavaScript MIME type, not an HTML login or error response.');
    const script = await response.text();
    assert.ok(script.includes('data-phone-publisher') && script.includes('readInvitationToken'),
        'The resource must contain the invitation-capable GPS publisher script.');
});

test('anonymous remoting reaches invitation validation instead of failing platform authorization', networkOptions, async () => {
    const { pageUrl, html, panel, headers } = await loadPage();
    const { provider, action, controller, methodName } = remotingConfiguration(html, panel.get('data-action-get'));
    const endpoint = sameOriginUrl(provider.service, new URL(pageUrl.origin + '/'), 'Remoting endpoint');
    const payload = [{
        action: controller, method: methodName, data: ['0'.repeat(64)], type: 'rpc', tid: 1,
        ctx: {
            csrf: action.csrf, vid: provider.vf.vid, ns: action.ns,
            ver: action.ver, authorization: action.authorization
        }
    }];
    const response = await request(endpoint, 'Read-only invitation validation', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', origin: pageUrl.origin },
        body: JSON.stringify(payload)
    });
    assert.equal(response.status, 200, 'Visualforce remoting must return its normal HTTP response.');
    let body;
    try { body = await response.json(); }
    catch { throw new Error('Visualforce remoting did not return JSON. The response body was withheld.'); }
    const events = Array.isArray(body) ? body : [body];
    assert.ok(events.length === 1 && events[0]?.type === 'exception' &&
        typeof events[0].message === 'string' &&
        events[0].message.includes('This phone link is invalid, expired, or revoked.'),
    'The fabricated invitation must reach application validation. A referrer, CSRF, permission, or routing failure is not a passing result; response details were withheld.');
});
