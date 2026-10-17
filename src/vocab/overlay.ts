// Required structure, written by hand from each element's api.json
// "structure" entries (spec §7.4). Those entries are prose for people ("<ul> or
// <ol>", "any element with data-trigger", optional sources marked only in the
// description), so only requirements the manifest states plainly, and that the
// component's own lookup confirms (drop-down takes [data-trigger] or a button
// among its children), are encoded here. data/vocab-basis.json pins the
// structure text each one was written against; a snapshot that changes it
// fails a test until this file is reviewed.

export interface Requirement {
  /** A compound selector list (src/vocab/select.ts). */
  selector: string;
  /** Direct children only; otherwise any descendant. */
  child?: true;
  /** What is missing, for the message: "a <details> for each panel". */
  what: string;
}

export const REQUIRED: Readonly<Record<string, readonly Requirement[]>> = {
  'accordion-wc': [{ selector: 'details', child: true, what: 'a <details> child for each panel' }],
  'tab-set': [{ selector: 'details', child: true, what: 'a <details> child for each tab' }],
  'data-table': [{ selector: 'table', child: true, what: 'a <table> child to enhance' }],
  'combo-box': [
    { selector: 'input', what: 'an <input> for filtering' },
    { selector: 'ul, ol', what: 'a <ul> or <ol> of options' },
  ],
  'drop-down': [
    { selector: '[data-trigger], button', child: true, what: 'a trigger child: <button data-trigger> or <a data-trigger>' },
    { selector: 'menu, ul[role=menu]', what: 'a <menu> of actions' },
  ],
  'context-menu': [
    { selector: '[data-trigger]', child: true, what: 'a target area child marked data-trigger' },
    { selector: 'menu, ul[role=menu]', what: 'a <menu> of actions' },
  ],
  'consent-banner': [
    { selector: 'dialog', what: 'a <dialog> to hold the banner' },
    { selector: 'button[value=accept]', what: 'an accept button, <button value="accept">' },
  ],
  'page-tour': [{ selector: 'tour-step', what: 'at least one <tour-step>' }],
};
