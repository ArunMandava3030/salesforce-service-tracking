// No remote entry points. Each operation independently requires an internal user,
// the Case tracking permission, and a fresh USER_MODE read of the requested Case.
// System reads below are constrained to that Case and enforce session CRUD/FLS.
public without sharing class TechnicianCaseTrackingAccess {
    private static final Integer PAGE_SIZE = 25;
    private static final String SESSION_FIELDS =
        'Id, Name, OwnerId, Owner.Name, CreatedDate, Case__c, Ended_At__c, Active__c, Expires_At__c, ' +
        'Latitude__c, Longitude__c, Accuracy_Meters__c, Captured_At__c, Received_At__c';

    public static List<TechnicianCaseSummary> searchCases(String searchTerm) {
        requireInternalPermission();
        String term = searchTerm == null ? '' : searchTerm.trim();
        if (term.length() > 80) throw friendlyError('Search using at most 80 characters.');
        String clause = '';
        Map<String, Object> binds = new Map<String, Object>();
        if (term != '') {
            String literal = term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_');
            binds.put('searchValue', '%' + literal + '%');
            clause = ' WHERE CaseNumber LIKE :searchValue OR Subject LIKE :searchValue';
        }
        List<Case> cases;
        try {
            cases = Database.queryWithBinds(
                'SELECT Id, CaseNumber, Subject FROM Case' + clause + ' ORDER BY LastModifiedDate DESC, Id DESC LIMIT 20',
                binds, AccessLevel.USER_MODE
            );
        } catch (QueryException error) {
            throw friendlyError('You do not have access to search Cases.');
        }
        List<TechnicianCaseSummary> result = new List<TechnicianCaseSummary>();
        for (Case item : cases) result.add(caseSummary(item));
        return result;
    }

    public static TechnicianCaseSummary getCase(String caseId) {
        return caseSummary(requireCase(caseId));
    }

    public static TechnicianTrackingSnapshot createCaseSession(String caseId) {
        Case parent = requireCase(caseId);
        if (!Technician_Tracking_Session__c.SObjectType.getDescribe().isCreateable() ||
            !Technician_Tracking_Session__c.Case__c.getDescribe().isCreateable() ||
            !Technician_Tracking_Session__c.Active__c.getDescribe().isCreateable() ||
            !Technician_Tracking_Session__c.Expires_At__c.getDescribe().isCreateable()) {
            throw friendlyError('Cannot create tracking for this Case. Check your tracking permissions.');
        }
        Technician_Tracking_Session__c session = new Technician_Tracking_Session__c(
            Case__c = parent.Id, Active__c = true, Expires_At__c = System.now().addHours(2)
        );
        try {
            insert as user session;
        } catch (DmlException error) {
            throw friendlyError('Cannot create tracking for this Case. Check your tracking permissions.');
        }
        return TechnicianLiveTrackingController.getSession(String.valueOf(session.Id));
    }

    public static TechnicianTrackingSnapshot linkSessionToCase(String caseId, String sessionId) {
        Case parent = requireCase(caseId);
        Id recordId = sessionIdValue(sessionId);
        List<Technician_Tracking_Session__c> sessions;
        try {
            sessions = Database.queryWithBinds(
                'SELECT Id, Case__c FROM Technician_Tracking_Session__c ' +
                'WHERE Id = :recordId AND OwnerId = :ownerId LIMIT 1 FOR UPDATE',
                new Map<String, Object>{ 'recordId' => recordId, 'ownerId' => UserInfo.getUserId() },
                AccessLevel.USER_MODE
            );
        } catch (QueryException error) {
            throw friendlyError('Only the session owner can link tracking to a Case.');
        }
        if (sessions.isEmpty()) throw friendlyError('Only the session owner can link tracking to a Case.');
        if (sessions[0].Case__c != null && sessions[0].Case__c != parent.Id) {
            throw friendlyError('This tracking session already belongs to another Case and cannot be moved.');
        }
        if (sessions[0].Case__c == null) {
            if (!Technician_Tracking_Session__c.SObjectType.getDescribe().isUpdateable() ||
                !Technician_Tracking_Session__c.Case__c.getDescribe().isUpdateable()) {
                throw friendlyError('Cannot link this tracking session. Check your tracking permissions.');
            }
            try {
                update as user new Technician_Tracking_Session__c(Id = recordId, Case__c = parent.Id);
            } catch (DmlException error) {
                throw friendlyError('Cannot link this tracking session. Check your tracking permissions.');
            }
        }
        return TechnicianLiveTrackingController.getSession(String.valueOf(recordId));
    }

    public static TechnicianCaseSessionPage listCaseSessions(String caseId, String beforeSessionId) {
        Case parent = requireCase(caseId);
        requireSessionRead(false);
        Map<String, Object> binds = new Map<String, Object>{ 'caseId' => parent.Id };
        String cursorClause = '';
        if (!String.isBlank(beforeSessionId)) {
            Id cursorId = sessionIdValue(beforeSessionId);
            List<Technician_Tracking_Session__c> cursors = Database.queryWithBinds(
                'SELECT Id, CreatedDate FROM Technician_Tracking_Session__c WHERE Case__c = :caseId AND Id = :cursorId LIMIT 1',
                new Map<String, Object>{ 'caseId' => parent.Id, 'cursorId' => cursorId }, AccessLevel.SYSTEM_MODE
            );
            if (cursors.isEmpty()) throw friendlyError('The tracking history cursor is invalid for this Case.');
            binds.put('cursorId', cursorId);
            binds.put('cursorCreated', cursors[0].CreatedDate);
            cursorClause = ' AND (CreatedDate < :cursorCreated OR (CreatedDate = :cursorCreated AND Id < :cursorId))';
        }
        List<Technician_Tracking_Session__c> sessions = Database.queryWithBinds(
            'SELECT ' + SESSION_FIELDS + ' FROM Technician_Tracking_Session__c WHERE Case__c = :caseId' +
            cursorClause + ' ORDER BY CreatedDate DESC, Id DESC LIMIT 26', binds, AccessLevel.SYSTEM_MODE
        );
        Boolean hasMore = sessions.size() > PAGE_SIZE;
        if (hasMore) sessions.remove(PAGE_SIZE);
        TechnicianCaseSessionPage result = new TechnicianCaseSessionPage();
        result.sessions = new List<TechnicianTrackingSnapshot>();
        for (Technician_Tracking_Session__c session : sessions) result.sessions.add(caseSnapshot(session, parent, false));
        result.nextCursor = hasMore ? result.sessions[result.sessions.size() - 1].sessionId : null;
        return result;
    }

    public static TechnicianTrackingSnapshot getCaseSession(String caseId, String sessionId) {
        Case parent = requireCase(caseId);
        requireSessionRead(true);
        Id recordId = sessionIdValue(sessionId);
        List<Technician_Tracking_Session__c> sessions = Database.queryWithBinds(
            'SELECT ' + SESSION_FIELDS + ', Maps_Browser_Key__c FROM Technician_Tracking_Session__c ' +
            'WHERE Case__c = :caseId AND Id = :recordId LIMIT 1',
            new Map<String, Object>{ 'caseId' => parent.Id, 'recordId' => recordId }, AccessLevel.SYSTEM_MODE
        );
        if (sessions.isEmpty()) throw friendlyError('Tracking session not found for this Case.');
        if (sessions[0].OwnerId == UserInfo.getUserId()) {
            return TechnicianLiveTrackingController.getSession(String.valueOf(recordId));
        }
        return caseSnapshot(sessions[0], parent, true);
    }

    private static void requireInternalPermission() {
        if (UserInfo.getUserType() != 'Standard' || !FeatureManagement.checkPermission('View_Case_Technician_Tracking')) {
            throw friendlyError('Case tracking is available only to authorized internal Salesforce users.');
        }
    }

    private static Case requireCase(String caseId) {
        requireInternalPermission();
        Id recordId;
        try {
            recordId = Id.valueOf(caseId);
            if (recordId.getSObjectType() != Case.SObjectType) throw new IllegalArgumentException();
        } catch (Exception error) {
            throw friendlyError('Choose a valid Case.');
        }
        List<Case> cases;
        try {
            cases = Database.queryWithBinds(
                'SELECT Id, CaseNumber, Subject FROM Case WHERE Id = :recordId LIMIT 1',
                new Map<String, Object>{ 'recordId' => recordId }, AccessLevel.USER_MODE
            );
        } catch (QueryException error) {
            throw friendlyError('Case not found or you do not have access to it.');
        }
        if (cases.isEmpty()) throw friendlyError('Case not found or you do not have access to it.');
        return cases[0];
    }

    private static void requireSessionRead(Boolean includeMapKey) {
        if (!Technician_Tracking_Session__c.SObjectType.getDescribe().isAccessible()) {
            throw friendlyError('You do not have permission to view tracking sessions.');
        }
        List<Schema.SObjectField> fields = new List<Schema.SObjectField>{
            Technician_Tracking_Session__c.Id, Technician_Tracking_Session__c.Name,
            Technician_Tracking_Session__c.OwnerId, Technician_Tracking_Session__c.CreatedDate,
            Technician_Tracking_Session__c.Case__c, Technician_Tracking_Session__c.Ended_At__c,
            Technician_Tracking_Session__c.Active__c, Technician_Tracking_Session__c.Expires_At__c,
            Technician_Tracking_Session__c.Latitude__c, Technician_Tracking_Session__c.Longitude__c,
            Technician_Tracking_Session__c.Accuracy_Meters__c, Technician_Tracking_Session__c.Captured_At__c,
            Technician_Tracking_Session__c.Received_At__c, User.Name
        };
        if (includeMapKey) fields.add(Technician_Tracking_Session__c.Maps_Browser_Key__c);
        for (Schema.SObjectField field : fields) {
            if (!field.getDescribe().isAccessible()) throw friendlyError('You do not have permission to view tracking session fields.');
        }
    }

    private static Id sessionIdValue(String value) {
        try {
            Id recordId = Id.valueOf(value);
            if (recordId.getSObjectType() != Technician_Tracking_Session__c.SObjectType) throw new IllegalArgumentException();
            return recordId;
        } catch (Exception error) {
            throw friendlyError('Choose a valid tracking session.');
        }
    }

    private static TechnicianCaseSummary caseSummary(Case item) {
        TechnicianCaseSummary result = new TechnicianCaseSummary();
        result.caseId = String.valueOf(item.Id);
        result.caseNumber = item.CaseNumber;
        result.subject = item.Subject;
        return result;
    }

    private static TechnicianTrackingSnapshot caseSnapshot(Technician_Tracking_Session__c session, Case parent, Boolean includeMapKey) {
        TechnicianTrackingSnapshot result = new TechnicianTrackingSnapshot();
        result.sessionId = String.valueOf(session.Id);
        result.caseId = String.valueOf(parent.Id);
        result.caseNumber = parent.CaseNumber;
        result.sessionName = session.Name;
        result.createdAtMs = session.CreatedDate.getTime();
        result.endedAtMs = session.Ended_At__c == null ? null : session.Ended_At__c.getTime();
        result.ownerName = session.Owner.Name;
        result.canManage = session.OwnerId == UserInfo.getUserId();
        result.expired = session.Expires_At__c == null || session.Expires_At__c <= System.now();
        result.active = session.Active__c && !result.expired;
        result.expiresAtMs = session.Expires_At__c == null ? null : session.Expires_At__c.getTime();
        result.customerLatitude = 37.7749;
        result.customerLongitude = -122.4194;
        result.latitude = session.Latitude__c;
        result.longitude = session.Longitude__c;
        result.accuracy = session.Accuracy_Meters__c;
        result.capturedAtMs = session.Captured_At__c == null ? null : session.Captured_At__c.getTime();
        result.receivedAtMs = session.Received_At__c == null ? null : session.Received_At__c.getTime();
        if (includeMapKey) {
            result.browserMapsKey = result.active ? session.Maps_Browser_Key__c : null;
            result.mapPageUrl = 'https://' + DomainCreator.getVisualforceHostname(null) + '/apex/TechnicianLiveMap';
        }
        // Phone URLs and both invitation statuses deliberately remain unset.
        return result;
    }

    private static AuraHandledException friendlyError(String message) {
        AuraHandledException error = new AuraHandledException(message);
        error.setMessage(message);
        return error;
    }
}
