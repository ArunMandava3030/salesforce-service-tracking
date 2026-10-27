// Guest access is limited to token-authorized publishing and destination configuration.
// No record ID, object, field name or viewer action is accepted from the caller.
public without sharing class TechnicianGpsInvitationController {
    public TechnicianGpsInvitationController() {}

    @RemoteAction
    public static TechnicianPublisherStatus getPublisherStatus(String token) {
        return TechnicianPublisherAccess.getStatus(token);
    }

    @RemoteAction
    public static TechnicianDirectionsConfig getDirections(String token) {
        return TechnicianPublisherAccess.getDirections(token);
    }

    @RemoteAction
    public static TechnicianPublisherStatus publishLocation(
        String token,
        Decimal latitude,
        Decimal longitude,
        Decimal accuracy,
        Long capturedAtMs
    ) {
        return TechnicianPublisherAccess.publish(token, latitude, longitude, accuracy, capturedAtMs);
    }

    @RemoteAction
    public static TechnicianPublisherStatus stopPublishing(String token) {
        return TechnicianPublisherAccess.stop(token);
    }
}
