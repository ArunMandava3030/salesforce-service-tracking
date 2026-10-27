// Case access is checked again inside the narrow service for every entry point.
public with sharing class TechnicianCaseTrackingController {
    @AuraEnabled
    public static List<TechnicianCaseSummary> searchCases(String searchTerm) {
        return TechnicianCaseTrackingAccess.searchCases(searchTerm);
    }

    @AuraEnabled
    public static TechnicianCaseSummary getCase(String caseId) {
        return TechnicianCaseTrackingAccess.getCase(caseId);
    }

    @AuraEnabled
    public static TechnicianTrackingSnapshot createCaseSession(String caseId) {
        return TechnicianCaseTrackingAccess.createCaseSession(caseId);
    }

    @AuraEnabled
    public static TechnicianTrackingSnapshot linkSessionToCase(String caseId, String sessionId) {
        return TechnicianCaseTrackingAccess.linkSessionToCase(caseId, sessionId);
    }

    @AuraEnabled
    public static TechnicianCaseSessionPage listCaseSessions(String caseId, String beforeSessionId) {
        return TechnicianCaseTrackingAccess.listCaseSessions(caseId, beforeSessionId);
    }

    @AuraEnabled
    public static TechnicianTrackingSnapshot getCaseSession(String caseId, String sessionId) {
        return TechnicianCaseTrackingAccess.getCaseSession(caseId, sessionId);
    }
}
