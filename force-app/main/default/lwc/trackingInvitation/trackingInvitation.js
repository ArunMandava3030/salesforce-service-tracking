export const DEFAULT_PUBLISHER_PAGE_URL =
    'https://example.my.site.com/LiveTracking/apex/TechnicianGpsInvite';
export const DEFAULT_CUSTOMER_PAGE_URL =
    'https://example.my.site.com/LiveTracking/s/';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

function normalizedToken(value) {
    if (typeof value !== 'string') return '';
    const token = value.trim();
    return TOKEN_PATTERN.test(token) ? token.toLowerCase() : '';
}

export function normalizePublisherPageUrl(value) {
    const input = typeof value === 'string' ? value.trim() : '';
    let url;
    try {
        url = new URL(input);
    } catch (error) {
        throw new Error('Enter the HTTPS Salesforce Sites URL for the TechnicianGpsInvite page.');
    }

    const allowedHost = url.hostname.endsWith('.my.site.com') ||
        url.hostname.endsWith('.my.salesforce-sites.com');
    if (url.protocol !== 'https:' || !allowedHost || url.username || url.password ||
        url.port || input.includes('?') || input.includes('#') ||
        !url.pathname.endsWith('/TechnicianGpsInvite')) {
        throw new Error('Use the HTTPS Salesforce Sites TechnicianGpsInvite page URL without credentials, a query, or a fragment.');
    }
    return url.href;
}

// Experience pages use a map shell on their own site, avoiding org VF session redirects.
// Lightning Experience keeps its authenticated Visualforce route.
export function resolveLiveMapPageUrl(privatePageUrl, publisherPageUrl, viewerOrigin) {
    let viewer;
    try { viewer = new URL(viewerOrigin); } catch (error) {
        throw new Error('Open tracking from your Salesforce Lightning page or configured Experience site.');
    }
    if (viewer.protocol !== 'https:' || viewer.origin !== viewerOrigin || viewer.port) {
        throw new Error('Open tracking from a secure Salesforce page.');
    }
    const lightning = viewer.hostname.match(/^([a-z0-9-]+)((?:\.[a-z0-9-]+)*)\.lightning\.force\.com$/i);
    if (lightning) {
        let map;
        try { map = new URL(privatePageUrl); } catch (error) {
            throw new Error('The Salesforce map page URL is unavailable. Refresh the tracking session.');
        }
        const expectedHost = lightning[1] + '--c' + lightning[2] + '.vf.force.com';
        if (map.protocol !== 'https:' || map.hostname !== expectedHost || map.port ||
            map.username || map.password || map.search || map.hash || map.pathname !== '/apex/TechnicianLiveMap') {
            throw new Error('The map page must belong to this Salesforce org. Refresh the tracking session.');
        }
        return map.href;
    }
    const publisher = new URL(normalizePublisherPageUrl(publisherPageUrl));
    if (publisher.origin !== viewer.origin) {
        throw new Error('Set Public GPS publisher page URL to the TechnicianGpsInvite page on this Experience site.');
    }
    publisher.pathname = publisher.pathname.replace(/\/TechnicianGpsInvite$/, '/TechnicianLiveMap');
    return publisher.href;
}

export function readInvitationToken(value) {
    const plainToken = normalizedToken(value);
    if (plainToken) return plainToken;
    if (typeof value !== 'string') return '';

    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'https:' || url.username || url.password) return '';

        // A capability belongs in the fragment, which is not sent in HTTP requests.
        let queryHasInvitation = false;
        url.searchParams.forEach((candidate, name) => {
            if (['invite', 'customer'].includes(name.toLowerCase())) queryHasInvitation = true;
        });
        if (queryHasInvitation) return '';

        const candidates = [];
        let hasCustomer = false;
        new URLSearchParams(url.hash.slice(1)).forEach((candidate, name) => {
            if (name.toLowerCase() === 'customer') hasCustomer = true;
            if (name.toLowerCase() === 'invite') candidates.push(normalizedToken(candidate));
        });
        if (hasCustomer || !candidates.length || candidates.some((candidate) => !candidate || candidate !== candidates[0])) {
            return '';
        }
        return candidates[0];
    } catch (error) {
        return '';
    }
}

export function buildInvitationUrl(pageUrl, token) {
    const publisherPageUrl = normalizePublisherPageUrl(pageUrl);
    const invitationToken = normalizedToken(token);
    if (!invitationToken) {
        throw new Error('A valid tracking invitation token is required.');
    }
    return publisherPageUrl + '#invite=' + invitationToken;
}

export function normalizeCustomerPageUrl(value) {
    let url;
    try { url = new URL(typeof value === 'string' ? value.trim() : ''); } catch (error) {
        throw new Error('Set the HTTPS Experience page URL containing the customer tracking component.');
    }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
        !(url.hostname.endsWith('.my.site.com') || url.hostname.endsWith('.my.salesforce-sites.com')) ||
        url.pathname.includes('/apex/')) {
        throw new Error('Use the HTTPS Experience page URL without credentials, query parameters or a fragment.');
    }
    return url.href;
}

export function buildCustomerUrl(pageUrl, token) {
    const url = normalizeCustomerPageUrl(pageUrl);
    const customerToken = normalizedToken(token);
    if (!customerToken) throw new Error('A valid customer tracking token is required.');
    return url + '#customer=' + customerToken;
}

export function hasCustomerFragment(value) {
    try {
        return [...new URL(value).hash.slice(1).split('&')].some(part =>
            decodeURIComponent(part.split('=')[0]).toLowerCase() === 'customer');
    } catch (error) { return false; }
}

export function readCustomerToken(value) {
    const plain = normalizedToken(value);
    if (plain) return plain;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) return '';
        for (const name of url.searchParams.keys()) {
            if (['customer', 'invite'].includes(name.toLowerCase())) return '';
        }
        const values = [];
        for (const [name, token] of new URLSearchParams(url.hash.slice(1))) {
            if (name.toLowerCase() === 'invite') return '';
            if (name.toLowerCase() === 'customer') values.push(normalizedToken(token));
        }
        return values.length && values.every(token => token && token === values[0]) ? values[0] : '';
    } catch (error) { return ''; }
}
