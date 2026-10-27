// A phone receives only its destination and browser-map configuration, never another GPS sample.
public class TechnicianDirectionsConfig {
    @AuraEnabled public Decimal customerLatitude { get; set; }
    @AuraEnabled public Decimal customerLongitude { get; set; }
    @AuraEnabled public String browserMapsKey { get; set; }
    @AuraEnabled public Boolean active { get; set; }
    @AuraEnabled public Long expiresAtMs { get; set; }

    public static TechnicianDirectionsConfig fromSession(Technician_Tracking_Session__c session) {
        TechnicianDirectionsConfig result = new TechnicianDirectionsConfig();
        result.customerLatitude = 37.7749;
        result.customerLongitude = -122.4194;
        result.browserMapsKey = session.Maps_Browser_Key__c;
        result.active = session.Active__c && session.Expires_At__c != null && session.Expires_At__c > System.now();
        result.expiresAtMs = session.Expires_At__c == null ? null : session.Expires_At__c.getTime();
        return result;
    }
}
