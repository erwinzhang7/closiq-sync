// Namespace shim, loaded first in every context.
//
// Safari exposes both `browser.*` and `chrome.*`, and both are promise-returning.
// Do NOT add webextension-polyfill on top: double-wrapping an already-promise-based
// API is a known source of breakage. Guard on `browser.runtime` rather than bare
// `typeof browser`, because some page contexts define an unrelated `browser` global.
//
// Corollary: never read `runtime.lastError`. In Safari it is only populated for the
// callback style; promise failures reject with an Error. Use try/catch everywhere.
globalThis.api =
  typeof browser !== 'undefined' && browser.runtime ? browser : chrome;
