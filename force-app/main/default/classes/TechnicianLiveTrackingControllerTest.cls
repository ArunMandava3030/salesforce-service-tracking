@IsTest
private class TechnicianLiveTrackingControllerTest {
    @TestSetup
    static void setUpUsers() {
        String uniqueSuffix = UserInfo.getOrganizationId() + '.' + String.valueOf(System.now().getTime());
        List<User> users = new List<User>();
        for (String role : new List<String>{ 'owner', 'other' }) {
            users.add(new User(
                Alias = role == 'owner' ? 'gpsown' : 'gpsother',
                Email = 'tracking-poc-' + role + '@example.invalid',
                EmailEncodingKey = 'UTF-8',
                LastName = 'Tracking POC ' + role,
                LanguageLocaleKey = 'en_US',
                LocaleSidKey = 'en_US',
                ProfileId = UserInfo.getProfileId(),
                TimeZoneSidKey = 'Asia/Kolkata',
                Username = 'tracking-poc-' + role + '.' + uniqueSuffix + '@example.invalid'
            ));
        }
        insert users;
        Id permissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'Technician_Live_Tracking_POC' LIMIT 1].Id;
        List<PermissionSetAssignment> assignments = new List<PermissionSetAssignment>();
        for (User person : users) {
            assignments.add(new PermissionSetAssignment(AssigneeId = person.Id, PermissionSetId = permissionSetId));
        }
        insert assignments;
    }

    private static User testUser(String role) {
        String email = 'tracking-poc-' + role + '@example.invalid';
        String lastName = 'Tracking POC ' + role;
        return [SELECT Id FROM User WHERE Email = :email AND LastName = :lastName LIMIT 1];
    }

    @IsTest
    static void sharesLatestPhoneSampleWithLaptopAndStops() {
        System.runAs(testUser('owner')) {
            Test.startTest();
            TechnicianTrackingSnapshot created = TechnicianLiveTrackingController.createSession();
            System.assertEquals(true, created.active);
            System.assertEquals(false, created.expired);
            System.assertEquals(37.7749, created.customerLatitude);
            System.assertEquals(-122.4194, created.customerLongitude);
            System.assertEquals(null, created.latitude);
            System.assert(created.expiresAtMs > System.now().addMinutes(119).getTime());
            System.assert(created.publisherUrl.startsWith('https://'));
            System.assert(created.publisherUrl.endsWith('/apex/TechnicianGpsPublisher?sessionId=' + created.sessionId));
            System.assert(created.mapPageUrl.endsWith('/apex/TechnicianLiveMap'));

            Long sampleTime = System.now().addSeconds(-10).getTime();
            TechnicianLiveTrackingController.publishLocation(created.sessionId, 37.7600001, -122.4299999, 7.25, sampleTime);
            TechnicianTrackingSnapshot laptop = TechnicianLiveTrackingController.getSession(created.sessionId);
            System.assertEquals(37.7600001, laptop.latitude);
            System.assertEquals(-122.4299999, laptop.longitude);
            System.assertEquals(7.25, laptop.accuracy);
            System.assertNotEquals(null, laptop.receivedAtMs);
            System.assertEquals(laptop.latitude, TechnicianLiveTrackingController.getPhoneSession(created.sessionId).latitude);

            // A second phone sample replaces the first on the same record.
            TechnicianLiveTrackingController.publishLocation(created.sessionId, 37.7650001, -122.4249999, 5, System.now().getTime());
            System.assertEquals(37.7650001, TechnicianLiveTrackingController.getSession(created.sessionId).latitude);
            System.assertEquals(1, [SELECT count() FROM Technician_Tracking_Session__c]);

            TechnicianTrackingSnapshot stopped = TechnicianLiveTrackingController.stopSharing(created.sessionId);
            System.assertEquals(false, stopped.active);
            System.assertEquals(false, TechnicianLiveTrackingController.endSession(created.sessionId).active);
            Boolean rejected = false;
            try {
                TechnicianLiveTrackingController.publishLocation(created.sessionId, 37.7700, -122.4300, 5, System.now().getTime());
            } catch (AuraHandledException error) {
                rejected = true;
                System.assert(error.getMessage().contains('ended or expired'));
            }
            System.assert(rejected, 'A stopped session must reject later phone samples.');
            Test.stopTest();
        }
    }

    @IsTest
    static void ignoresOutOfOrderAndDuplicateSamples() {
        System.runAs(testUser('owner')) {
            String sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            Long sampleTime = System.now().addSeconds(-10).getTime();
            TechnicianLiveTrackingController.publishLocation(sessionId, 37.7710, -122.4250, 5, sampleTime);
            TechnicianTrackingSnapshot saved = TechnicianLiveTrackingController.getSession(sessionId);

            TechnicianTrackingSnapshot older = TechnicianLiveTrackingController.publishLocation(
                sessionId, 37.6700, -122.5500, 20, saved.capturedAtMs - 5000
            );
            System.assertEquals(37.7710, older.latitude, 'An older sample must not move the marker backwards.');
            System.assertEquals(saved.receivedAtMs, older.receivedAtMs);

            TechnicianTrackingSnapshot duplicate = TechnicianLiveTrackingController.publishLocation(
                sessionId, 37.5700, -122.6500, 25, saved.capturedAtMs
            );
            System.assertEquals(37.7710, duplicate.latitude);
            System.assertEquals(-122.4250, TechnicianLiveTrackingController.getSession(sessionId).longitude);
        }
    }

    @IsTest
    static void rejectsInvalidGpsAndClockValues() {
        System.runAs(testUser('owner')) {
            String sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            Long nowMs = System.now().getTime();
            List<List<Decimal>> badCoordinates = new List<List<Decimal>>{
                new List<Decimal>{ null, -122.4500, 5 },
                new List<Decimal>{ 91, -122.4500, 5 },
                new List<Decimal>{ -91, -122.4500, 5 },
                new List<Decimal>{ 37.7700, null, 5 },
                new List<Decimal>{ 37.7700, 181, 5 },
                new List<Decimal>{ 37.7700, -181, 5 },
                new List<Decimal>{ 37.7700, -122.4500, -1 },
                new List<Decimal>{ 37.7700, -122.4500, null },
                new List<Decimal>{ 37.7700, -122.4500, 100000000 }
            };
            for (List<Decimal> sample : badCoordinates) {
                Boolean rejected = false;
                try {
                    TechnicianLiveTrackingController.publishLocation(sessionId, sample[0], sample[1], sample[2], nowMs);
                } catch (AuraHandledException error) {
                    rejected = true;
                }
                System.assert(rejected, 'Invalid coordinates and accuracy must be rejected.');
            }
            for (Long timestamp : new List<Long>{ null, nowMs - 180000, nowMs + 120000 }) {
                Boolean rejected = false;
                try {
                    TechnicianLiveTrackingController.publishLocation(sessionId, 37.7700, -122.4500, 5, timestamp);
                } catch (AuraHandledException error) {
                    rejected = true;
                    System.assert(error.getMessage().contains('GPS sample'));
                }
                System.assert(rejected, 'Missing, stale and future timestamps must be rejected.');
            }
            System.assertEquals(null, TechnicianLiveTrackingController.getSession(sessionId).latitude);
        }
    }

    @IsTest
    static void expiredSessionCannotPublish() {
        System.runAs(testUser('owner')) {
            String sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            update new Technician_Tracking_Session__c(Id = sessionId, Expires_At__c = System.now().addSeconds(-1));
            TechnicianTrackingSnapshot expired = TechnicianLiveTrackingController.getSession(sessionId);
            System.assertEquals(true, expired.expired);
            System.assertEquals(false, expired.active);
            Boolean rejected = false;
            try {
                TechnicianLiveTrackingController.publishLocation(sessionId, 37.7700, -122.4500, 5, System.now().getTime());
            } catch (AuraHandledException error) {
                rejected = true;
            }
            System.assert(rejected, 'Expired sessions must reject phone updates.');
        }
    }

    @IsTest
    static void ownerCheckProtectsReadsWritesAndStopEvenForPrivilegedUsers() {
        String sessionId;
        System.runAs(testUser('owner')) {
            sessionId = TechnicianLiveTrackingController.createSession().sessionId;
        }
        System.runAs(testUser('other')) {
            for (String operation : new List<String>{ 'read', 'phone', 'publish', 'stop' }) {
                Boolean rejected = false;
                try {
                    if (operation == 'read') {
                        TechnicianLiveTrackingController.getSession(sessionId);
                    } else if (operation == 'phone') {
                        TechnicianLiveTrackingController.getPhoneSession(sessionId);
                    } else if (operation == 'publish') {
                        TechnicianLiveTrackingController.publishLocation(sessionId, 37.7700, -122.4500, 5, System.now().getTime());
                    } else {
                        TechnicianLiveTrackingController.stopSharing(sessionId);
                    }
                } catch (AuraHandledException error) {
                    rejected = true;
                    System.assert(error.getMessage().contains('same Salesforce user'));
                }
                System.assert(rejected, 'Another user must not ' + operation + ' a session.');
            }
        }
        System.runAs(testUser('owner')) {
            System.assertEquals(true, TechnicianLiveTrackingController.getSession(sessionId).active);
        }
    }

    @IsTest
    static void rejectsMalformedAndWrongObjectIds() {
        System.runAs(testUser('owner')) {
            for (String badId : new List<String>{ null, '', 'not-a-salesforce-id', UserInfo.getUserId() }) {
                Boolean rejected = false;
                try {
                    TechnicianLiveTrackingController.getSession(badId);
                } catch (AuraHandledException error) {
                    rejected = true;
                    System.assert(error.getMessage().contains('link is invalid'));
                }
                System.assert(rejected, 'Malformed and non-session IDs must produce a readable error.');
            }
        }
    }
}
