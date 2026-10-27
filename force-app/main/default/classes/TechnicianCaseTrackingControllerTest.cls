@IsTest
private class TechnicianCaseTrackingControllerTest {
    private static final String MAP_KEY = 'DEMO_BROWSER_KEY_NOT_A_CREDENTIAL_12345';

    @TestSetup
    static void usersAndPermissions() {
        Id profileId = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1].Id;
        String suffix = UserInfo.getOrganizationId() + '.' + System.now().getTime();
        List<User> people = new List<User>();
        for (String role : new List<String>{ 'owner', 'viewer', 'recipient', 'nocase', 'nofields' }) {
            people.add(new User(
                Alias = 'casetrk', Email = 'case-tracking-' + role + '@example.invalid',
                LastName = 'Case Tracking ' + role, Username = 'case-tracking-' + role + '.' + suffix + '@example.invalid',
                EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US', LocaleSidKey = 'en_US',
                TimeZoneSidKey = 'Asia/Kolkata', ProfileId = profileId
            ));
        }
        insert people;
        Id ownerPermission = [SELECT Id FROM PermissionSet WHERE Name = 'Technician_Live_Tracking_POC' LIMIT 1].Id;
        PermissionSet noCase = new PermissionSet(Name = 'CaseTrackingNoCaseTest', Label = 'Case tracking test without Case access');
        PermissionSet noFields = new PermissionSet(Name = 'CaseTrackingNoFieldsTest', Label = 'Case tracking test without tracking field access');
        insert new List<PermissionSet>{ noCase, noFields };
        Id capability = [SELECT Id FROM CustomPermission WHERE DeveloperName = 'View_Case_Technician_Tracking' LIMIT 1].Id;
        insert new List<SetupEntityAccess>{
            new SetupEntityAccess(ParentId = noCase.Id, SetupEntityId = capability),
            new SetupEntityAccess(ParentId = noFields.Id, SetupEntityId = capability)
        };
        insert new List<ObjectPermissions>{
            new ObjectPermissions(ParentId = noFields.Id, SObjectType = 'Case', PermissionsRead = true),
            new ObjectPermissions(ParentId = noFields.Id, SObjectType = 'Technician_Tracking_Session__c', PermissionsRead = true)
        };
        insert new List<FieldPermissions>{
            new FieldPermissions(ParentId = noFields.Id, SObjectType = 'Case', Field = 'Case.Subject', PermissionsRead = true),
            new FieldPermissions(ParentId = noFields.Id, SObjectType = 'Technician_Tracking_Session__c',
                Field = 'Technician_Tracking_Session__c.Case__c', PermissionsRead = true)
        };
        insert new List<PermissionSetAssignment>{
            new PermissionSetAssignment(AssigneeId = people[0].Id, PermissionSetId = ownerPermission),
            new PermissionSetAssignment(AssigneeId = people[1].Id, PermissionSetId = ownerPermission),
            new PermissionSetAssignment(AssigneeId = people[3].Id, PermissionSetId = noCase.Id),
            new PermissionSetAssignment(AssigneeId = people[4].Id, PermissionSetId = noFields.Id)
        };
    }

    private static User person(String role) {
        String email = 'case-tracking-' + role + '@example.invalid';
        return [SELECT Id FROM User WHERE Email = :email LIMIT 1];
    }

    private static Case makeCase(String subject) {
        Case item = new Case(Subject = subject, Origin = 'Phone', Status = 'New', OwnerId = person('owner').Id);
        insert item;
        return [SELECT Id, CaseNumber, Subject FROM Case WHERE Id = :item.Id];
    }

    private static void allowCase(Case item, User viewer) {
        Boolean visible;
        System.runAs(viewer) {
            visible = ![SELECT Id FROM Case WHERE Id = :item.Id WITH USER_MODE].isEmpty();
        }
        // A public Case OWD already grants this read; otherwise create an explicit Case share.
        if (!visible) {
            insert new CaseShare(CaseId = item.Id, UserOrGroupId = viewer.Id, CaseAccessLevel = 'Read', RowCause = 'Manual');
        }
        System.runAs(viewer) {
            System.assertEquals(1, [SELECT count() FROM Case WHERE Id = :item.Id WITH USER_MODE]);
        }
    }

    private static void rejectCaseAction(String action, String caseId, String sessionId) {
        Boolean denied = false;
        try {
            if (action == 'case') TechnicianCaseTrackingController.getCase(caseId);
            else if (action == 'create') TechnicianCaseTrackingController.createCaseSession(caseId);
            else if (action == 'link') TechnicianCaseTrackingController.linkSessionToCase(caseId, sessionId);
            else if (action == 'list') TechnicianCaseTrackingController.listCaseSessions(caseId, null);
            else if (action == 'cursor') TechnicianCaseTrackingController.listCaseSessions(caseId, sessionId);
            else if (action == 'search') TechnicianCaseTrackingController.searchCases(caseId);
            else TechnicianCaseTrackingController.getCaseSession(caseId, sessionId);
        } catch (AuraHandledException error) {
            denied = true;
        }
        System.assert(denied, 'Unauthorized or invalid Case tracking action must fail: ' + action);
    }

    @IsTest
    static void createsCaseSessionsAndPreservesStandaloneFlow() {
        Case item = makeCase('New technician visit');
        System.runAs(person('owner')) {
            TechnicianCaseSummary selected = TechnicianCaseTrackingController.getCase(item.Id);
            System.assertEquals(item.CaseNumber, selected.caseNumber);
            System.assertEquals(item.Subject, selected.subject);
            TechnicianTrackingSnapshot created = TechnicianCaseTrackingController.createCaseSession(item.Id);
            System.assertEquals(item.Id, created.caseId);
            System.assertEquals(item.CaseNumber, created.caseNumber);
            System.assertEquals(true, created.canManage);
            System.assertEquals(true, created.active);
            System.assertEquals(null, created.endedAtMs);
            System.assertNotEquals(null, created.sessionName);
            System.assertNotEquals(null, created.ownerName);
            System.assertNotEquals(null, created.createdAtMs);
            System.assertNotEquals(null, created.publisherUrl);
            System.assertEquals(37.7749, created.customerLatitude);
            System.assertEquals(-122.4194, created.customerLongitude);
            System.assertEquals(created.sessionId, TechnicianCaseTrackingController.getCaseSession(item.Id, created.sessionId).sessionId);
            TechnicianTrackingSnapshot standalone = TechnicianLiveTrackingController.createSession();
            System.assertEquals(null, standalone.caseId);
            System.assertEquals(null, standalone.caseNumber);
            System.assertEquals(true, standalone.canManage);
            System.assertEquals(1, TechnicianCaseTrackingController.listCaseSessions(item.Id, null).sessions.size());
        }
    }

    @IsTest
    static void caseAgentsReadWithoutReceivingPrivateSessionAccess() {
        Case item = makeCase('Shared technician visit');
        User viewer = person('viewer');
        allowCase(item, viewer);
        String sessionId;
        System.runAs(person('owner')) {
            sessionId = TechnicianCaseTrackingController.createCaseSession(item.Id).sessionId;
            TechnicianLiveTrackingController.configureMaps(sessionId, MAP_KEY);
            TechnicianLiveTrackingController.publishLocation(sessionId, 37.7740, -122.4160, 4, System.now().getTime());
            TechnicianLiveTrackingController.issuePublisherLink(sessionId);
            TechnicianLiveTrackingController.issueCustomerLink(sessionId);
        }
        System.runAs(viewer) {
            System.assertEquals(0, [SELECT count() FROM Technician_Tracking_Session__c WHERE Id = :sessionId WITH USER_MODE],
                'Case viewing must not share the private session record.');
            TechnicianTrackingSnapshot viewed = TechnicianCaseTrackingController.getCaseSession(item.Id, sessionId);
            System.assertEquals(false, viewed.canManage);
            System.assertEquals(item.Id, viewed.caseId);
            System.assertEquals(37.7740, viewed.latitude);
            System.assertEquals(-122.4160, viewed.longitude);
            System.assertEquals(MAP_KEY, viewed.browserMapsKey);
            System.assertNotEquals(null, viewed.mapPageUrl);
            System.assertEquals(null, viewed.publisherUrl);
            System.assertEquals(null, viewed.publisherInviteActive);
            System.assertEquals(null, viewed.customerInviteActive);
            TechnicianTrackingSnapshot row = TechnicianCaseTrackingController.listCaseSessions(item.Id, null).sessions[0];
            System.assertEquals(null, row.browserMapsKey);
            System.assertEquals(null, row.publisherUrl);
            System.assertEquals(null, row.publisherInviteActive);
            System.assertEquals(null, row.customerInviteActive);
            System.assertEquals(false, row.canManage);
            System.assert(!JSON.serialize(viewed).contains('Token_Hash'));
            for (String action : new List<String>{ 'read', 'configure', 'publish', 'end', 'publisher', 'customer' }) {
                Boolean denied = false;
                try {
                    if (action == 'read') TechnicianLiveTrackingController.getSession(sessionId);
                    else if (action == 'configure') TechnicianLiveTrackingController.configureMaps(sessionId, MAP_KEY);
                    else if (action == 'publish') TechnicianLiveTrackingController.publishLocation(sessionId, 0, 0, 1, System.now().getTime());
                    else if (action == 'end') TechnicianLiveTrackingController.endSession(sessionId);
                    else if (action == 'publisher') TechnicianLiveTrackingController.issuePublisherLink(sessionId);
                    else TechnicianLiveTrackingController.issueCustomerLink(sessionId);
                } catch (AuraHandledException error) {
                    denied = true;
                }
                System.assert(denied, 'A Case viewer must not manage another owner\'s session: ' + action);
            }
            rejectCaseAction('link', item.Id, sessionId);
        }
    }

    @IsTest
    static void linkingIsOwnerOnlyAndCannotMoveExistingHistory() {
        Case first = makeCase('First visit');
        Case second = makeCase('Second visit');
        System.runAs(person('owner')) {
            String sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            TechnicianLiveTrackingController.endSession(sessionId);
            TechnicianTrackingSnapshot linked = TechnicianCaseTrackingController.linkSessionToCase(first.Id, sessionId);
            System.assertEquals(first.Id, linked.caseId);
            System.assertEquals(false, linked.active);
            System.assertNotEquals(null, linked.endedAtMs);
            System.assertEquals(first.Id, TechnicianCaseTrackingController.linkSessionToCase(first.Id, sessionId).caseId);
            rejectCaseAction('link', second.Id, sessionId);
            System.assertEquals(first.Id, TechnicianLiveTrackingController.getSession(sessionId).caseId);
            System.assertEquals(1, TechnicianCaseTrackingController.listCaseSessions(first.Id, null).sessions.size());
            System.assertEquals(0, TechnicianCaseTrackingController.listCaseSessions(second.Id, null).sessions.size());
        }
    }

    @IsTest
    static void caseScopeRejectsOtherCasesSessionsAndCursors() {
        Case first = makeCase('Selected Case');
        Case second = makeCase('Different Case');
        System.runAs(person('owner')) {
            String firstSession = TechnicianCaseTrackingController.createCaseSession(first.Id).sessionId;
            String secondSession = TechnicianCaseTrackingController.createCaseSession(second.Id).sessionId;
            String standalone = TechnicianLiveTrackingController.createSession().sessionId;
            for (String wrongSession : new List<String>{ secondSession, standalone, null, 'bad', UserInfo.getUserId() }) {
                rejectCaseAction('detail', first.Id, wrongSession);
            }
            rejectCaseAction('cursor', first.Id, secondSession);
            rejectCaseAction('cursor', first.Id, standalone);
            rejectCaseAction('cursor', first.Id, 'bad');
            rejectCaseAction('cursor', first.Id, first.Id);
            System.assertEquals(firstSession, TechnicianCaseTrackingController.getCaseSession(first.Id, firstSession).sessionId);
        }
    }

    @IsTest
    static void requiresFeatureCaseCrudAndTrackingFieldPermissions() {
        Case item = makeCase('Permission boundary');
        String sessionId;
        System.runAs(person('owner')) {
            sessionId = TechnicianCaseTrackingController.createCaseSession(item.Id).sessionId;
        }
        for (String role : new List<String>{ 'recipient', 'nocase' }) {
            System.runAs(person(role)) {
                System.assertEquals(role == 'nocase', FeatureManagement.checkPermission('View_Case_Technician_Tracking'));
                System.assertEquals(false, Case.SObjectType.getDescribe().isAccessible());
                for (String action : new List<String>{ 'case', 'create', 'link', 'list', 'detail', 'search' }) {
                    rejectCaseAction(action, item.Id, sessionId);
                }
            }
        }
        User noFields = person('nofields');
        allowCase(item, noFields);
        Technician_Tracking_Session__c readOnlyOwnedSession = new Technician_Tracking_Session__c(
            OwnerId = noFields.Id, Active__c = true, Expires_At__c = System.now().addHours(2)
        );
        insert readOnlyOwnedSession;
        System.runAs(noFields) {
            System.assertEquals(item.Id, TechnicianCaseTrackingController.getCase(item.Id).caseId);
            System.assertEquals(true, Technician_Tracking_Session__c.SObjectType.getDescribe().isAccessible());
            System.assertEquals(false, Technician_Tracking_Session__c.Latitude__c.getDescribe().isAccessible());
            System.assertEquals(false, Technician_Tracking_Session__c.SObjectType.getDescribe().isUpdateable());
            rejectCaseAction('list', item.Id, sessionId);
            rejectCaseAction('detail', item.Id, sessionId);
            rejectCaseAction('create', item.Id, sessionId);
            rejectCaseAction('link', item.Id, readOnlyOwnedSession.Id);
        }
        System.assertEquals(null, [SELECT Case__c FROM Technician_Tracking_Session__c WHERE Id = :readOnlyOwnedSession.Id].Case__c,
            'Ownership alone must not permit linking without session edit permission.');
    }

    @IsTest
    static void publicCapabilitiesDoNotAuthorizeCaseViews() {
        Case item = makeCase('Capability boundaries');
        String sessionId;
        TechnicianPublisherGrant customer;
        TechnicianPublisherGrant publisher;
        System.runAs(person('owner')) {
            sessionId = TechnicianCaseTrackingController.createCaseSession(item.Id).sessionId;
            customer = TechnicianLiveTrackingController.issueCustomerLink(sessionId);
            publisher = TechnicianLiveTrackingController.issuePublisherLink(sessionId);
        }
        System.runAs(person('recipient')) {
            String response = JSON.serialize(TechnicianCustomerTrackingController.getTracking(customer.token));
            System.assert(!response.contains('caseId') && !response.contains('caseNumber') && !response.contains('ownerName'));
            System.assertEquals(true, TechnicianGpsInvitationController.getPublisherStatus(publisher.token).active);
            for (String identity : new List<String>{ item.Id, customer.token, publisher.token }) {
                rejectCaseAction('case', identity, sessionId);
                rejectCaseAction('detail', identity, sessionId);
            }
        }
    }

    @IsTest
    static void historyPaginationUsesStableDateAndIdOrder() {
        Case item = makeCase('Many visits');
        Case unrelated = makeCase('Unrelated history');
        User owner = person('owner');
        List<Technician_Tracking_Session__c> records = new List<Technician_Tracking_Session__c>();
        for (Integer index = 0; index < 28; index++) {
            records.add(new Technician_Tracking_Session__c(
                OwnerId = owner.Id, Case__c = item.Id, Active__c = index < 2,
                Expires_At__c = index < 2 ? System.now().addHours(2) : System.now().addHours(-2),
                Maps_Browser_Key__c = MAP_KEY
            ));
        }
        records.add(new Technician_Tracking_Session__c(OwnerId = owner.Id, Case__c = unrelated.Id, Active__c = true, Expires_At__c = System.now().addHours(2)));
        insert records;
        Datetime sameCreated = System.now().addDays(-1);
        for (Technician_Tracking_Session__c record : records) Test.setCreatedDate(record.Id, sameCreated);
        List<Technician_Tracking_Session__c> expected = [
            SELECT Id FROM Technician_Tracking_Session__c WHERE Case__c = :item.Id ORDER BY CreatedDate DESC, Id DESC
        ];
        System.runAs(owner) {
            TechnicianCaseSessionPage first = TechnicianCaseTrackingController.listCaseSessions(item.Id, null);
            System.assertEquals(25, first.sessions.size());
            System.assertEquals(first.sessions[24].sessionId, first.nextCursor);
            TechnicianCaseSessionPage second = TechnicianCaseTrackingController.listCaseSessions(item.Id, first.nextCursor);
            System.assertEquals(3, second.sessions.size());
            System.assertEquals(null, second.nextCursor);
            List<TechnicianTrackingSnapshot> combined = new List<TechnicianTrackingSnapshot>();
            combined.addAll(first.sessions);
            combined.addAll(second.sessions);
            Set<String> seen = new Set<String>();
            for (Integer index = 0; index < combined.size(); index++) {
                System.assertEquals(expected[index].Id, combined[index].sessionId);
                System.assertEquals(null, combined[index].browserMapsKey);
                System.assertEquals(null, combined[index].publisherUrl);
                System.assertEquals(null, combined[index].publisherInviteActive);
                System.assertEquals(null, combined[index].customerInviteActive);
                seen.add(combined[index].sessionId);
            }
            System.assertEquals(28, seen.size());
        }
    }

    @IsTest
    static void endedAndExpiredVisitsRemainInHistoryWithoutKeys() {
        Case item = makeCase('Visit history');
        User viewer = person('viewer');
        allowCase(item, viewer);
        String endedId;
        String expiredId;
        Long firstEnd;
        System.runAs(person('owner')) {
            endedId = TechnicianCaseTrackingController.createCaseSession(item.Id).sessionId;
            TechnicianLiveTrackingController.configureMaps(endedId, MAP_KEY);
            TechnicianLiveTrackingController.publishLocation(endedId, 37.7740, -122.4160, 5, System.now().getTime());
            TechnicianLiveTrackingController.endSession(endedId);
            firstEnd = TechnicianLiveTrackingController.getSession(endedId).endedAtMs;
            System.assertNotEquals(null, firstEnd);
            System.assertEquals(firstEnd, TechnicianLiveTrackingController.endSession(endedId).endedAtMs);
            expiredId = TechnicianCaseTrackingController.createCaseSession(item.Id).sessionId;
            TechnicianLiveTrackingController.configureMaps(expiredId, MAP_KEY);
            update new Technician_Tracking_Session__c(Id = expiredId, Expires_At__c = System.now().addSeconds(-1));
        }
        System.runAs(viewer) {
            TechnicianTrackingSnapshot ended = TechnicianCaseTrackingController.getCaseSession(item.Id, endedId);
            System.assertEquals(false, ended.active);
            System.assertEquals(firstEnd, ended.endedAtMs);
            System.assertEquals(37.7740, ended.latitude);
            System.assertEquals(null, ended.browserMapsKey);
            TechnicianTrackingSnapshot expired = TechnicianCaseTrackingController.getCaseSession(item.Id, expiredId);
            System.assertEquals(false, expired.active);
            System.assertEquals(true, expired.expired);
            System.assertEquals(null, expired.endedAtMs, 'Expiry is not an explicit end event.');
            System.assertEquals(null, expired.browserMapsKey);
            System.assertEquals(2, TechnicianCaseTrackingController.listCaseSessions(item.Id, null).sessions.size());
        }
    }

    @IsTest
    static void searchesCaseNumberAndSubjectAsLiteralText() {
        Case percent = makeCase('Visit 50% complete');
        makeCase('Visit 500 complete');
        Case underscore = makeCase('Route_A');
        makeCase('RouteXA');
        System.runAs(person('owner')) {
            System.assertEquals(percent.Id, TechnicianCaseTrackingController.searchCases(percent.CaseNumber)[0].caseId);
            List<TechnicianCaseSummary> percentMatches = TechnicianCaseTrackingController.searchCases('50%');
            System.assertEquals(1, percentMatches.size());
            System.assertEquals(percent.Id, percentMatches[0].caseId);
            List<TechnicianCaseSummary> underscoreMatches = TechnicianCaseTrackingController.searchCases('Route_');
            System.assertEquals(1, underscoreMatches.size());
            System.assertEquals(underscore.Id, underscoreMatches[0].caseId);
            System.assertEquals(0, TechnicianCaseTrackingController.searchCases('\' OR Id != null').size());
            System.assertEquals(4, TechnicianCaseTrackingController.searchCases(null).size());
            rejectCaseAction('search', 'x'.repeat(81), null);
        }
    }

    @IsTest
    static void malformedCaseIdsFailBeforeAnySessionOperation() {
        System.runAs(person('owner')) {
            String sessionId = TechnicianLiveTrackingController.createSession().sessionId;
            for (String invalid : new List<String>{ null, '', 'not-an-id', UserInfo.getUserId(), sessionId }) {
                for (String action : new List<String>{ 'case', 'create', 'link', 'list', 'detail' }) {
                    rejectCaseAction(action, invalid, sessionId);
                }
            }
            System.assertEquals(null, TechnicianLiveTrackingController.getSession(sessionId).caseId);
        }
    }
}
