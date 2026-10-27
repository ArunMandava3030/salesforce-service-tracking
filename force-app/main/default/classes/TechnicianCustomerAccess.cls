// No remotely callable methods. System access is bounded by owner checks for grant
// management and a separate customer-only capability for the limited tracking response.
public without sharing class TechnicianCustomerAccess {
    private static final String INVALID_LINK =
        'This customer link is invalid, expired, or revoked. Ask the session owner for a new link.';

    public static TechnicianPublisherGrant issueForOwner(Id sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSecret(sessionId, true);
        requireLiveSession(session);
        String token = EncodingUtil.convertToHex(Crypto.generateAesKey(256)).toLowerCase();
        saveSecret(new Technician_Tracking_Session__c(
            Id = session.Id,
            Customer_Token_Hash__c = digest(token)
        ));
        TechnicianPublisherGrant result = new TechnicianPublisherGrant();
        result.token = token;
        result.expiresAtMs = session.Expires_At__c.getTime();
        return result;
    }

    public static void revokeForOwner(Id sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSecret(sessionId, true);
        if (session.Customer_Token_Hash__c != null) {
            saveSecret(new Technician_Tracking_Session__c(Id = session.Id, Customer_Token_Hash__c = null));
        }
    }

    public static Boolean isInviteActiveForOwner(Id sessionId) {
        Technician_Tracking_Session__c session = loadOwnedSecret(sessionId, false);
        return session.Customer_Token_Hash__c != null && session.Active__c &&
            session.Expires_At__c != null && session.Expires_At__c > System.now();
    }

    public static TechnicianCustomerSnapshot getTracking(String token) {
        if (token == null || token.length() != 64 || !Pattern.matches('^[0-9a-fA-F]{64}$', token)) {
            throw friendlyError(INVALID_LINK);
        }
        String tokenHash = digest(token);
        List<Technician_Tracking_Session__c> sessions = Database.queryWithBinds(
            'SELECT Id, Active__c, Expires_At__c, Customer_Token_Hash__c, ' +
            'Latitude__c, Longitude__c, Accuracy_Meters__c, Captured_At__c, Received_At__c, Maps_Browser_Key__c ' +
            'FROM Technician_Tracking_Session__c WHERE Customer_Token_Hash__c = :tokenHash LIMIT 1',
            new Map<String, Object>{ 'tokenHash' => tokenHash },
            AccessLevel.SYSTEM_MODE
        );
        if (sessions.isEmpty() || sessions[0].Customer_Token_Hash__c != tokenHash) {
            throw friendlyError(INVALID_LINK);
        }
        Technician_Tracking_Session__c session = sessions[0];
        requireLiveSession(session);
        TechnicianCustomerSnapshot result = new TechnicianCustomerSnapshot();
        result.active = true;
        result.expiresAtMs = session.Expires_At__c.getTime();
        result.customerLatitude = 37.7749;
        result.customerLongitude = -122.4194;
        result.latitude = session.Latitude__c;
        result.longitude = session.Longitude__c;
        result.accuracy = session.Accuracy_Meters__c;
        result.capturedAtMs = session.Captured_At__c == null ? null : session.Captured_At__c.getTime();
        result.receivedAtMs = session.Received_At__c == null ? null : session.Received_At__c.getTime();
        result.browserMapsKey = session.Maps_Browser_Key__c;
        return result;
    }

    private static Technician_Tracking_Session__c loadOwnedSecret(Id sessionId, Boolean lockRecord) {
        if (sessionId == null || sessionId.getSObjectType() != Technician_Tracking_Session__c.SObjectType ||
            UserInfo.getUserType() == 'Guest') {
            throw friendlyError('Only the session owner can manage customer links.');
        }
        if (lockRecord && !Technician_Tracking_Session__c.SObjectType.getDescribe().isUpdateable()) {
            throw friendlyError('You do not have permission to manage customer links.');
        }
        List<Technician_Tracking_Session__c> sessions = Database.queryWithBinds(
            'SELECT Id, Active__c, Expires_At__c, Customer_Token_Hash__c FROM Technician_Tracking_Session__c ' +
            'WHERE Id = :sessionId AND OwnerId = :ownerId LIMIT 1' + (lockRecord ? ' FOR UPDATE' : ''),
            new Map<String, Object>{ 'sessionId' => sessionId, 'ownerId' => UserInfo.getUserId() },
            AccessLevel.SYSTEM_MODE
        );
        if (sessions.isEmpty()) {
            throw friendlyError('Only the session owner can manage customer links.');
        }
        return sessions[0];
    }

    private static void requireLiveSession(Technician_Tracking_Session__c session) {
        if (!session.Active__c || session.Expires_At__c == null || session.Expires_At__c <= System.now()) {
            throw friendlyError(INVALID_LINK);
        }
    }

    private static String digest(String token) {
        return EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', Blob.valueOf(token.toLowerCase())));
    }

    private static void saveSecret(Technician_Tracking_Session__c changes) {
        try {
            update as system changes;
        } catch (DmlException error) {
            throw friendlyError('The customer link could not be updated. Try again.');
        }
    }

    private static AuraHandledException friendlyError(String message) {
        AuraHandledException error = new AuraHandledException(message);
        error.setMessage(message);
        return error;
    }
}
