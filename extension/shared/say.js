// @ts-check

const KEEP_MS = 4000;
const KEEP_ERROR_MS = 9000;
const KEEP_ACTION_MS = 9000;
const ERROR_KEYS = ['popup.saveError', 'popup.saveErrorReload', 'popup.error', 'opt.siteBad', 'opt.importBad', 'opt.permissionDenied', 'opt.holdChanged', 'fx.pasteBad'];

/**
 * The short message in the top bar of a page. A message that says something went wrong looks different, is announced at once
 * and stays longer than a confirmation. A message can carry one button (for example "Undo"): it stays while the pointer or the
 * keyboard is on it, and the button takes the focus when the message asks for it.
 * @param {HTMLElement} el the element with `role="status"`
 * @param {(key: string) => string} t
 * @returns {(text: string, action?: SayAction) => void}
 *
 * @typedef {{ label: string, run: () => void | Promise<unknown>, focus?: boolean }} SayAction
 */
export function createSay(el, t) {
  const errors = new Set(ERROR_KEYS.map((key) => t(key)));
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let keep = KEEP_MS;
  let held = false;
  const clear = () => {
    el.replaceChildren();
    delete el.dataset.action;
  };
  const arm = () => {
    clearTimeout(timer);
    if (held || !el.hasChildNodes()) return;
    timer = setTimeout(clear, keep);
  };
  const hold = (/** @type {boolean} */ on) => () => {
    held = on;
    if (!on && el.contains(document.activeElement)) held = true;
    arm();
  };
  el.addEventListener('mouseenter', hold(true));
  el.addEventListener('mouseleave', hold(false));
  el.addEventListener('focusin', hold(true));
  el.addEventListener('focusout', () => {
    held = el.matches(':hover');
    arm();
  });
  return (/** @type {string} */ text, /** @type {SayAction | undefined} */ action) => {
    const bad = errors.has(text);
    el.dataset.kind = bad ? 'error' : 'info';
    el.setAttribute('role', bad ? 'alert' : 'status');
    held = el.matches(':hover');
    if (action) {
      const line = document.createElement('span');
      line.textContent = text;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm say-action';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        clearTimeout(timer);
        clear();
        void action.run();
      });
      el.dataset.action = '1';
      el.replaceChildren(line, button);
      if (action.focus) button.focus();
    } else {
      clear();
      el.textContent = text;
    }
    keep = action ? KEEP_ACTION_MS : bad ? KEEP_ERROR_MS : KEEP_MS;
    arm();
  };
}
