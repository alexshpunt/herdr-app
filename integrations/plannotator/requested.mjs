// A review that answers a tab bar request (Annotate diff, Annotate reply)
// opens in the app that button opened in the agent's pane: the
// plannotator-browser registration of the same name (`review`, `last`), whose
// title is the button's. Other reviews, such as those an agent opens itself,
// open as the app named "Plannotator".
const BUTTONS = {
    review: { action: 'code-review', tab: 'Annotate diff' },
    last: { action: 'annotate-last', tab: 'Annotate reply' },
};

export function createRequestNamer({ now = Date.now, within = 60000 } = {}) {
    let pending;
    return {
        /** One of the request commands is starting: name its review. */
        expect(command) {
            const button = BUTTONS[command];
            pending = button && { ...button, app: command, until: now() + within };
        },
        /** A `plannotator:session-opened` event, with `tabName` and `app` when it answers the request. */
        name(event) {
            if (!pending || event?.action !== pending.action || now() >= pending.until) return event;
            const { tab: tabName, app } = pending;
            pending = undefined;
            return { ...event, tabName, app };
        },
    };
}
