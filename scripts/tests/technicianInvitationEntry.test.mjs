import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const entrySource = read('../../force-app/main/default/lwc/technicianInvitationEntry/technicianInvitationEntry.js');
const entryTemplate = read('../../force-app/main/default/lwc/technicianInvitationEntry/technicianInvitationEntry.html');
const rootSource = read('../../force-app/main/default/lwc/technicianTrackingPoc/technicianTrackingPoc.js');
const rootTemplate = read('../../force-app/main/default/lwc/technicianTrackingPoc/technicianTrackingPoc.html');
const importSource = (source) => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const invitation = await importSource(read('../../force-app/main/default/lwc/trackingInvitation/trackingInvitation.js'));
const token = 'abcdef0123456789'.repeat(4);
const guestPage = 'https://sample.my.site.com/LiveTracking/';

function componentClass(source, name, dependencies) {
    const executable = source
        .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*/gm, '')
        .replace(/@api\s+/g, '')
        .replace('export default class ' + name, 'class ' + name);
    const bindings = { LightningElement: class {}, ...dependencies };
    return new Function(...Object.keys(bindings), executable + '\nreturn ' + name + ';')(...Object.values(bindings));
}

function browser(href = guestPage) {
    const effects = { navigation: [], logs: [], storage: [], gps: [], listeners: [], removedListeners: [], timers: [] };
    const storage = {
        getItem(key) { effects.storage.push(['read', key]); return null; },
        setItem(key, value) { effects.storage.push(['write', key, value]); },
        removeItem(key) { effects.storage.push(['remove', key]); }
    };
    const window = {
        location: {
            href,
            origin: new URL(href).origin,
            assign(value) { effects.navigation.push(value); },
            replace(value) { effects.navigation.push(value); }
        },
        localStorage: storage,
        sessionStorage: storage,
        addEventListener(type, callback) { effects.listeners.push({ type, callback }); },
        removeEventListener(type, callback) { effects.removedListeners.push({ type, callback }); },
        clearInterval(id) { effects.timers.push(['clearInterval', id]); },
        clearTimeout(id) { effects.timers.push(['clearTimeout', id]); },
        setTimeout() { effects.timers.push(['setTimeout']); return 1; },
        setInterval() { effects.timers.push(['setInterval']); return 2; }
    };
    const navigator = {
        geolocation: {
            watchPosition() { effects.gps.push('watch'); },
            getCurrentPosition() { effects.gps.push('read'); }
        }
    };
    const console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((name) =>
        [name, (...args) => effects.logs.push(args)]));
    return { window, navigator, console, effects };
}

function entryHarness(href) {
    const environment = browser(href);
    const Entry = componentClass(entrySource, 'TechnicianInvitationEntry', { ...environment, ...invitation });
    const component = new Entry();
    component.connectedCallback();
    return { component, ...environment };
}

function rootHarness(isGuest, href) {
    const environment = browser(href);
    const Root = componentClass(rootSource, 'TechnicianTrackingPoc', {
        ...environment,
        ...invitation,
        IS_GUEST: isGuest
    });
    const component = new Root();
    return { component, ...environment };
}

test('a fragment invitation prefills the entry without starting GPS or navigating', () => {
    const href = guestPage + '#invite=' + token.toUpperCase();
    const h = entryHarness(href);
    assert.equal(h.component.invitationValue, href);
    assert.equal(h.component.invitationUrl, invitation.DEFAULT_PUBLISHER_PAGE_URL + '#invite=' + token);
    assert.equal(h.component.invalidInvitation, false);
    assert.deepEqual(h.effects.navigation, []);
    assert.deepEqual(h.effects.gps, []);
    assert.deepEqual(h.effects.storage, []);
    assert.deepEqual(h.effects.logs, []);
});

test('manual invitation entry uses the actual helper and exposes only a validated fragment link', () => {
    const h = entryHarness();
    assert.equal(h.component.invitationValue, '');
    assert.equal(h.component.invitationUrl, '');
    assert.equal(h.component.invalidInvitation, false);
    for (const value of [token, '  ' + token.toUpperCase() + '  ', guestPage + '#INVITE=' + token]) {
        h.component.handleInvitationChange({ target: { value } });
        assert.equal(h.component.invitationUrl, invitation.buildInvitationUrl(invitation.DEFAULT_PUBLISHER_PAGE_URL, token));
        assert.equal(new URL(h.component.invitationUrl).search, '');
        assert.equal(h.component.invalidInvitation, false);
    }
    assert.deepEqual(h.effects.navigation, []);
    assert.deepEqual(h.effects.gps, []);
    assert.deepEqual(h.effects.storage, []);
    assert.deepEqual(h.effects.logs, []);
});

