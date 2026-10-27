import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
    new URL('../../force-app/main/default/lwc/trackingInvitation/trackingInvitation.js', import.meta.url),
    'utf8'
);
const { DEFAULT_PUBLISHER_PAGE_URL, normalizePublisherPageUrl, readInvitationToken, buildInvitationUrl,
    resolveLiveMapPageUrl, DEFAULT_CUSTOMER_PAGE_URL, normalizeCustomerPageUrl,
    buildCustomerUrl, readCustomerToken, hasCustomerFragment } =
    await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const token = '0123456789abcdef'.repeat(4);
const otherToken = 'abcdef0123456789'.repeat(4);

test('customer links target configured Salesforce Experience pages and contain only a fragment capability', () => {
    assert.equal(DEFAULT_CUSTOMER_PAGE_URL,
        'https://example.my.site.com/LiveTracking/s/');
    for (const page of [DEFAULT_CUSTOMER_PAGE_URL,
        'https://sample.my.site.com/FieldService/s/tracking',
        'https://sample.my.salesforce-sites.com/Service/s/']) {
        assert.equal(normalizeCustomerPageUrl('  ' + page + '  '), page);
        const link = buildCustomerUrl(page, token.toUpperCase());
        assert.equal(link, page + '#customer=' + token);
        assert.equal(new URL(link).search, '');
        assert.equal(readCustomerToken(link), token);
        assert.equal(readInvitationToken(link), '');
    }
    for (const page of [null, {}, '', 'not a URL', 'http://sample.my.site.com/s/',
        'https://attacker.example/s/', 'https://sample.my.site.com.attacker.example/s/',
        'https://sample.my.site.com:8443/s/', 'https://user:pass@sample.my.site.com/s/',
        DEFAULT_PUBLISHER_PAGE_URL, DEFAULT_CUSTOMER_PAGE_URL + '?customer=' + token,
        DEFAULT_CUSTOMER_PAGE_URL + '#customer=' + token]) {
        assert.throws(() => normalizeCustomerPageUrl(page), Error, String(page));
    }
    for (const value of [null, '', 'bad', token.slice(1), token + '0', 'g'.repeat(64)]) {
        assert.throws(() => buildCustomerUrl(DEFAULT_CUSTOMER_PAGE_URL, value), Error);
    }
});

test('customer recovery accepts strict normalized codes and agreeing customer fragments', () => {
    assert.equal(readCustomerToken('  ' + token.toUpperCase() + '\n'), token);
    for (const name of ['customer', 'CUSTOMER', 'CuStOmEr']) {
        assert.equal(readCustomerToken(DEFAULT_CUSTOMER_PAGE_URL + '#' + name + '=' + token.toUpperCase()), token);
    }
    assert.equal(readCustomerToken(DEFAULT_CUSTOMER_PAGE_URL + '?language=en#customer=' + token + '&CUSTOMER=' + token.toUpperCase()), token);
    for (const value of [null, undefined, {}, true, 123, '', token.slice(1), token + '0', 'g'.repeat(64),
        DEFAULT_CUSTOMER_PAGE_URL + '#customer=' + token + '&customer=' + otherToken,
        DEFAULT_CUSTOMER_PAGE_URL + '#customer=' + token + '&customer=',
        DEFAULT_CUSTOMER_PAGE_URL + '#customer=' + token + '&customer=bad',
        DEFAULT_CUSTOMER_PAGE_URL.replace('https:', 'http:') + '#customer=' + token,
        'https://user:pass@sample.my.site.com/s/#customer=' + token,
        '/s/#customer=' + token, 'javascript:void(0)#customer=' + token]) {
        assert.equal(readCustomerToken(value), '', String(value));
    }
});

