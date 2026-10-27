@IsTest
private class TechnicianGpsInvitationControllerTest {
    @TestSetup
    static void setUpUsers() {
        Id limitedProfileId = [
            SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1
        ].Id;
        String uniqueSuffix = UserInfo.getOrganizationId() + '.' + String.valueOf(System.now().getTime());
        List<User> users = new List<User>();
        for (String role : new List<String>{ 'owner', 'publisher', 'otheradmin' }) {
            users.add(new User(
                Alias = 'gpsinv',
                Email = 'gps-invitation-' + role + '@example.invalid',
                EmailEncodingKey = 'UTF-8',
                LastName = 'GPS Invitation ' + role,
                LanguageLocaleKey = 'en_US',
                LocaleSidKey = 'en_US',
                ProfileId = role == 'publisher' ? limitedProfileId : UserInfo.getProfileId(),
                TimeZoneSidKey = 'America/Los_Angeles',
                Username = 'gps-invitation-' + role + '.' + uniqueSuffix + '@example.invalid'
            ));
        }
        insert users;
        Id ownerPermissionSetId = [
            SELECT Id FROM PermissionSet WHERE Name = 'Technician_Live_Tracking_POC' LIMIT 1
        ].Id;
        insert new List<PermissionSetAssignment>{
            new PermissionSetAssignment(AssigneeId = users[0].Id, PermissionSetId = ownerPermissionSetId),
            new PermissionSetAssignment(AssigneeId = users[2].Id, PermissionSetId = ownerPermissionSetId)
        };
    }

    private static User person(String role) {
        String email = 'gps-invitation-' + role + '@example.invalid';
        return [SELECT Id FROM User WHERE Email = :email LIMIT 1];
    }

    private static void assertInvitationRejected(String token) {
        String expected = 'This phone link is invalid, expired, or revoked. Ask the session owner for a new link.';
        for (String operation : new List<String>{ 'status', 'publish', 'stop' }) {
            Boolean rejected = false;
            try {
                if (operation == 'status') {
                    TechnicianGpsInvitationController.getPublisherStatus(token);
                } else if (operation == 'publish') {
                    TechnicianGpsInvitationController.publishLocation(token, 37.7710, -122.4230, 5, System.now().getTime());
                } else {
                    TechnicianGpsInvitationController.stopPublishing(token);
                }
            } catch (AuraHandledException error) {
                rejected = true;
                System.assertEquals(expected, error.getMessage(), 'Token failures must not disclose record existence.');
            }
            System.assert(rejected, 'The invalid invitation must reject ' + operation + '.');
        }
    }

    private static void assertOwnerActionsDenied(String sessionId) {
        for (String operation : new List<String>{ 'read', 'issue', 'revoke', 'end', 'phone', 'legacyPublish' }) {
            Boolean rejected = false;
            try {
                if (operation == 'read') {
                    TechnicianLiveTrackingController.getSession(sessionId);
                } else if (operation == 'issue') {
                    TechnicianLiveTrackingController.issuePublisherLink(sessionId);
                } else if (operation == 'revoke') {
                    TechnicianLiveTrackingController.revokePublisherLink(sessionId);
                } else if (operation == 'end') {
                    TechnicianLiveTrackingController.endSession(sessionId);
                } else if (operation == 'phone') {
                    TechnicianLiveTrackingController.getPhoneSession(sessionId);
                } else {
                    TechnicianLiveTrackingController.publishLocation(sessionId, 37.7710, -122.4230, 5, System.now().getTime());
                }
            } catch (AuraHandledException error) {
                rejected = true;
            }
            System.assert(rejected, 'An invitation must not authorize the owner action ' + operation + '.');
        }
        for (String operation : new List<String>{ 'issue', 'revoke', 'inviteState' }) {
            Boolean rejected = false;
            try {
                if (operation == 'issue') {
                    TechnicianPublisherAccess.issueForOwner(Id.valueOf(sessionId));
                } else if (operation == 'revoke') {
                    TechnicianPublisherAccess.revokeForOwner(Id.valueOf(sessionId));
                } else {
                    TechnicianPublisherAccess.isInviteActiveForOwner(Id.valueOf(sessionId));
                }
            } catch (AuraHandledException error) {
                rejected = true;
            }
            System.assert(rejected, 'The privileged helper must independently enforce ownership.');
        }
    }

