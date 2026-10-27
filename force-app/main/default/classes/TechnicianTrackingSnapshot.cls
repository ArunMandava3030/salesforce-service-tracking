// A top-level DTO is supported by both LWC Apex calls and Visualforce remoting.
public class TechnicianTrackingSnapshot {
    @AuraEnabled public String sessionId { get; set; }
    @AuraEnabled public String caseId { get; set; }
    @AuraEnabled public String caseNumber { get; set; }
    @AuraEnabled public String sessionName { get; set; }
    @AuraEnabled public Long createdAtMs { get; set; }
    @AuraEnabled public Long endedAtMs { get; set; }
    @AuraEnabled public String ownerName { get; set; }
    @AuraEnabled public Boolean canManage { get; set; }
    @AuraEnabled public Boolean active { get; set; }
    @AuraEnabled public Boolean expired { get; set; }
    @AuraEnabled public Decimal customerLatitude { get; set; }
    @AuraEnabled public Decimal customerLongitude { get; set; }
    @AuraEnabled public Decimal latitude { get; set; }
    @AuraEnabled public Decimal longitude { get; set; }
    @AuraEnabled public Decimal accuracy { get; set; }
    @AuraEnabled public Long capturedAtMs { get; set; }
    @AuraEnabled public Long receivedAtMs { get; set; }
    @AuraEnabled public Long expiresAtMs { get; set; }
    @AuraEnabled public String publisherUrl { get; set; }
    @AuraEnabled public Boolean publisherInviteActive { get; set; }
    @AuraEnabled public Boolean customerInviteActive { get; set; }
    @AuraEnabled public String browserMapsKey { get; set; }
    @AuraEnabled public String mapPageUrl { get; set; }
}