test('customer and phone links reject mixed purposes and query capabilities', () => {
    for (const reader of [readCustomerToken, readInvitationToken]) {
        for (const fragment of ['customer=' + token, 'invite=' + token]) {
            for (const query of ['customer', 'CUSTOMER', 'invite', 'INVITE']) {
                assert.equal(reader(DEFAULT_CUSTOMER_PAGE_URL + '?' + query + '=' + otherToken + '#' + fragment), '');
            }
        }
        for (const mixed of ['customer=' + token + '&invite=' + otherToken,
            'INVITE=' + token + '&CUSTOMER=' + token]) {
            assert.equal(reader(DEFAULT_CUSTOMER_PAGE_URL + '#' + mixed), '');
        }
    }
    assert.equal(readCustomerToken(buildInvitationUrl(DEFAULT_PUBLISHER_PAGE_URL, token)), '');
    assert.equal(readInvitationToken(buildCustomerUrl(DEFAULT_CUSTOMER_PAGE_URL, token)), '');
});

test('customer route detection recognizes even malformed customer codes without treating phone links as customers', () => {
    for (const fragment of ['customer=' + token, 'CUSTOMER=bad', 'customer=', '%63ustomer=bad']) {
        assert.equal(hasCustomerFragment(DEFAULT_CUSTOMER_PAGE_URL + '#' + fragment), true);
    }
    for (const value of [null, '', 'not a URL', DEFAULT_CUSTOMER_PAGE_URL,
        DEFAULT_CUSTOMER_PAGE_URL + '?customer=' + token,
        DEFAULT_CUSTOMER_PAGE_URL + '#invite=' + token,
        DEFAULT_CUSTOMER_PAGE_URL + '#notcustomer=' + token,
        DEFAULT_CUSTOMER_PAGE_URL + '#%ZZ=bad']) {
        assert.equal(hasCustomerFragment(value), false);
    }
});

test('the default publisher URL is an allowed Salesforce Sites invitation page', () => {
    assert.equal(DEFAULT_PUBLISHER_PAGE_URL,
        'https://example.my.site.com/LiveTracking/apex/TechnicianGpsInvite');
    assert.equal(normalizePublisherPageUrl(DEFAULT_PUBLISHER_PAGE_URL), DEFAULT_PUBLISHER_PAGE_URL);
});

test('publisher normalization supports Salesforce Sites prefixes and canonical HTTPS URLs', () => {
    for (const value of [
        'https://sample.my.site.com/apex/TechnicianGpsInvite',
        'https://sample.my.site.com/LiveTracking/apex/TechnicianGpsInvite',
        'https://sample.my.site.com/vforcesite/TechnicianGpsInvite',
        'https://sample.my.salesforce-sites.com/TechnicianGpsInvite'
    ]) {
        assert.equal(normalizePublisherPageUrl(value), value);
    }
    assert.equal(
        normalizePublisherPageUrl('  HTTPS://SAMPLE.MY.SITE.COM:443/LiveTracking/apex/TechnicianGpsInvite  '),
        'https://sample.my.site.com/LiveTracking/apex/TechnicianGpsInvite'
    );
});

test('publisher normalization rejects untrusted hosts, wrong pages, credentials, queries and fragments', () => {
    for (const value of [
        null, undefined, {}, '', 'not a URL',
        'http://sample.my.site.com/apex/TechnicianGpsInvite',
        'https://example.com/apex/TechnicianGpsInvite',
        'https://sample.my.site.com.attacker.example/apex/TechnicianGpsInvite',
        'https://sample-my.site.com/apex/TechnicianGpsInvite',
        'https://sample.my.salesforce.com/apex/TechnicianGpsInvite',
        'https://sample.my.site.com:8443/apex/TechnicianGpsInvite',
        'https://user:password@sample.my.site.com/apex/TechnicianGpsInvite',
        'https://sample.my.site.com/apex/TechnicianGpsPublisher',
        DEFAULT_PUBLISHER_PAGE_URL + '/',
        DEFAULT_PUBLISHER_PAGE_URL + '?',
        DEFAULT_PUBLISHER_PAGE_URL + '#',
        DEFAULT_PUBLISHER_PAGE_URL + '?invite=' + token,
        DEFAULT_PUBLISHER_PAGE_URL + '#invite=' + token
    ]) {
        assert.throws(() => normalizePublisherPageUrl(value), Error, String(value));
    }
});

