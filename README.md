# Salesforce Service Tracking

A technical demonstration of location sharing in Salesforce using Lightning Web Components, Apex, Visualforce, and Google Maps. It shows how browser GPS updates can be associated with a Case and displayed to authorized viewers.

The repository uses example coordinates and placeholder site URLs. Configure your own development org and Maps browser key before running it.

## Workflow

1. An authenticated user opens a Case in the tracking workspace and creates a session.
2. The session owner generates a time-limited phone invitation.
3. The recipient opens the invitation in a phone browser, grants location permission, and chooses **Start sharing**.
4. Apex validates the invitation and GPS sample, then stores the latest accepted position and timestamps on the session record.
5. The LWC viewer polls the session and passes updates to a Visualforce map through a checked `postMessage` channel. Google Maps renders the position, route, and estimated arrival time.
6. A separate read-only link can open a simplified customer viewer. Authorized Salesforce users can revisit sessions through the Case workspace.
7. Stopping or expiring access prevents further sharing. Case session history remains available; the implementation stores the latest position rather than a complete GPS trail.

## Implementation

| Layer | Responsibility |
| --- | --- |
| LWC | Case workspace, session controls, invitation links, viewer status |
| Apex | Session lifecycle, Case access checks, invitation validation, GPS updates |
| Custom object | Session record, Case lookup, expiry, latest coordinates and timestamps |
| Visualforce and static resources | Phone GPS page and Google Maps rendering |
| Experience Cloud / Salesforce Sites | Public invitation and read-only viewer entry points |
| Google Maps JavaScript API and Routes API | Map, driving route, and arrival estimate |

Publisher and viewer links use separate random tokens. The server stores token hashes, checks expiry, and limits each link to its intended operation. Public pages do not require guest access to Cases or tracking records. The iframe bridge checks the sender, origin, and session channel before accepting messages.

## Repository layout

```text
force-app/main/default/
  classes/            Apex controllers, access helpers, and tests
  customPermissions/  Permission for Case-linked tracking views
  lwc/                Tracking workspace and map viewers
  objects/            Tracking session metadata
  pages/              Visualforce map and GPS pages
  permissionsets/     Internal-user access configuration
  staticresources/    Browser GPS, map, and route scripts
manifest/package.xml  Salesforce deployment scope
scripts/tests/        Dependency-free JavaScript behavior tests
docs/setup.md         Configuration and verification steps
```

## Try it in a development org

Requirements: Salesforce CLI, a development org with an Experience site, a Google Maps project with the Maps JavaScript API and Routes API enabled, and a phone browser with location permission. Local JavaScript tests require Node.js 22.8 or newer.

```sh
sf org login web --alias tracking-demo
sf project deploy start --manifest manifest/package.xml --target-org tracking-demo --api-version 62.0 --test-level RunSpecifiedTests --tests TechnicianLiveTrackingControllerTest --tests TechnicianGpsInvitationControllerTest --tests TechnicianCustomerTrackingControllerTest --tests TechnicianCaseTrackingControllerTest --wait 10
sf org assign permset --name Technician_Live_Tracking_POC --target-org tracking-demo
npm test
```

Complete the [site and map setup](docs/setup.md), then add **Technician Tracking POC** to a Case record page or an Experience page. Replace the example site URLs using the component properties in the relevant builder.

## Demonstration limits

- Phone GPS runs in a browser. The page must remain open and active; screen locking or switching apps can suspend updates. This demonstration does not guarantee background tracking.
- Sessions expire after two hours. A visible timestamp distinguishes fresh GPS from an old position.
- The destination is a fixed, public example coordinate (`37.7749, -122.4194`). Routes and ETA are estimates and require a configured Maps browser key.
- A link grants its holder the corresponding publisher or viewer access until revoked or expired.
- Case history records sessions, not a sequence of every GPS point.

## Tests

`npm test` exercises invitation parsing, permission boundaries in browser flows, map handshakes, GPS lifecycle, routing, viewer updates, and Case workspace behavior. Opt-in deployed-site checks are skipped unless a site URL is supplied. Apex tests are included and must be run against a Salesforce org; local JavaScript tests do not compile Apex or replace a device test.

Publication checks: 223 JavaScript tests passed, with 8 optional deployed-site checks skipped. A validation-only Salesforce deployment checked 49 metadata components and passed all 32 included Apex tests. No changes were retained by that validation run.

<img width="1914" height="1051" alt="Screenshot 2026-10-27 171322" src="https://github.com/user-attachments/assets/a294c641-f39b-4c80-9442-5cda144883cd" />
<img width="1919" height="1063" alt="Screenshot 2026-10-27 171346" src="https://github.com/user-attachments/assets/dfb76ef6-513f-4cbf-b516-1931c0e7b182" />

