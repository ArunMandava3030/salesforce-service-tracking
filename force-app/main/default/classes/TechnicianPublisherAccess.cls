// Narrow capability service. It has no @AuraEnabled or @RemoteAction entry points.
// System mode is intentional: a guest has no object/FLS/record access. Every operation
// instead requires either the current record owner or a strong, live publisher token.
public without sharing class TechnicianPublisherAccess {
    private static final String INVALID_INVITATION =
        'This phone link is invalid, expired, or revoked. Ask the session owner for a new link.';
    private static final Long MAX_SAMPLE_AGE_MS = 120000;
    private static final Long MAX_FUTURE_SKEW_MS = 60000;

    public static TechnicianPublisherGrant issueForOwner(Id sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSecret(sessionId, true);
        requireLiveSession(session);
        String token = EncodingUtil.convertToHex(Crypto.generateAesKey(256)).toLowerCase();
        String digest = tokenDigest(token);
        saveSystemChange(new Technician_Tracking_Session__c(
            Id = session.Id,
            Publisher_Token_Hash__c = digest
        ));
        TechnicianPublisherGrant result = new TechnicianPublisherGrant();
        result.token = token;
        result.expiresAtMs = session.Expires_At__c.getTime();
        return result;
    }

    public static void revokeForOwner(Id sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSecret(sessionId, true);
        if (session.Publisher_Token_Hash__c != null) {
            saveSystemChange(new Technician_Tracking_Session__c(
                Id = session.Id,
                Publisher_Token_Hash__c = null
            ));
        }
    }

    public static Boolean isInviteActiveForOwner(Id sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSecret(sessionId, false);
        return session.Publisher_Token_Hash__c != null && session.Active__c &&
            session.Expires_At__c != null && session.Expires_At__c > System.now();
    }

    public static TechnicianPublisherStatus getStatus(String token) {
        return status(loadForPublisher(token, false), false);
    }

    public static TechnicianDirectionsConfig getDirections(String token) {
        return TechnicianDirectionsConfig.fromSession(loadForPublisher(token, false));
    }

    public static TechnicianPublisherStatus publish(
        String token,
        Decimal latitude,
        Decimal longitude,
        Decimal accuracy,
        Long capturedAtMs
    ) {
        Technician_Tracking_Session__c session = loadForPublisher(token, true);
        Datetime receivedAt = System.now();
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
        if (session.Captured_At__c != null && capturedAtMs <= session.Captured_At__c.getTime()) {
            return status(session, true);
        }
        Datetime capturedAt = Datetime.newInstance(capturedAtMs);
        // Only these five GPS fields may be written by a delegated publisher.
        saveSystemChange(new Technician_Tracking_Session__c(
            Id = session.Id,
            Latitude__c = latitude,
            Longitude__c = longitude,
            Accuracy_Meters__c = accuracy,
            Captured_At__c = capturedAt,
            Received_At__c = receivedAt
        ));
        session.Captured_At__c = capturedAt;
        session.Received_At__c = receivedAt;
        return status(session, true);
    }

    public static TechnicianPublisherStatus stop(String token) {
        Technician_Tracking_Session__c session = loadForPublisher(token, true);
        saveSystemChange(new Technician_Tracking_Session__c(
            Id = session.Id,
            Publisher_Token_Hash__c = null
        ));
        session.Publisher_Token_Hash__c = null;
        // Stopping this invitation does not end or otherwise manage the owner's session.
        return status(session, false);
    }

    private static Technician_Tracking_Session__c loadOwnedSecret(Id sessionId, Boolean lockRecord) {
        if (sessionId == null || sessionId.getSObjectType() != Technician_Tracking_Session__c.SObjectType ||
            UserInfo.getUserType() == 'Guest') {
            throw friendlyError('Only the session owner can manage phone invitations.');
        }
        if (lockRecord && !Technician_Tracking_Session__c.SObjectType.getDescribe().isUpdateable()) {
            throw friendlyError('You do not have permission to manage phone invitations.');
        }
        List<Technician_Tracking_Session__c> sessions = Database.queryWithBinds(
            'SELECT Id, Active__c, Expires_At__c, Publisher_Token_Hash__c ' +
            'FROM Technician_Tracking_Session__c WHERE Id = :sessionId AND OwnerId = :ownerId ' +
            'LIMIT 1' + (lockRecord ? ' FOR UPDATE' : ''),
            new Map<String, Object>{ 'sessionId' => sessionId, 'ownerId' => UserInfo.getUserId() },
            AccessLevel.SYSTEM_MODE
        );
        if (sessions.isEmpty()) {
            throw friendlyError('Only the session owner can manage phone invitations.');
        }
        return sessions[0];
    }

    private static Technician_Tracking_Session__c loadForPublisher(String token, Boolean lockRecord) {
        // Validate before querying. A record ID or arbitrary string is never a capability.
        if (token == null || token.length() != 64 || !Pattern.matches('^[0-9a-fA-F]{64}$', token)) {
            throw friendlyError(INVALID_INVITATION);
        }
        String digest = tokenDigest(token);
        List<Technician_Tracking_Session__c> sessions = Database.queryWithBinds(
            'SELECT Id, Active__c, Expires_At__c, Publisher_Token_Hash__c, ' +
            'Captured_At__c, Received_At__c, Maps_Browser_Key__c FROM Technician_Tracking_Session__c ' +
            'WHERE Publisher_Token_Hash__c = :digest LIMIT 1' + (lockRecord ? ' FOR UPDATE' : ''),
            new Map<String, Object>{ 'digest' => digest },
            AccessLevel.SYSTEM_MODE
        );
        if (sessions.isEmpty()) {
            throw friendlyError(INVALID_INVITATION);
        }
        Technician_Tracking_Session__c session = sessions[0];
        // Recheck the digest on the locked row as well as the query predicate.
        if (session.Publisher_Token_Hash__c != digest) {
            throw friendlyError(INVALID_INVITATION);
        }
        requireLiveSession(session);
        return session;
    }

    private static void requireLiveSession(Technician_Tracking_Session__c session) {
        if (!session.Active__c || session.Expires_At__c == null || session.Expires_At__c <= System.now()) {
            throw friendlyError(INVALID_INVITATION);
        }
    }

    private static String tokenDigest(String token) {
        return EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', Blob.valueOf(token.toLowerCase())));
    }

    private static void saveSystemChange(Technician_Tracking_Session__c changes) {
        try {
            update as system changes;
        } catch (DmlException error) {
            throw friendlyError('This tracking update could not be saved. Try again.');
        }
    }

    private static TechnicianPublisherStatus status(Technician_Tracking_Session__c session, Boolean includeReceipt) {
        TechnicianPublisherStatus result = new TechnicianPublisherStatus();
        result.expired = session.Expires_At__c == null || session.Expires_At__c <= System.now();
        result.active = session.Active__c && !result.expired && session.Publisher_Token_Hash__c != null;
        result.expiresAtMs = session.Expires_At__c == null ? null : session.Expires_At__c.getTime();
        result.receivedAtMs = !includeReceipt || session.Received_At__c == null ? null : session.Received_At__c.getTime();
        result.acceptedCapturedAtMs = !includeReceipt || session.Captured_At__c == null ? null : session.Captured_At__c.getTime();
        return result;
    }

    private static AuraHandledException friendlyError(String message) {
        AuraHandledException error = new AuraHandledException(message);
        error.setMessage(message);
        return error;
    }
}
