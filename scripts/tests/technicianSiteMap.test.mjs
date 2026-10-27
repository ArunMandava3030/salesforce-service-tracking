import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Opt-in anonymous GET checks. No API keys, cookies, GPS, Apex or CLI credentials.
// node --use-system-ca scripts/tests/technicianSiteMap.test.mjs <public-HTTPS-map-page-URL>
const suppliedUrl = process.argv[2];
const networkOptions = { skip: suppliedUrl ? false : 'Supply the public TechnicianLiveMap URL to check the deployed site.' };
const localScript = readFileSync(new URL('../../force-app/main/default/staticresources/TechnicianLiveMapScript.js', import.meta.url), 'utf8');
const CHANNEL = '77777777-7777-4777-8777-777777777777';

function attributes(tag) {
    const values = new Map();
    for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
        const value = (match[2] ?? match[3] ?? match[4]).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
        values.set(match[1].toLowerCase(), value);
    }
    return values;
}

function cspPolicies(header) {
    return (header || '').split(',').filter(value => value.trim()).map(policy => {
        const directives = new Map();
        for (const directive of policy.split(';')) {
            const [name, ...sources] = directive.trim().split(/\s+/);
            if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
        }
        return directives;
    });
}

function allowsSameOrigin(sources, origin) {
    return !sources || (!sources.includes("'none'") && sources.some(source =>
        source === "'self'" || source === '*' || source === 'https:' || source === origin || source === origin + '/'));
}

function assertMapFraming(headers, origin) {
    assert.ok(!/\bDENY\b/i.test(headers.get('x-frame-options') || ''),
        'The map response must not deny framing with X-Frame-Options.');
    for (const policy of cspPolicies(headers.get('content-security-policy'))) {
        assert.ok(allowsSameOrigin(policy.get('frame-ancestors'), origin),
            'Every enforced map frame-ancestors policy must permit its same-origin Experience parent.');
    }
}

function assertParentFraming(headers, html, origin) {
    const enforced = [headers.get('content-security-policy') || ''];
    for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
        const values = attributes(match[0]);
        if ((values.get('http-equiv') || '').toLowerCase() === 'content-security-policy') {
            enforced.push(values.get('content') || '');
        }
    }
    for (const policy of enforced.flatMap(cspPolicies)) {
        const sources = policy.get('frame-src') ?? policy.get('child-src') ?? policy.get('default-src');
        assert.ok(allowsSameOrigin(sources, origin),
            'Every enforced Experience frame-src policy (or its fallback) must allow the same-origin map.');
    }
}

async function request(url, label) {
    try {
        return await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000) });
    } catch {
        throw new Error(label + ' request failed. Check TLS, network access, and whether the exact public URL redirects.');
    }
}

