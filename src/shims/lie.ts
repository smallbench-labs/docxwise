// Replaces the "lie" Promise polyfill that jszip bundles. jszip only falls back to lie when the
// global Promise is missing (node_modules/jszip/lib/external.js), which never happens in Obsidian,
// so this module is never used at runtime. Swapping it out drops lie's "immediate" scheduler,
// which created <script> elements at runtime.
export default Promise;
