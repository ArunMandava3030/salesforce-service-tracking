# Development setup

Use a development org and your own configuration. All `example` domains below are placeholders.

## 1. Deploy the metadata

Run the commands in the repository README. The manifest contains the session object, Apex classes and tests, LWCs, Visualforce pages, static resources, and permission sets. It does not create an Experience site or modify an existing guest profile.

Assign **Technician Live Tracking POC** to internal users who create or view sessions. They also need access to the Cases they open. Access to a Case permits viewing its sessions; it does not allow managing another user's session.

## 2. Configure the site

Create or select an Experience site. Enable the following public Visualforce pages for that site's guest profile:

- `TechnicianGpsInvite`
- `TechnicianLiveMap`

Grant that guest profile Apex access to:

- `TechnicianGpsInvitationController`
- `TechnicianCustomerTrackingController`

Do not grant the guest profile Case access, tracking-object CRUD, or the internal-user permission set. Public operations validate their individual invitation or viewer token in the access helpers.

Create and publish a page containing **Customer Technician Tracking**, or use **Technician Tracking POC**, which can select the customer view from the link fragment. Use the public page URL for the customer component, without an invitation fragment or query string.

## 3. Set component URLs

In Lightning App Builder or Experience Builder, configure the tracking component:

| Property | Example |
| --- | --- |
| Public GPS publisher page URL | `https://example.my.site.com/tracking/apex/TechnicianGpsInvite` |
| Public customer tracking page URL | `https://example.my.site.com/tracking/s/customer-tracking` |

Use your actual site path and page names. The customer component also needs the publisher page property so it can resolve the map page on the same site.

On a Case record page, the component uses its record context. On an Experience record page, configure the record ID binding and object name where applicable; otherwise the workspace offers a Case search.

## 4. Configure maps and framing

Enable the Maps JavaScript API and Routes API in your Google Cloud project, with billing configured as required by Google. Enter your own browser key in the tracking component when loading the map. Restrict the key to the APIs used here and the actual public-site and Visualforce referrers that render the map.

This is a browser key and is visible to map users; never use an unrestricted server credential for it. Do not commit your key or sample links containing active tokens.

The Experience viewer resolves the map to the same public site origin. For a Lightning-hosted viewer, the map uses the org's Visualforce domain. If framing is blocked:

1. Check the browser console for the exact origin and directive.
2. A `frame-src` block concerns what the parent page can embed. Configure **Trusted URLs** for the exact map origin and the applicable context.
3. A `frame-ancestors` or clickjack block concerns who can embed the Visualforce page. Check **Trusted Domains for Inline Frames** using the actual parent origin.
4. Publish site changes and reload the parent page before retrying.

Do not disable CSP or broaden the allow-list to all domains. Public map resources are already marked with public cache control in this package.

## 5. Verify the flow

1. Open a Case in the tracking workspace and create a session.
2. Load the map using your Maps browser key.
3. Generate a new phone invitation and open it on a phone.
4. Choose **Start sharing** and permit location access.
5. Keep the browser active, move, and confirm the coordinates and received timestamp update in the viewer.
6. Open a customer link in another browser and confirm it shows the read-only view.
7. Open the Case as another authorized internal user and verify session history and viewing access.
8. Stop sharing or revoke the invitation and confirm updates stop.

An optional anonymous map-page check can be run after deployment:

```sh
node scripts/tests/technicianSiteMap.test.mjs https://example.my.site.com/tracking/apex/TechnicianLiveMap
```

Replace the placeholder with your own URL. This check does not need a Maps key, invitation, or Salesforce login.