test('session IDs, query capabilities, malformed tokens and conflicting links never expose a sharing link', () => {
    const h = entryHarness();
    for (const value of [
        'a01000000000001AAA',
        guestPage + '?sessionId=a01000000000001AAA',
        guestPage + '?invite=' + token,
        guestPage + '?INVITE=' + token + '#invite=' + token,
        guestPage + '#invite=' + token + '&invite=' + '0'.repeat(64),
        token.slice(1),
        'not an invitation'
    ]) {
        h.component.handleInvitationChange({ target: { value } });
        assert.equal(h.component.invitationUrl, '', value);
        assert.equal(h.component.invalidInvitation, true, value);
    }
    assert.deepEqual(h.effects.navigation, []);
    assert.deepEqual(h.effects.storage, []);
    assert.deepEqual(h.effects.logs, []);
});

test('invalid URL fragments are not automatically copied into the entry', () => {
    for (const href of [guestPage, guestPage + '#invite=bad', guestPage + '?invite=' + token]) {
        const h = entryHarness(href);
        assert.equal(h.component.invitationValue, '');
        assert.equal(h.component.invitationUrl, '');
        assert.deepEqual(h.effects.gps, []);
    }
});

test('the configured public publisher URL is validated before a guest can open it', () => {
    const h = entryHarness();
    h.component.handleInvitationChange({ target: { value: token } });
    h.component.publicPublisherPageUrl = 'https://another.my.salesforce-sites.com/Gps/apex/TechnicianGpsInvite';
    assert.equal(h.component.invitationUrl, h.component.publicPublisherPageUrl + '#invite=' + token);
    for (const value of [
        'https://attacker.example/apex/TechnicianGpsInvite',
        'http://sample.my.site.com/apex/TechnicianGpsInvite',
        invitation.DEFAULT_PUBLISHER_PAGE_URL + '?invite=' + token
    ]) {
        h.component.publicPublisherPageUrl = value;
        assert.equal(h.component.invitationUrl, '');
        assert.equal(h.component.invalidInvitation, true);
    }
});

test('entry markup uses an explicit native top-level link without exposing a token in plaintext', () => {
    assert.match(entryTemplate, /<lightning-input\b[^>]*type="password"[^>]*value=\{invitationValue\}/);
    assert.match(entryTemplate, /<a\b[^>]*href=\{invitationUrl\}[^>]*target="_top"[^>]*referrerpolicy="no-referrer"/);
    assert.doesNotMatch(entryTemplate, /<(?:iframe|c-technician-live-tracking)\b/);
    assert.doesNotMatch(entryTemplate, />\s*\{invitation(?:Value|Url)\}\s*</);
});

test('the root routes guests and authenticated viewers without starting GPS, map listeners, or timers', () => {
    for (const isGuest of [true, false]) {
        const h = rootHarness(isGuest);
        assert.equal(h.component.isGuestVisitor, isGuest);
        h.component.connectedCallback?.();
        h.component.disconnectedCallback?.();
        assert.deepEqual(h.effects.listeners.map(({ type }) => type), ['hashchange']);
        assert.deepEqual(h.effects.removedListeners, h.effects.listeners);
        assert.equal(h.component.showCustomer, false);
        assert.deepEqual(h.effects.gps, []);
        assert.deepEqual(h.effects.timers, []);
        assert.deepEqual(h.effects.navigation, []);
        assert.deepEqual(h.effects.storage, []);
        assert.deepEqual(h.effects.logs, []);
    }
});