    @IsTest
    static void createsOnlyHashedExpiringGrant() {
        System.runAs(person('owner')) {
            TechnicianTrackingSnapshot created = TechnicianLiveTrackingController.createSession();
            System.assertEquals(false, created.publisherInviteActive);
            TechnicianPublisherGrant grant = TechnicianLiveTrackingController.issuePublisherLink(created.sessionId);
            System.assert(grant.token != null && Pattern.matches('^[0-9a-fA-F]{64}$', grant.token));
            System.assertEquals(created.expiresAtMs, grant.expiresAtMs);
            Technician_Tracking_Session__c stored = [
                SELECT Publisher_Token_Hash__c FROM Technician_Tracking_Session__c WHERE Id = :created.sessionId
            ];
            String expectedDigest = EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', Blob.valueOf(grant.token)));
            System.assert(stored.Publisher_Token_Hash__c == expectedDigest, 'Only the token digest is persisted.');
            System.assert(stored.Publisher_Token_Hash__c != grant.token, 'Raw tokens must not be stored.');
            TechnicianTrackingSnapshot ownerView = TechnicianLiveTrackingController.getSession(created.sessionId);
            System.assertEquals(true, ownerView.publisherInviteActive);
            System.assert(!JSON.serialize(ownerView).contains(grant.token), 'Polling must never return the invitation secret.');
            System.assert(!JSON.serialize(ownerView).contains(expectedDigest), 'Polling must never return the digest.');
            TechnicianLiveTrackingController.endSession(created.sessionId);
            System.assertEquals(null, [
                SELECT Publisher_Token_Hash__c FROM Technician_Tracking_Session__c WHERE Id = :created.sessionId
            ].Publisher_Token_Hash__c);
            assertInvitationRejected(grant.token);
        }
    }

