// Returned only when the owner creates or rotates an invitation. Never persisted.
public class TechnicianPublisherGrant {
    @AuraEnabled public String token { get; set; }
    @AuraEnabled public Long expiresAtMs { get; set; }
}
