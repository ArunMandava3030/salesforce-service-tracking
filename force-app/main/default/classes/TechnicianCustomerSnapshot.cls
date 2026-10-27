// Read-only customer response. Contains no record IDs, owner data, or publisher capability.
public class TechnicianCustomerSnapshot {
    @AuraEnabled public Boolean active { get; set; }
    @AuraEnabled public Long expiresAtMs { get; set; }
    @AuraEnabled public Decimal customerLatitude { get; set; }
    @AuraEnabled public Decimal customerLongitude { get; set; }
    @AuraEnabled public Decimal latitude { get; set; }
    @AuraEnabled public Decimal longitude { get; set; }
    @AuraEnabled public Decimal accuracy { get; set; }
    @AuraEnabled public Long capturedAtMs { get; set; }
    @AuraEnabled public Long receivedAtMs { get; set; }
    @AuraEnabled public String browserMapsKey { get; set; }
}
