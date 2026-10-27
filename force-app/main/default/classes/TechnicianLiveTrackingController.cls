public with sharing class TechnicianLiveTrackingController {
    private static final Integer SESSION_HOURS = 2;
    private static final Long MAX_SAMPLE_AGE_MS = 120000;
    private static final Long MAX_FUTURE_SKEW_MS = 60000;

    public TechnicianLiveTrackingController() {}

    @AuraEnabled
    public static TechnicianTrackingSnapshot createSession() {
        Technician_Tracking_Session__c session = new Technician_Tracking_Session__c(
            Active__c = true,
            Expires_At__c = System.now().addHours(SESSION_HOURS)
        );
        try {
            insert as user session;
        } catch (DmlException error) {
            throw friendlyError('Cannot create a tracking session. Ask your admin to assign the Technician Live Tracking POC permission set.');
        }
        return getSession(String.valueOf(session.Id));
    }

    // These reads must not be cached: the laptop polls for the newest phone sample.
    @AuraEnabled
    public static TechnicianTrackingSnapshot getSession(String sessionId) {
        return snapshot(loadOwnedSession(sessionId, false));
    }

    @AuraEnabled
    public static TechnicianTrackingSnapshot configureMaps(String sessionId, String apiKey) {
        Technician_Tracking_Session__c session = loadOwnedSession(sessionId, true);
        requireLiveSession(session);
        if (apiKey == null || !Pattern.matches('[A-Za-z0-9_-]{20,200}', apiKey)) {
            throw friendlyError('Enter a valid Google Maps browser API key using 20 to 200 letters, numbers, underscores or hyphens.');
        }
        saveChanges(new Technician_Tracking_Session__c(Id = session.Id, Maps_Browser_Key__c = apiKey));
        session.Maps_Browser_Key__c = apiKey;
        return snapshot(session);
    }

    @AuraEnabled
    public static TechnicianPublisherGrant issueCustomerLink(String sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSession(sessionId, true);
        return TechnicianCustomerAccess.issueForOwner(session.Id);
    }

    @AuraEnabled
    public static TechnicianTrackingSnapshot revokeCustomerLink(String sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSession(sessionId, true);
        TechnicianCustomerAccess.revokeForOwner(session.Id);
        return snapshot(session);
    }

    @AuraEnabled
    public static TechnicianPublisherGrant issuePublisherLink(String sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSession(sessionId, true);
        return TechnicianPublisherAccess.issueForOwner(session.Id);
    }

    @AuraEnabled
    public static TechnicianTrackingSnapshot revokePublisherLink(String sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSession(sessionId, true);
        TechnicianPublisherAccess.revokeForOwner(session.Id);
        return snapshot(session);
    }

    @AuraEnabled
    public static TechnicianTrackingSnapshot endSession(String sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSession(sessionId, true);
        if (session.Active__c || session.Maps_Browser_Key__c != null || session.Ended_At__c == null) {
            Datetime endedAt = session.Ended_At__c == null ? System.now() : session.Ended_At__c;
            Technician_Tracking_Session__c changes = new Technician_Tracking_Session__c(
                Id = session.Id,
                Active__c = false,
                Maps_Browser_Key__c = null,
                Ended_At__c = endedAt
            );
            saveChanges(changes);
            session.Active__c = false;
            session.Maps_Browser_Key__c = null;
            session.Ended_At__c = endedAt;
        }
        TechnicianPublisherAccess.revokeForOwner(session.Id);
        TechnicianCustomerAccess.revokeForOwner(session.Id);
        return snapshot(session);
    }

    @RemoteAction
    public static TechnicianTrackingSnapshot getPhoneSession(String sessionId) {
        return getSession(sessionId);
    }

    @RemoteAction
    public static TechnicianDirectionsConfig getPhoneDirections(String sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSession(sessionId, false);
        requireLiveSession(session);
        return TechnicianDirectionsConfig.fromSession(session);
    }

    @RemoteAction
    public static TechnicianTrackingSnapshot stopSharing(String sessionId) {
        return endSession(sessionId);
    }

    @RemoteAction
    public static TechnicianTrackingSnapshot publishLocation(
        String sessionId,
        Decimal latitude,
        Decimal longitude,
        Decimal accuracy,
        Long capturedAtMs
    ) {
        Technician_Tracking_Session__c session = loadOwnedSession(sessionId, true);
        Datetime receivedAt = System.now();
        if (!session.Active__c || session.Expires_At__c == null || session.Expires_At__c <= receivedAt) {
            throw friendlyError('This tracking session has ended or expired. Create a new session on your laptop.');
        }
        if (latitude == null || latitude < -90 || latitude > 90 ||
            longitude == null || longitude < -180 || longitude > 180) {
            throw friendlyError('The phone sent invalid GPS coordinates.');
        }
        if (accuracy == null || accuracy < 0 || accuracy > 99999999.99) {
            throw friendlyError('The phone sent invalid GPS accuracy.');
        }
        if (capturedAtMs == null || capturedAtMs < receivedAt.getTime() - MAX_SAMPLE_AGE_MS ||
            capturedAtMs > receivedAt.getTime() + MAX_FUTURE_SKEW_MS) {
            throw friendlyError('The GPS sample is too old or the phone clock is incorrect. Request a fresh location.');
        }

        // Locking the record prevents concurrent phone requests from replacing a newer sample.
        if (session.Captured_At__c != null && capturedAtMs <= session.Captured_At__c.getTime()) {
            return snapshot(session);
        }

        Datetime capturedAt = Datetime.newInstance(capturedAtMs);
        Technician_Tracking_Session__c changes = new Technician_Tracking_Session__c(
            Id = session.Id,
            Latitude__c = latitude,
            Longitude__c = longitude,
            Accuracy_Meters__c = accuracy,
            Captured_At__c = capturedAt,
            Received_At__c = receivedAt
        );
        saveChanges(changes);
        session.Latitude__c = latitude;
        session.Longitude__c = longitude;
        session.Accuracy_Meters__c = accuracy;
        session.Captured_At__c = capturedAt;
        session.Received_At__c = receivedAt;
        return snapshot(session);
    }

    private static Technician_Tracking_Session__c loadOwnedSession(String sessionId, Boolean lockRecord) {
        Id recordId;
        try {
            recordId = Id.valueOf(sessionId);
            if (recordId.getSObjectType() != Technician_Tracking_Session__c.SObjectType) {
                throw new IllegalArgumentException();
            }
        } catch (Exception error) {
            throw friendlyError('The tracking session link is invalid. Create a new session on your laptop.');
        }
        List<Technician_Tracking_Session__c> sessions;
        try {
            sessions = Database.queryWithBinds(
                'SELECT Id, Name, OwnerId, Owner.Name, CreatedDate, Case__c, Ended_At__c, Active__c, Expires_At__c, Latitude__c, Longitude__c, ' +
                'Accuracy_Meters__c, Captured_At__c, Received_At__c, Maps_Browser_Key__c ' +
                'FROM Technician_Tracking_Session__c ' +
                'WHERE Id = :recordId AND OwnerId = :ownerId LIMIT 1' + (lockRecord ? ' FOR UPDATE' : ''),
                new Map<String, Object>{ 'recordId' => recordId, 'ownerId' => UserInfo.getUserId() },
                AccessLevel.USER_MODE
            );
        } catch (QueryException error) {
            throw friendlyError('Cannot access tracking sessions. Check your permission set and try again.');
        }
        if (sessions.isEmpty()) {
            throw friendlyError('Tracking session not found. Sign in on your phone using the same Salesforce user as your laptop.');
        }
        return sessions[0];
    }

    private static void saveChanges(Technician_Tracking_Session__c changes) {
        try {
            update as user changes;
        } catch (DmlException error) {
            throw friendlyError('Cannot save this tracking update. Check your permission set and try again.');
        }
    }

    private static TechnicianTrackingSnapshot snapshot(Technician_Tracking_Session__c session) {
        TechnicianTrackingSnapshot result = new TechnicianTrackingSnapshot();
        result.sessionId = String.valueOf(session.Id);
        result.caseId = session.Case__c == null ? null : String.valueOf(session.Case__c);
        result.caseNumber = accessibleCaseNumber(session.Case__c);
        result.sessionName = session.Name;
        result.createdAtMs = session.CreatedDate.getTime();
        result.endedAtMs = session.Ended_At__c == null ? null : session.Ended_At__c.getTime();
        result.ownerName = session.Owner.Name;
        result.canManage = true;
        result.expired = session.Expires_At__c == null || session.Expires_At__c <= System.now();
        result.active = session.Active__c && !result.expired;
        result.customerLatitude = 37.7749;
        result.customerLongitude = -122.4194;
        result.latitude = session.Latitude__c;
        result.longitude = session.Longitude__c;
        result.accuracy = session.Accuracy_Meters__c;
        result.capturedAtMs = session.Captured_At__c == null ? null : session.Captured_At__c.getTime();
        result.receivedAtMs = session.Received_At__c == null ? null : session.Received_At__c.getTime();
        result.expiresAtMs = session.Expires_At__c == null ? null : session.Expires_At__c.getTime();
        String visualforceOrigin = 'https://' + DomainCreator.getVisualforceHostname(null);
        result.publisherUrl = visualforceOrigin + '/apex/TechnicianGpsPublisher?sessionId=' + result.sessionId;
        result.publisherInviteActive = TechnicianPublisherAccess.isInviteActiveForOwner(session.Id);
        result.customerInviteActive = TechnicianCustomerAccess.isInviteActiveForOwner(session.Id);
        result.browserMapsKey = session.Maps_Browser_Key__c;
        result.mapPageUrl = visualforceOrigin + '/apex/TechnicianLiveMap';
        return result;
    }

    private static void requireLiveSession(Technician_Tracking_Session__c session) {
        if (!session.Active__c || session.Expires_At__c == null || session.Expires_At__c <= System.now()) {
            throw friendlyError('This tracking session has ended or expired. Create a new session.');
        }
    }

    private static String accessibleCaseNumber(Id caseId) {
        if (caseId == null) return null;
        try {
            List<Case> cases = [SELECT CaseNumber FROM Case WHERE Id = :caseId WITH USER_MODE LIMIT 1];
            return cases.isEmpty() ? null : cases[0].CaseNumber;
        } catch (QueryException error) {
            return null;
        }
    }

    private static AuraHandledException friendlyError(String message) {
        AuraHandledException error = new AuraHandledException(message);
        error.setMessage(message);
        return error;
    }
}
