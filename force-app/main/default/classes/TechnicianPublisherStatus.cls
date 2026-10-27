// Deliberately excludes Salesforce IDs, coordinates, owner details and map URLs.
public class TechnicianPublisherStatus {
    @AuraEnabled public Boolean active { get; set; }
    @AuraEnabled public Boolean expired { get; set; }
    @AuraEnabled public Long expiresAtMs { get; set; }
    @AuraEnabled public Long receivedAtMs { get; set; }
    @AuraEnabled public Long acceptedCapturedAtMs { get; set; }
}