    @IsTest
    static void differentUserPublishesWithoutCrud() {
        String sessionId;
        TechnicianPublisherGrant grant;
        System.runAs(person('owner')) {
            sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            grant = TechnicianLiveTrackingController.issuePublisherLink(sessionId);
        }
        System.runAs(person('publisher')) {
            System.assertEquals(false, Technician_Tracking_Session__c.SObjectType.getDescribe().isAccessible());
            System.assertEquals(false, Technician_Tracking_Session__c.SObjectType.getDescribe().isCreateable());
            System.assertEquals(false, Technician_Tracking_Session__c.SObjectType.getDescribe().isUpdateable());
            TechnicianPublisherStatus saved = TechnicianGpsInvitationController.publishLocation(
                grant.token, 37.7712345, -122.4223457, 6.25, System.now().getTime()
            );
            System.assertEquals(true, saved.active);
            System.assertEquals(false, saved.expired);
            System.assertNotEquals(null, saved.receivedAtMs);
            Map<String, Object> exposed = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(saved));
            System.assertEquals(new Set<String>{
                'active', 'expired', 'expiresAtMs', 'receivedAtMs', 'acceptedCapturedAtMs'
            }, exposed.keySet(), 'Publisher responses must not expose coordinates, IDs, owner information or map URLs.');
            TechnicianPublisherStatus initialStatus = TechnicianGpsInvitationController.getPublisherStatus(grant.token.toUpperCase());
            System.assertEquals(true, initialStatus.active);
            System.assertEquals(null, initialStatus.acceptedCapturedAtMs, 'Checking an invitation must not expose prior activity.');
            System.assertEquals(null, initialStatus.receivedAtMs);
            assertOwnerActionsDenied(sessionId);
        }
        System.runAs(person('otheradmin')) {
            assertOwnerActionsDenied(sessionId);
        }
        System.runAs(person('owner')) {
            TechnicianTrackingSnapshot view = TechnicianLiveTrackingController.getSession(sessionId);
            System.assertEquals(37.7712345, view.latitude);
            System.assertEquals(-122.4223457, view.longitude);
            System.assertEquals(true, view.active);
        }
    }

    @IsTest
    static void rotationRevocationAndSessionScope() {
        String firstId;
        String secondId;
        TechnicianPublisherGrant firstGrant;
        TechnicianPublisherGrant replacement;
        TechnicianPublisherGrant secondGrant;
        System.runAs(person('owner')) {
            firstId = TechnicianLiveTrackingController.createSession().sessionId;
            secondId = TechnicianLiveTrackingController.createSession().sessionId;
            firstGrant = TechnicianLiveTrackingController.issuePublisherLink(firstId);
            replacement = TechnicianLiveTrackingController.issuePublisherLink(firstId);
            secondGrant = TechnicianLiveTrackingController.issuePublisherLink(secondId);
            System.assert(firstGrant.token != replacement.token, 'Rotation must generate a fresh random token.');
        }
        System.runAs(person('publisher')) {
            assertInvitationRejected(firstGrant.token);
            TechnicianGpsInvitationController.publishLocation(replacement.token, 37.7700, -122.4300, 10, System.now().getTime());
            System.assertEquals(true, TechnicianGpsInvitationController.getPublisherStatus(secondGrant.token).active);
        }
        System.runAs(person('owner')) {
            System.assertEquals(null, TechnicianLiveTrackingController.getSession(secondId).latitude, 'A grant cannot select a different session.');
            TechnicianTrackingSnapshot revoked = TechnicianLiveTrackingController.revokePublisherLink(firstId);
            System.assertEquals(false, revoked.publisherInviteActive);
            System.assertEquals(true, revoked.active, 'Revoking a publisher does not end the owner session.');
        }
        System.runAs(person('publisher')) {
            assertInvitationRejected(replacement.token);
            System.assertEquals(true, TechnicianGpsInvitationController.getPublisherStatus(secondGrant.token).active);
        }
    }

    @IsTest
    static void publisherStopOnlyRevokesInvitation() {
        String sessionId;
        TechnicianPublisherGrant grant;
        System.runAs(person('owner')) {
            sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            grant = TechnicianLiveTrackingController.issuePublisherLink(sessionId);
        }
        System.runAs(person('publisher')) {
            System.assertEquals(false, TechnicianGpsInvitationController.stopPublishing(grant.token).active);
            assertInvitationRejected(grant.token);
        }
        System.runAs(person('owner')) {
            TechnicianTrackingSnapshot view = TechnicianLiveTrackingController.getSession(sessionId);
            System.assertEquals(true, view.active);
            System.assertEquals(false, view.publisherInviteActive);
            TechnicianPublisherGrant replacement = TechnicianLiveTrackingController.issuePublisherLink(sessionId);
            System.assertEquals(true, TechnicianGpsInvitationController.getPublisherStatus(replacement.token).active);
        }
    }

    @IsTest
    static void invalidTokensHaveUniformErrors() {
        String sessionId;
        TechnicianPublisherGrant grant;
        String storedDigest;
        System.runAs(person('owner')) {
            sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            grant = TechnicianLiveTrackingController.issuePublisherLink(sessionId);
            storedDigest = [
                SELECT Publisher_Token_Hash__c FROM Technician_Tracking_Session__c WHERE Id = :sessionId
            ].Publisher_Token_Hash__c;
        }
        System.runAs(person('publisher')) {
            for (String invalid : new List<String>{
                null, '', sessionId, grant.token.substring(0, 63), grant.token.substring(0, 63) + '!',
                EncodingUtil.convertToHex(Crypto.generateAesKey(256)), storedDigest
            }) {
                assertInvitationRejected(invalid);
            }
        }
        System.runAs(person('owner')) {
            System.assertEquals(null, TechnicianLiveTrackingController.getSession(sessionId).latitude);
        }
    }

    @IsTest
    static void expiredAndInactiveGrantsCannotWrite() {
        String expiredId;
        String inactiveId;
        TechnicianPublisherGrant expired;
        TechnicianPublisherGrant inactive;
        System.runAs(person('owner')) {
            expiredId = TechnicianLiveTrackingController.createSession().sessionId;
            inactiveId = TechnicianLiveTrackingController.createSession().sessionId;
            expired = TechnicianLiveTrackingController.issuePublisherLink(expiredId);
            inactive = TechnicianLiveTrackingController.issuePublisherLink(inactiveId);
            update new List<Technician_Tracking_Session__c>{
                new Technician_Tracking_Session__c(Id = expiredId, Expires_At__c = System.now().addMinutes(-1)),
                new Technician_Tracking_Session__c(Id = inactiveId, Active__c = false)
            };
            for (String closedId : new List<String>{ expiredId, inactiveId }) {
                Boolean rejected = false;
                try {
                    TechnicianLiveTrackingController.issuePublisherLink(closedId);
                } catch (AuraHandledException error) {
                    rejected = true;
                }
                System.assert(rejected, 'An inactive or expired session cannot issue a new invitation.');
                System.assertEquals(false, TechnicianLiveTrackingController.getSession(closedId).publisherInviteActive);
            }
        }
        System.runAs(person('publisher')) {
            assertInvitationRejected(expired.token);
            assertInvitationRejected(inactive.token);
        }
    }

    @IsTest
    static void validatesSamplesAndIgnoresReordering() {
        String sessionId;
        TechnicianPublisherGrant grant;
        System.runAs(person('owner')) {
            sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            grant = TechnicianLiveTrackingController.issuePublisherLink(sessionId);
        }
        System.runAs(person('publisher')) {
            Long nowMs = System.now().getTime();
            List<List<Decimal>> invalidSamples = new List<List<Decimal>>{
                new List<Decimal>{ null, -122.4500, 5 },
                new List<Decimal>{ 91, -122.4500, 5 },
                new List<Decimal>{ -91, -122.4500, 5 },
                new List<Decimal>{ 37.7700, null, 5 },
                new List<Decimal>{ 37.7700, 181, 5 },
                new List<Decimal>{ 37.7700, -181, 5 },
                new List<Decimal>{ 37.7700, -122.4500, null },
                new List<Decimal>{ 37.7700, -122.4500, -1 },
                new List<Decimal>{ 37.7700, -122.4500, 100000000 }
            };
            for (List<Decimal> sample : invalidSamples) {
                Boolean rejected = false;
                try {
                    TechnicianGpsInvitationController.publishLocation(grant.token, sample[0], sample[1], sample[2], nowMs);
                } catch (AuraHandledException error) {
                    rejected = true;
                }
                System.assert(rejected, 'GPS ranges and accuracy must be checked on the server.');
            }
            for (Long invalidTime : new List<Long>{ null, nowMs - 180000, nowMs + 120000 }) {
                Boolean rejected = false;
                try {
                    TechnicianGpsInvitationController.publishLocation(grant.token, 37.7700, -122.4500, 5, invalidTime);
                } catch (AuraHandledException error) {
                    rejected = true;
                }
                System.assert(rejected, 'Missing, stale or future timestamps must be rejected.');
            }
            TechnicianGpsInvitationController.publishLocation(grant.token, 37.7710, -122.4230, 5, nowMs - 10000);
            System.assertEquals(0, [
                SELECT count() FROM Technician_Tracking_Session__c WHERE Id = :sessionId
            ], 'Publishing with an invitation must not grant direct access to the private session.');
        }
        Long savedCapturedAtMs;
        Long savedReceivedAtMs;
        // Only the owner can read the private session. Capture the persisted receipt
        // through the viewer API, then switch back to the unprivileged publisher.
        System.runAs(person('owner')) {
            TechnicianTrackingSnapshot stored = TechnicianLiveTrackingController.getSession(sessionId);
            System.assertNotEquals(null, stored.capturedAtMs);
            System.assertNotEquals(null, stored.receivedAtMs);
            savedCapturedAtMs = stored.capturedAtMs;
            savedReceivedAtMs = stored.receivedAtMs;
        }
        System.runAs(person('publisher')) {
            TechnicianPublisherStatus older = TechnicianGpsInvitationController.publishLocation(
                grant.token, 37.6700, -122.6500, 10, savedCapturedAtMs - 5000
            );
            System.assertEquals(savedCapturedAtMs, older.acceptedCapturedAtMs);
            System.assertEquals(savedReceivedAtMs, older.receivedAtMs);
            TechnicianPublisherStatus duplicate = TechnicianGpsInvitationController.publishLocation(
                grant.token, 37.5700, -122.7500, 10, savedCapturedAtMs
            );
            System.assertEquals(savedReceivedAtMs, duplicate.receivedAtMs);
        }
        System.runAs(person('owner')) {
            TechnicianTrackingSnapshot unchanged = TechnicianLiveTrackingController.getSession(sessionId);
            System.assertEquals(37.7710, unchanged.latitude);
            System.assertEquals(-122.4230, unchanged.longitude);
            System.assertEquals(5, unchanged.accuracy);
            System.assertEquals(savedCapturedAtMs, unchanged.capturedAtMs);
            System.assertEquals(savedReceivedAtMs, unchanged.receivedAtMs);
            System.assertEquals(1, [SELECT count() FROM Technician_Tracking_Session__c]);
        }
    }
}
