import { load } from 'cheerio';

const ALLOWED_THEME_VARS = new Set([
  '--teal', '--teal-light', '--accent', '--accent-light', '--accent-dark',
  '--ink', '--navy', '--slate', '--muted', '--cream', '--surface',
  '--surface-subtle', '--tile', '--tile-strong', '--border',
  '--font-heading', '--font-body',
]);

export function serializeThemeOverrides(overrides) {
  const rules = Object.entries(overrides || {})
    .filter(([k, v]) => ALLOWED_THEME_VARS.has(k) && typeof v === 'string' && v.trim())
    .map(([k, v]) => `  ${k}: ${v.trim().replace(/[;<>]/g, '')};`);

  if (rules.length === 0) return '';
  return `<style id="theme-overrides">\n:root {\n${rules.join('\n')}\n}\n</style>`;
}

export function injectThemeOverrides(html, overrides) {
  const css = serializeThemeOverrides(overrides);
  const $ = load(html);
  $('#theme-overrides').remove();
  if (css) {
    $('head').append(css);
  }
  return $.html();
}