test('customer links take the first branch before the guest invitation entry and authenticated owner dashboard', () => {
    const customerStart = rootTemplate.indexOf('<template lwc:if={showCustomer}>');
    assert.ok(customerStart >= 0);
    const customerEnd = rootTemplate.indexOf('</template>', customerStart);
    const customerBranch = rootTemplate.slice(customerStart, customerEnd);
    assert.match(customerBranch, /<c-customer-technician-tracking\b[^>]*public-publisher-page-url=\{publicPublisherPageUrl\}/);
    assert.doesNotMatch(customerBranch, /<c-technician-(?:live-tracking|case-tracking-workspace|invitation-entry)\b/);
    const start = rootTemplate.indexOf('<template lwc:elseif={isGuestVisitor}>');
    assert.ok(start >= 0);
    assert.ok(start > customerEnd);
    const end = rootTemplate.indexOf('</template>', start);
    const guestBranch = rootTemplate.slice(start, end);
    assert.match(guestBranch, /<c-technician-invitation-entry\b[^>]*public-publisher-page-url=\{publicPublisherPageUrl\}/);
    assert.doesNotMatch(guestBranch, /<(?:c-technician-live-tracking|c-technician-case-tracking-workspace|lightning-radio-group|iframe)\b/);
    const ownerBranch = rootTemplate.slice(end);
    assert.match(ownerBranch, /<\/template>\s*<template lwc:else>/);
    assert.match(ownerBranch, /<template lwc:else>\s*<c-technician-case-tracking-workspace\b[^>]*public-publisher-page-url=\{publicPublisherPageUrl\}/);
    assert.doesNotMatch(ownerBranch, /<c-technician-invitation-entry\b/);
    assert.doesNotMatch(rootTemplate, /<(?:lightning-radio-group|lightning-progress-bar|iframe)\b/);
    assert.doesNotMatch(rootTemplate, /Simulated journey|Start demo|Resume demo|showLiveTracking|trackingMode/);
});

test('the authenticated wrapper forwards changing record context only to its Case workspace', () => {
    const h = rootHarness(false);
    h.component.recordId = '500000000000001AAA';
    h.component.objectApiName = 'Case';
    assert.equal(h.component.recordId, '500000000000001AAA');
    h.component.recordId = '500000000000002AAA';
    assert.equal(h.component.recordId, '500000000000002AAA');
    assert.equal(h.component.objectApiName, 'Case');
    assert.match(rootTemplate, /<c-technician-case-tracking-workspace record-id=\{recordId\} object-api-name=\{objectApiName\}/);
    assert.doesNotMatch(rootSource, /@salesforce\/apex/);
    const metadata = read('../../force-app/main/default/lwc/technicianTrackingPoc/technicianTrackingPoc.js-meta.xml');
    assert.match(metadata, /<property name="recordId" type="String"/);
    assert.match(metadata, /<property name="objectApiName" type="String"/);
    assert.match(metadata, /<apiVersion>62.0<\/apiVersion>/);
});

test('root routes retain configurable public phone and customer page URLs', () => {
    for (const isGuest of [true, false]) {
        const h = rootHarness(isGuest);
        assert.equal(h.component.publicPublisherPageUrl, invitation.DEFAULT_PUBLISHER_PAGE_URL);
        assert.equal(h.component.publicCustomerPageUrl, invitation.DEFAULT_CUSTOMER_PAGE_URL);
        const configuredUrl = 'https://sample.my.site.com/FieldService/apex/TechnicianGpsInvite';
        h.component.publicPublisherPageUrl = configuredUrl;
        assert.equal(h.component.publicPublisherPageUrl, configuredUrl);
        h.component.publicCustomerPageUrl = 'https://sample.my.site.com/FieldService/s/tracking';
        assert.equal(h.component.publicCustomerPageUrl, 'https://sample.my.site.com/FieldService/s/tracking');
        assert.equal(h.component.isGuestVisitor, isGuest);
    }
});

test('customer fragment routes both guest and authenticated viewers and follows hash changes', () => {
    for (const isGuest of [true, false]) {
        for (const fragment of ['#customer=' + token, '#CUSTOMER=invalid']) {
            const h = rootHarness(isGuest, guestPage + fragment);
            h.component.connectedCallback();
            assert.equal(h.component.showCustomer, true, 'Malformed customer links still show customer recovery.');
            const listener = h.effects.listeners.find(({ type }) => type === 'hashchange');
            h.window.location.href = guestPage + '#invite=' + token;
            listener.callback();
            assert.equal(h.component.showCustomer, false);
            h.window.location.href = guestPage + '#customer=' + token;
            listener.callback();
            assert.equal(h.component.showCustomer, true);
            h.component.disconnectedCallback();
            assert.deepEqual(h.effects.removedListeners, h.effects.listeners);
            assert.deepEqual(h.effects.gps, []);
            assert.deepEqual(h.effects.timers, []);
            assert.deepEqual(h.effects.navigation, []);
            assert.deepEqual(h.effects.storage, []);
        }
    }
});