test('plain invitation tokens are exactly 64 hexadecimal characters and normalize to lowercase', () => {
    assert.equal(readInvitationToken(token), token);
    assert.equal(readInvitationToken('  ' + token.toUpperCase() + '\n'), token);
    for (const value of [null, undefined, 123, true, [], {}, '', token.slice(1), token + '0', 'g'.repeat(64), 'Use ' + token]) {
        assert.equal(readInvitationToken(value), '', String(value));
    }
});

test('HTTPS invitation links read only the fragment with case-insensitive parameter names', () => {
    for (const name of ['invite', 'INVITE', 'InViTe']) {
        assert.equal(readInvitationToken(DEFAULT_PUBLISHER_PAGE_URL + '#' + name + '=' + token.toUpperCase()), token);
    }
    assert.equal(readInvitationToken('  ' + DEFAULT_PUBLISHER_PAGE_URL + '#invite=%20' + token + '%20\n'), token);
    assert.equal(readInvitationToken(DEFAULT_PUBLISHER_PAGE_URL + '?language=en#invite=' + token), token);
    assert.equal(readInvitationToken(DEFAULT_PUBLISHER_PAGE_URL + '#invite=' + token + '&section=location'), token);
});

test('duplicate fragment tokens must all be valid and agree after hex normalization', () => {
    assert.equal(readInvitationToken(DEFAULT_PUBLISHER_PAGE_URL + '#invite=' + token + '&INVITE=' + token.toUpperCase()), token);
    for (const duplicate of [otherToken, '', 'bad', 'g'.repeat(64)]) {
        assert.equal(readInvitationToken(DEFAULT_PUBLISHER_PAGE_URL + '#invite=' + token + '&INVITE=' + duplicate), '');
    }
});

test('query tokens are never accepted, even beside a valid fragment, and unsafe protocols are rejected', () => {
    for (const value of [
        DEFAULT_PUBLISHER_PAGE_URL,
        DEFAULT_PUBLISHER_PAGE_URL + '#invite=',
        DEFAULT_PUBLISHER_PAGE_URL + '?invite=' + token,
        DEFAULT_PUBLISHER_PAGE_URL + '?INVITE=' + token + '#invite=' + token,
        DEFAULT_PUBLISHER_PAGE_URL + '?invite=#invite=' + token,
        DEFAULT_PUBLISHER_PAGE_URL.replace('https:', 'http:') + '#invite=' + token,
        'javascript:alert(1)#invite=' + token,
        '/apex/TechnicianGpsInvite#invite=' + token,
        'https://[#invite=' + token
    ]) {
        assert.equal(readInvitationToken(value), '', value);
    }
});

test('building an invitation puts a validated normalized token only in the fragment', () => {
    const link = buildInvitationUrl('  ' + DEFAULT_PUBLISHER_PAGE_URL + '  ', token.toUpperCase());
    assert.equal(link, DEFAULT_PUBLISHER_PAGE_URL + '#invite=' + token);
    const url = new URL(link);
    assert.equal(url.search, '');
    assert.equal(url.hash, '#invite=' + token);
    assert.equal(readInvitationToken(link), token);
    assert.throws(() => buildInvitationUrl('https://attacker.example/apex/TechnicianGpsInvite', token), Error);
    for (const value of [null, '', 'bad', token.slice(1), link]) {
        assert.throws(() => buildInvitationUrl(DEFAULT_PUBLISHER_PAGE_URL, value), Error);
    }
});

test('Lightning viewers retain the authenticated map URL for their own production, developer, or sandbox org', () => {
    for (const [viewerOrigin, privateMapUrl] of [
        ['https://example.lightning.force.com', 'https://example--c.vf.force.com/apex/TechnicianLiveMap'],
        ['https://example.develop.lightning.force.com', 'https://example--c.develop.vf.force.com/apex/TechnicianLiveMap'],
        ['https://example--uat.sandbox.lightning.force.com', 'https://example--uat--c.sandbox.vf.force.com/apex/TechnicianLiveMap']
    ]) {
        assert.equal(resolveLiveMapPageUrl(privateMapUrl, DEFAULT_PUBLISHER_PAGE_URL, viewerOrigin), privateMapUrl);
        // An unrelated public-site configuration cannot redirect the authenticated org route.
        assert.equal(resolveLiveMapPageUrl(privateMapUrl, 'not configured', viewerOrigin), privateMapUrl);
    }
});

