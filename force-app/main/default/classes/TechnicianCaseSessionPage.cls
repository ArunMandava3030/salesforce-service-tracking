public class TechnicianCaseSessionPage {
    @AuraEnabled public List<TechnicianTrackingSnapshot> sessions { get; set; }
    @AuraEnabled public String nextCursor { get; set; }
}
