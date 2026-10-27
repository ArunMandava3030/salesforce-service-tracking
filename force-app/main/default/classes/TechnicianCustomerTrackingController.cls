// This guest-enabled entry point authorizes reads with a customer-purpose capability only.
public without sharing class TechnicianCustomerTrackingController {
    @AuraEnabled
    public static TechnicianCustomerSnapshot getTracking(String token) {
        return TechnicianCustomerAccess.getTracking(token);
    }
}