test('Experience viewers use a public map on the same site origin and preserve the configured site path', () => {
    for (const publisherUrl of [
        'https://example.my.site.com/LiveTracking/apex/TechnicianGpsInvite',
        'https://example.develop.my.site.com/LiveTracking/apex/TechnicianGpsInvite',
        'https://example--uat.sandbox.my.site.com/LiveTracking/apex/TechnicianGpsInvite',
        'https://example.my.site.com/LiveTracking/vforcesite/TechnicianGpsInvite',
        'https://example.my.salesforce-sites.com/Tracking/TechnicianGpsInvite'
    ]) {
        const viewerOrigin = new URL(publisherUrl).origin;
        const actual = resolveLiveMapPageUrl('https://example--c.vf.force.com/apex/TechnicianLiveMap', publisherUrl, viewerOrigin);
        assert.equal(actual, publisherUrl.replace(/TechnicianGpsInvite$/, 'TechnicianLiveMap'));
        assert.equal(new URL(actual).origin, viewerOrigin);
        assert.equal(new URL(actual).search, '');
        assert.equal(new URL(actual).hash, '');
    }
});

test('map routing rejects untrusted viewer origins and public-site configurations from another origin', () => {
    const privateMapUrl = 'https://example--c.vf.force.com/apex/TechnicianLiveMap';
    const siteUrl = 'https://example.my.site.com/LiveTracking/apex/TechnicianGpsInvite';
    for (const viewerOrigin of [
        '', 'not a URL', 'http://example.my.site.com',
        'https://example.my.site.com:8443',
        'https://example.my.site.com/LiveTracking/s/',
        'https://example.my.site.com?unexpected=true',
        'https://example.my.site.com#unexpected',
        'https://attacker.example',
        'https://example.my.site.com.attacker.example',
        'https://different.my.site.com'
    ]) {
        assert.throws(() => resolveLiveMapPageUrl(privateMapUrl, siteUrl, viewerOrigin), Error, viewerOrigin);
    }
    assert.throws(() => resolveLiveMapPageUrl(privateMapUrl,
        'https://attacker.example/apex/TechnicianGpsInvite', 'https://attacker.example'), Error);
    for (const invalidPublisher of [siteUrl + '?invite=' + token, siteUrl + '#invite=' + token,
        'https://different.my.site.com/LiveTracking/apex/TechnicianGpsInvite']) {
        assert.throws(() => resolveLiveMapPageUrl(privateMapUrl, invalidPublisher, 'https://example.my.site.com'), Error);
    }
});

test('authenticated map routes reject another org, unsafe URLs, and unexpected pages or URL data', () => {
    const viewerOrigin = 'https://example.develop.lightning.force.com';
    const mapUrl = 'https://example--c.develop.vf.force.com/apex/TechnicianLiveMap';
    for (const candidate of [
        null, undefined, '', 'not a URL',
        'http://example--c.develop.vf.force.com/apex/TechnicianLiveMap',
        'https://different--c.develop.vf.force.com/apex/TechnicianLiveMap',
        'https://example--c.vf.force.com/apex/TechnicianLiveMap',
        'https://example--c.develop.vf.force.com.attacker.example/apex/TechnicianLiveMap',
        'https://user:password@example--c.develop.vf.force.com/apex/TechnicianLiveMap',
        'https://example--c.develop.vf.force.com:8443/apex/TechnicianLiveMap',
        'https://example--c.develop.vf.force.com/apex/TechnicianGpsInvite',
        mapUrl + '/', mapUrl + '?sessionId=a01000000000001AAA', mapUrl + '#invite=' + token
    ]) {
        assert.throws(() => resolveLiveMapPageUrl(candidate, DEFAULT_PUBLISHER_PAGE_URL, viewerOrigin), Error, String(candidate));
    }
});
