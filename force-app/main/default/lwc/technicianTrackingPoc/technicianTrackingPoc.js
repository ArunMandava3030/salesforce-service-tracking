import { LightningElement, api } from 'lwc';
import IS_GUEST from '@salesforce/user/isGuest';
import { DEFAULT_PUBLISHER_PAGE_URL, DEFAULT_CUSTOMER_PAGE_URL, hasCustomerFragment } from 'c/trackingInvitation';

export default class TechnicianTrackingPoc extends LightningElement {
    @api recordId;
    @api objectApiName;
    @api publicPublisherPageUrl = DEFAULT_PUBLISHER_PAGE_URL;
    @api publicCustomerPageUrl = DEFAULT_CUSTOMER_PAGE_URL;
    showCustomer = false;
    hashHandler;

    connectedCallback() {
        this.hashHandler = () => { this.showCustomer = hasCustomerFragment(window.location.href); };
        this.hashHandler();
        window.addEventListener('hashchange', this.hashHandler);
    }
    disconnectedCallback() { window.removeEventListener('hashchange', this.hashHandler); }

    get isGuestVisitor() { return IS_GUEST; }
}
