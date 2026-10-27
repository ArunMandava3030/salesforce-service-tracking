@IsTest
private class TechnicianCustomerTrackingControllerTest {
    private static final String MAP_KEY = 'DEMO_BROWSER_KEY_NOT_A_CREDENTIAL_12345';

    @TestSetup
    static void setUpUsers() {
        Id limitedProfile = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1].Id;
        String suffix = UserInfo.getOrganizationId() + '.' + String.valueOf(System.now().getTime());
        List<User> people = new List<User>();
        for (String role : new List<String>{ 'owner', 'client', 'otheradmin' }) {
            people.add(new User(
                Alias = 'gpscust', Email = 'gps-customer-' + role + '@example.invalid',
                EmailEncodingKey = 'UTF-8', LastName = 'GPS Customer ' + role,
                LanguageLocaleKey = 'en_US', LocaleSidKey = 'en_US',
                ProfileId = role == 'client' ? limitedProfile : UserInfo.getProfileId(),
                TimeZoneSidKey = 'America/Los_Angeles',
                Username = 'gps-customer-' + role + '.' + suffix + '@example.invalid'
            ));
        }
        insert people;
        Id permissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'Technician_Live_Tracking_POC' LIMIT 1].Id;
        insert new List<PermissionSetAssignment>{
            new PermissionSetAssignment(AssigneeId = people[0].Id, PermissionSetId = permissionSetId),
            new PermissionSetAssignment(AssigneeId = people[2].Id, PermissionSetId = permissionSetId)
        };
    }

    private static User person(String role) {
        String email = 'gps-customer-' + role + '@example.invalid';
        return [SELECT Id FROM User WHERE Email = :email LIMIT 1];
    }

    private static void assertCustomerRejected(String token) {
        Boolean rejected = false;
        try {
            TechnicianCustomerTrackingController.getTracking(token);
        } catch (AuraHandledException error) {
            rejected = true;
            System.assertEquals(
                'This customer link is invalid, expired, or revoked. Ask the session owner for a new link.',
                error.getMessage()
            );
        }
        System.assert(rejected, 'Invalid customer capabilities must never reveal a session.');
    }

    private static void assertPublisherRejected(String token) {
        for (String action : new List<String>{ 'status', 'directions', 'publish', 'stop' }) {
            Boolean rejected = false;
            try {
                if (action == 'status') {
                    TechnicianGpsInvitationController.getPublisherStatus(token);
                } else if (action == 'directions') {
                    TechnicianGpsInvitationController.getDirections(token);
                } else if (action == 'publish') {
                    TechnicianGpsInvitationController.publishLocation(token, 37.7710, -122.4230, 5, System.now().getTime());
                } else {
                    TechnicianGpsInvitationController.stopPublishing(token);
                }
            } catch (AuraHandledException error) {
                rejected = true;
            }
            System.assert(rejected, 'A customer or invalid token must not authorize publisher ' + action + '.');
        }
    }

    @IsTest
    static void ownerConfiguresPhoneDestinationOnly() {
        System.runAs(person('owner')) {
            TechnicianTrackingSnapshot created = TechnicianLiveTrackingController.createSession();
            System.assertEquals(null, created.browserMapsKey);
            System.assertEquals(false, created.customerInviteActive);
            System.assertEquals(null, TechnicianLiveTrackingController.getPhoneDirections(created.sessionId).browserMapsKey);
            TechnicianTrackingSnapshot configured = TechnicianLiveTrackingController.configureMaps(created.sessionId, MAP_KEY);
            System.assertEquals(MAP_KEY, configured.browserMapsKey);
            System.assertEquals(MAP_KEY, TechnicianLiveTrackingController.getSession(created.sessionId).browserMapsKey);
            TechnicianDirectionsConfig directions = TechnicianLiveTrackingController.getPhoneDirections(created.sessionId);
            System.assertEquals(37.7749, directions.customerLatitude);
            System.assertEquals(-122.4194, directions.customerLongitude);
            System.assertEquals(MAP_KEY, directions.browserMapsKey);
            System.assertEquals(true, directions.active);
            System.assertEquals(created.expiresAtMs, directions.expiresAtMs);
            Map<String, Object> exposed = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(directions));
            System.assertEquals(new Set<String>{
                'customerLatitude', 'customerLongitude', 'browserMapsKey', 'active', 'expiresAtMs'
            }, exposed.keySet(), 'Phone configuration must not include technician GPS, IDs or invitation secrets.');
        }
    }

    @IsTest
    static void browserKeyValidationPreservesValue() {
        System.runAs(person('owner')) {
            String sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            TechnicianLiveTrackingController.configureMaps(sessionId, MAP_KEY);
            for (String invalid : new List<String>{
                null, '', 'short-key', 'a'.repeat(19), 'a'.repeat(201),
                ' ' + MAP_KEY, MAP_KEY + ' ', MAP_KEY + '\n', MAP_KEY + '<script>',
                'https://example.invalid/key', MAP_KEY + '\u00E9'
            }) {
                Boolean rejected = false;
                try {
                    TechnicianLiveTrackingController.configureMaps(sessionId, invalid);
                } catch (AuraHandledException error) {
                    rejected = true;
                }
                System.assert(rejected, 'Only 20-200 URL-safe ASCII key characters are accepted.');
            }
            System.assertEquals(MAP_KEY, TechnicianLiveTrackingController.getSession(sessionId).browserMapsKey);
            System.assertEquals('a'.repeat(20), TechnicianLiveTrackingController.configureMaps(sessionId, 'a'.repeat(20)).browserMapsKey);
            System.assertEquals('a'.repeat(200), TechnicianLiveTrackingController.configureMaps(sessionId, 'a'.repeat(200)).browserMapsKey);
        }
    }

    @IsTest
    static void customerReadsLatestWithoutObjectCrud() {
        String sessionId;
        TechnicianPublisherGrant customer;
        TechnicianPublisherGrant publisher;
        System.runAs(person('owner')) {
            sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            TechnicianLiveTrackingController.configureMaps(sessionId, MAP_KEY);
            customer = TechnicianLiveTrackingController.issueCustomerLink(sessionId);
            publisher = TechnicianLiveTrackingController.issuePublisherLink(sessionId);
            System.assertEquals(true, TechnicianLiveTrackingController.getSession(sessionId).customerInviteActive);
            Technician_Tracking_Session__c stored = [
                SELECT Customer_Token_Hash__c, Publisher_Token_Hash__c FROM Technician_Tracking_Session__c WHERE Id = :sessionId
            ];
            String expectedHash = EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', Blob.valueOf(customer.token)));
            System.assert(stored.Customer_Token_Hash__c == expectedHash);
            System.assert(stored.Customer_Token_Hash__c != customer.token, 'Persist only a digest.');
            System.assert(stored.Customer_Token_Hash__c != stored.Publisher_Token_Hash__c);
            String ownerResponse = JSON.serialize(TechnicianLiveTrackingController.getSession(sessionId));
            System.assert(!ownerResponse.contains(customer.token) && !ownerResponse.contains(expectedHash));
        }
        System.runAs(person('client')) {
            System.assertEquals(false, Technician_Tracking_Session__c.SObjectType.getDescribe().isAccessible());
            System.assertEquals(false, Technician_Tracking_Session__c.SObjectType.getDescribe().isCreateable());
            System.assertEquals(false, Technician_Tracking_Session__c.SObjectType.getDescribe().isUpdateable());
            TechnicianCustomerSnapshot waiting = TechnicianCustomerTrackingController.getTracking(customer.token.toUpperCase());
            System.assertEquals(null, waiting.latitude);
            System.assertEquals(true, waiting.active);
            System.assertEquals(customer.expiresAtMs, waiting.expiresAtMs);
            TechnicianDirectionsConfig directions = TechnicianGpsInvitationController.getDirections(publisher.token);
            System.assertEquals(MAP_KEY, directions.browserMapsKey);
            System.assertEquals(37.7749, directions.customerLatitude);
            System.assertEquals(-122.4194, directions.customerLongitude);
            TechnicianGpsInvitationController.publishLocation(publisher.token, 37.7712345, -122.4223457, 7.25, System.now().addSeconds(-10).getTime());
            TechnicianCustomerSnapshot first = TechnicianCustomerTrackingController.getTracking(customer.token);
            System.assertEquals(37.7712345, first.latitude);
            System.assertEquals(-122.4223457, first.longitude);
            System.assertEquals(7.25, first.accuracy);
            System.assertNotEquals(null, first.capturedAtMs);
            System.assertNotEquals(null, first.receivedAtMs);
            System.assertEquals(MAP_KEY, first.browserMapsKey);
            Map<String, Object> exposed = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(first));
            System.assertEquals(new Set<String>{
                'active', 'expiresAtMs', 'customerLatitude', 'customerLongitude', 'latitude', 'longitude',
                'accuracy', 'capturedAtMs', 'receivedAtMs', 'browserMapsKey'
            }, exposed.keySet(), 'Customer response must not expose IDs, owner data or publisher credentials.');
            TechnicianGpsInvitationController.publishLocation(publisher.token, 37.7715, -122.4222, 5, System.now().getTime());
            System.assertEquals(37.7715, TechnicianCustomerTrackingController.getTracking(customer.token).latitude);
            System.assertEquals(0, [SELECT count() FROM Technician_Tracking_Session__c WHERE Id = :sessionId], 'Capability reads do not grant direct object access.');
        }
        System.runAs(person('owner')) {
            System.assertEquals(1, [SELECT count() FROM Technician_Tracking_Session__c]);
        }
    }

    @IsTest
    static void tokenPurposesRemainSeparate() {
        String sessionId;
        TechnicianPublisherGrant customer;
        TechnicianPublisherGrant publisher;
        System.runAs(person('owner')) {
            sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            customer = TechnicianLiveTrackingController.issueCustomerLink(sessionId);
            publisher = TechnicianLiveTrackingController.issuePublisherLink(sessionId);
        }
        System.runAs(person('client')) {
            assertCustomerRejected(publisher.token);
            assertPublisherRejected(customer.token);
            assertCustomerRejected(sessionId);
            System.assertEquals(false, TechnicianGpsInvitationController.stopPublishing(publisher.token).active);
            System.assertEquals(true, TechnicianCustomerTrackingController.getTracking(customer.token).active, 'Stopping phone publishing does not expand or revoke a separate customer capability.');
        }
        System.runAs(person('owner')) {
            System.assertEquals(true, TechnicianLiveTrackingController.getSession(sessionId).active);
        }
    }

    @IsTest
    static void customerRotationRevocationAndIsolation() {
        String firstId;
        String secondId;
        TechnicianPublisherGrant oldCustomer;
        TechnicianPublisherGrant newCustomer;
        TechnicianPublisherGrant secondCustomer;
        TechnicianPublisherGrant publisher;
        System.runAs(person('owner')) {
            firstId = TechnicianLiveTrackingController.createSession().sessionId;
            secondId = TechnicianLiveTrackingController.createSession().sessionId;
            TechnicianLiveTrackingController.configureMaps(firstId, MAP_KEY);
            TechnicianLiveTrackingController.configureMaps(secondId, 'b'.repeat(20));
            oldCustomer = TechnicianLiveTrackingController.issueCustomerLink(firstId);
            newCustomer = TechnicianLiveTrackingController.issueCustomerLink(firstId);
            secondCustomer = TechnicianLiveTrackingController.issueCustomerLink(secondId);
            publisher = TechnicianLiveTrackingController.issuePublisherLink(firstId);
            System.assert(oldCustomer.token != newCustomer.token);
        }
        System.runAs(person('client')) {
            assertCustomerRejected(oldCustomer.token);
            TechnicianGpsInvitationController.publishLocation(publisher.token, 37.7710, -122.4230, 5, System.now().getTime());
            System.assertEquals(MAP_KEY, TechnicianCustomerTrackingController.getTracking(newCustomer.token).browserMapsKey);
            System.assertEquals(null, TechnicianCustomerTrackingController.getTracking(secondCustomer.token).latitude);
            System.assertEquals('b'.repeat(20), TechnicianCustomerTrackingController.getTracking(secondCustomer.token).browserMapsKey);
        }
        System.runAs(person('owner')) {
            TechnicianTrackingSnapshot revoked = TechnicianLiveTrackingController.revokeCustomerLink(firstId);
            System.assertEquals(false, revoked.customerInviteActive);
            System.assertEquals(true, revoked.publisherInviteActive);
            System.assertEquals(true, revoked.active);
            System.assertEquals(false, TechnicianLiveTrackingController.revokeCustomerLink(firstId).customerInviteActive);
        }
        System.runAs(person('client')) {
            assertCustomerRejected(newCustomer.token);
            System.assertEquals(true, TechnicianCustomerTrackingController.getTracking(secondCustomer.token).active);
            System.assertEquals(true, TechnicianGpsInvitationController.getDirections(publisher.token).active);
        }
    }

    @IsTest
    static void ownerChecksIncludeConfiguration() {
        String sessionId;
        System.runAs(person('owner')) {
            sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            TechnicianLiveTrackingController.configureMaps(sessionId, MAP_KEY);
            TechnicianLiveTrackingController.issueCustomerLink(sessionId);
        }
        for (String role : new List<String>{ 'client', 'otheradmin' }) {
            System.runAs(person(role)) {
                for (String action : new List<String>{ 'configure', 'issue', 'revoke', 'phoneDirections', 'helperIssue', 'helperRevoke', 'helperState' }) {
                    Boolean rejected = false;
                    try {
                        if (action == 'configure') {
                            TechnicianLiveTrackingController.configureMaps(sessionId, 'c'.repeat(20));
                        } else if (action == 'issue') {
                            TechnicianLiveTrackingController.issueCustomerLink(sessionId);
                        } else if (action == 'revoke') {
                            TechnicianLiveTrackingController.revokeCustomerLink(sessionId);
                        } else if (action == 'phoneDirections') {
                            TechnicianLiveTrackingController.getPhoneDirections(sessionId);
                        } else if (action == 'helperIssue') {
                            TechnicianCustomerAccess.issueForOwner(Id.valueOf(sessionId));
                        } else if (action == 'helperRevoke') {
                            TechnicianCustomerAccess.revokeForOwner(Id.valueOf(sessionId));
                        } else {
                            TechnicianCustomerAccess.isInviteActiveForOwner(Id.valueOf(sessionId));
                        }
                    } catch (AuraHandledException error) {
                        rejected = true;
                    }
                    System.assert(rejected, 'Only the owner can use ' + action + '.');
                }
            }
        }
        System.runAs(person('owner')) {
            System.assertEquals(MAP_KEY, TechnicianLiveTrackingController.getSession(sessionId).browserMapsKey);
            System.assertEquals(true, TechnicianLiveTrackingController.getSession(sessionId).customerInviteActive);
        }
    }

    @IsTest
    static void malformedCustomerCapabilitiesFail() {
        String sessionId;
        TechnicianPublisherGrant grant;
        String storedHash;
        System.runAs(person('owner')) {
            sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            grant = TechnicianLiveTrackingController.issueCustomerLink(sessionId);
            storedHash = [SELECT Customer_Token_Hash__c FROM Technician_Tracking_Session__c WHERE Id = :sessionId].Customer_Token_Hash__c;
            for (Id wrongId : new List<Id>{ null, UserInfo.getUserId() }) {
                Boolean rejected = false;
                try {
                    TechnicianCustomerAccess.issueForOwner(wrongId);
                } catch (AuraHandledException error) {
                    rejected = true;
                }
                System.assert(rejected);
            }
        }
        System.runAs(person('client')) {
            for (String invalid : new List<String>{
                null, '', sessionId, storedHash, grant.token.substring(1), grant.token.substring(0, 63) + '!',
                EncodingUtil.convertToHex(Crypto.generateAesKey(256))
            }) {
                assertCustomerRejected(invalid);
            }
        }
    }

    @IsTest
    static void endingRemovesKeysAndBothCapabilities() {
        String sessionId;
        TechnicianPublisherGrant customer;
        TechnicianPublisherGrant publisher;
        System.runAs(person('owner')) {
            sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            TechnicianLiveTrackingController.configureMaps(sessionId, MAP_KEY);
            customer = TechnicianLiveTrackingController.issueCustomerLink(sessionId);
            publisher = TechnicianLiveTrackingController.issuePublisherLink(sessionId);
            TechnicianTrackingSnapshot ended = TechnicianLiveTrackingController.endSession(sessionId);
            System.assertEquals(false, ended.active);
            System.assertEquals(false, ended.customerInviteActive);
            System.assertEquals(false, ended.publisherInviteActive);
            System.assertEquals(null, ended.browserMapsKey);
            Technician_Tracking_Session__c stored = [
                SELECT Customer_Token_Hash__c, Publisher_Token_Hash__c, Maps_Browser_Key__c
                FROM Technician_Tracking_Session__c WHERE Id = :sessionId
            ];
            System.assertEquals(null, stored.Customer_Token_Hash__c);
            System.assertEquals(null, stored.Publisher_Token_Hash__c);
            System.assertEquals(null, stored.Maps_Browser_Key__c);
        }
        System.runAs(person('client')) {
            assertCustomerRejected(customer.token);
            assertPublisherRejected(publisher.token);
        }
    }

    @IsTest
    static void expiredAndInactiveSessionsRejectUse() {
        System.runAs(person('owner')) {
            for (String closedState : new List<String>{ 'expired', 'inactive' }) {
                String sessionId = TechnicianLiveTrackingController.createSession().sessionId;
                TechnicianLiveTrackingController.configureMaps(sessionId, MAP_KEY);
                TechnicianPublisherGrant customer = TechnicianLiveTrackingController.issueCustomerLink(sessionId);
                TechnicianPublisherGrant publisher = TechnicianLiveTrackingController.issuePublisherLink(sessionId);
                Technician_Tracking_Session__c closed = new Technician_Tracking_Session__c(Id = sessionId);
                if (closedState == 'expired') {
                    closed.Expires_At__c = System.now().addSeconds(-1);
                } else {
                    closed.Active__c = false;
                }
                update closed;
                assertCustomerRejected(customer.token);
                assertPublisherRejected(publisher.token);
                for (String action : new List<String>{ 'configure', 'issue', 'directions' }) {
                    Boolean rejected = false;
                    try {
                        if (action == 'configure') {
                            TechnicianLiveTrackingController.configureMaps(sessionId, MAP_KEY);
                        } else if (action == 'issue') {
                            TechnicianLiveTrackingController.issueCustomerLink(sessionId);
                        } else {
                            TechnicianLiveTrackingController.getPhoneDirections(sessionId);
                        }
                    } catch (AuraHandledException error) {
                        rejected = true;
                    }
                    System.assert(rejected, 'Closed sessions must reject ' + action + '.');
                }
                System.assertEquals(false, TechnicianLiveTrackingController.getSession(sessionId).customerInviteActive);
                System.assertEquals(null, TechnicianLiveTrackingController.endSession(sessionId).browserMapsKey);
            }
        }
    }
}
