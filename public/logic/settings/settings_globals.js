// settings_globals.js
//
// `window.allWorkflows` left with the ROI panel — it lives in logic/roi/ now,
// scoped to the module that owns it rather than parked on `window` for a
// renderer in another file to find.
window.globalSettings = {};
// escapeHtml lives in global_functions.js, which every page loads before this.
