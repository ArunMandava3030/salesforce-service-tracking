import { LightningElement, api } from 'lwc';
import { DEFAULT_PUBLISHER_PAGE_URL, readInvitationToken, buildInvitationUrl } from 'c/trackingInvitation';

export default class TechnicianInvitationEntry extends LightningElement {
    @api publicPublisherPageUrl = DEFAULT_PUBLISHER_PAGE_URL;
    invitationValue = '';

    connectedCallback() {
        if (readInvitationToken(window.location.href)) this.invitationValue = window.location.href;
    }

    handleInvitationChange(event) {
        this.invitationValue = event.target.value;
    }

    get invitationUrl() {
        const token = readInvitationToken(this.invitationValue);
        if (!token) return '';
        try {
            return buildInvitationUrl(this.publicPublisherPageUrl, token);
        } catch (error) {
            return '';
        }
    }

    get invalidInvitation() {
        return Boolean(this.invitationValue.trim()) && !this.invitationUrl;
    }
}