let pagePromise;
function loadPage() {
    if (!pagePromise) pagePromise = (async () => {
        let pageUrl;
        try { pageUrl = new URL(suppliedUrl); }
        catch { throw new Error('Supply the complete public HTTPS TechnicianLiveMap page URL.'); }
        assert.ok(pageUrl.protocol === 'https:' && !pageUrl.username && !pageUrl.password &&
            !pageUrl.port && !pageUrl.search && !pageUrl.hash &&
            (pageUrl.hostname.endsWith('.my.site.com') || pageUrl.hostname.endsWith('.my.salesforce-sites.com')) &&
            pageUrl.pathname.endsWith('/apex/TechnicianLiveMap'),
        'Use the public Salesforce Sites HTTPS /apex/TechnicianLiveMap URL without credentials, query or fragment.');
        const response = await request(pageUrl, 'Public map page');
        assert.equal(response.status, 200, 'The map page must return HTTP 200 without login or redirects.');
        const html = await response.text();
        assert.match(html, /data-role\s*=\s*["']live-map["']/,
            'The response must contain the map renderer, not login or error HTML.');
        assertMapFraming(response.headers, pageUrl.origin);
        const parentUrl = new URL(pageUrl);
        parentUrl.pathname = pageUrl.pathname.slice(0, -'/apex/TechnicianLiveMap'.length) + '/s/';
        return { pageUrl, parentUrl, html };
    })();
    return pagePromise;
}

function probeHandshake(script, pageUrl, topLevel = false) {
    const messages = [];
    const resources = [];
    const timers = new Map();
    const listeners = new Map();
    const frameUrl = new URL(pageUrl);
    frameUrl.searchParams.set('parentOrigin', pageUrl.origin);
    frameUrl.searchParams.set('channel', CHANNEL);
    const window = {
        location: { href: frameUrl.href, origin: frameUrl.origin, search: frameUrl.search },
        addEventListener(type, callback) { listeners.set(type, callback); },
        removeEventListener(type) { listeners.delete(type); },
        setTimeout(callback, duration) { const id = timers.size + 1; timers.set(id, { callback, duration }); return id; },
        clearTimeout(id) { timers.delete(id); },
        postMessage(data, origin) { messages.push({ data, origin }); }
    };
    window.parent = topLevel ? window : { postMessage: window.postMessage };
    const status = { textContent: '', setAttribute() {} };
    const document = {
        readyState: 'complete', referrer: topLevel ? '' : pageUrl.origin + '/',
        querySelector(selector) { return selector.includes('live-map-status') ? status : {}; },
        head: { appendChild(scriptElement) { resources.push(scriptElement); } },
        createElement() { return {}; },
        addEventListener() {}, removeEventListener() {}
    };
    runInNewContext(script, { window, document, URL, URLSearchParams }, { timeout: 1000 });
    assert.equal(resources.length, 0, 'The renderer must not load Google Maps before explicit initialization.');
    if (topLevel) {
        assert.equal(messages.length, 0, 'A standalone page must not establish a parent handshake.');
        assert.equal(timers.size, 0);
    } else {
        assert.equal(messages.length, 1);
        assert.equal(messages[0].origin, pageUrl.origin, 'The ready message must target the exact site origin.');
        assert.equal(messages[0].data.type, 'frameReady');
        assert.equal(messages[0].data.scope, 'technician-live-tracking-poc');
        assert.equal(messages[0].data.channel, CHANNEL);
        assert.equal(messages[0].data.bridgeVersion, '2026-10-08.live2');
    }
}

test('framing checks reject restrictive map and parent policies, including multiple enforced policies', () => {
    const origin = 'https://example.my.site.com';
    assert.doesNotThrow(() => assertMapFraming(new Headers({
        'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'self'"
    }), origin));
    assert.throws(() => assertMapFraming(new Headers({ 'x-frame-options': 'DENY' }), origin));
    assert.throws(() => assertMapFraming(new Headers({
        'content-security-policy': "frame-ancestors 'self', frame-ancestors https://another.example"
    }), origin));
    assert.doesNotThrow(() => assertParentFraming(new Headers({ 'content-security-policy': "frame-src 'self'" }), '', origin));
    assert.throws(() => assertParentFraming(new Headers({ 'content-security-policy': "default-src 'none'" }), '', origin));
    assert.throws(() => assertParentFraming(new Headers(),
        '<meta http-equiv="Content-Security-Policy" content="frame-src https://another.example">', origin));
});

test('the local renderer announces readiness only inside its exact same-origin Sites parent', () => {
    const url = new URL('https://example.my.site.com/LiveTracking/apex/TechnicianLiveMap');
    probeHandshake(localScript, url);
    probeHandshake(localScript, url, true);
});

test('the deployed public map responds anonymously and permits same-origin framing', networkOptions, async () => {
    await loadPage();
});

test('the exact generated resource is public JavaScript and runs the expected same-origin handshake', networkOptions, async () => {
    const { pageUrl, html } = await loadPage();
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)]
        .map(match => attributes(match[0]).get('src'))
        .filter(value => value && /(?:^|\/)TechnicianLiveMapScript(?:[/?#]|$)/.test(value));
    assert.equal(scripts.length, 1, 'The map must include exactly one generated map resource URL.');
    const resourceUrl = new URL(scripts[0], pageUrl);
    assert.ok(resourceUrl.protocol === 'https:' && resourceUrl.origin === pageUrl.origin &&
        !resourceUrl.username && !resourceUrl.password && !resourceUrl.hash,
    'The generated map script must remain on the same HTTPS public site origin.');
    const response = await request(resourceUrl, 'Public map resource');
    assert.equal(response.status, 200, 'The exact URLFOR resource must return HTTP 200 anonymously.');
    assert.match(response.headers.get('content-type') || '', /^(?:application|text)\/(?:javascript|ecmascript)(?:;|$)/i,
        'The resource must return JavaScript rather than a login or error page.');
    const script = await response.text();
    const normalize = value => value.replace(/\r\n/g, '\n').trim();
    assert.ok(normalize(script) === normalize(localScript), 'The deployed map script differs from the current local source.');
    probeHandshake(script, pageUrl);
    probeHandshake(script, pageUrl, true);
});

test('the same-origin Experience page permits embedding the map through its enforced CSP', networkOptions, async () => {
    const { pageUrl, parentUrl } = await loadPage();
    const response = await request(parentUrl, 'Experience parent page');
    assert.equal(response.status, 200, 'The same-origin Experience /s/ page must return HTTP 200 without redirects.');
    const html = await response.text();
    assertParentFraming(response.headers, html, pageUrl.origin);
});
