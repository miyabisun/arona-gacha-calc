const LANGUAGE_SWITCH_CSS = '.nav{align-items:flex-end;justify-content:space-between}.nav-pages,.language-switch{display:flex;gap:16px}.language-switch{gap:4px;padding:0 0 8px;color:var(--muted);font-size:12px}.language-switch a,.language-switch span{padding:0 4px}.language-switch [aria-current="true"]{color:var(--on);font-weight:700}';

function replaceExact(source, replacements) {
  // Replacements run in order; a later pattern may intentionally match earlier output.
  return replacements.reduce((html, [from, to]) => {
    if (!html.includes(from)) throw new Error(`Translation source not found: ${from}`);
    return html.replaceAll(from, to);
  }, source);
}

/** ページ識別子から、同じ階層で参照するファイル名を返す。indexだけディレクトリ指定。 */
function pageHref(page) {
  return page === 'index' ? './' : `${page}.html`;
}

function languageNav(locale, page) {
  const english = locale === 'en';
  const titles = english
    ? { index: 'Probability chart', festival: '5.5th', faq: 'Q&amp;A' }
    : { index: '確率表', festival: '5.5th', faq: 'Q&amp;A' };
  const pageLinks = ['index', 'festival', 'faq'].map((id) => {
    const current = id === page ? ' aria-current="page"' : '';
    return `<a href="${pageHref(id)}"${current}>${titles[id]}</a>`;
  }).join('');
  const counterpart = page === 'index' ? '' : `${page}.html`;
  const languageLinks = english
    ? `<a href="../${counterpart}" lang="ja" hreflang="ja">JP</a><span aria-current="true">EN</span>`
    : `<span aria-current="true">JP</span><a href="en/${counterpart}" lang="en" hreflang="en">EN</a>`;
  const primaryLabel = english ? 'Primary navigation' : 'メインナビゲーション';
  const languageLabel = english ? 'Language' : '言語';
  return `<nav class="nav" aria-label="${primaryLabel}"><div class="nav-pages">${pageLinks}</div><div class="language-switch" aria-label="${languageLabel}">${languageLinks}</div></nav>`;
}

function alternateLinks(page) {
  const suffix = page === 'index' ? '' : `${page}.html`;
  const japanese = `https://miyabisun.github.io/arona-gacha-calc/${suffix}`;
  const english = `https://miyabisun.github.io/arona-gacha-calc/en/${suffix}`;
  return `<link rel="alternate" hreflang="ja" href="${japanese}"><link rel="alternate" hreflang="en" href="${english}"><link rel="alternate" hreflang="x-default" href="${japanese}">`;
}

function localizeShell(html, locale, page) {
  const navPattern = /<nav class="nav">.*?<\/nav>/;
  if (!navPattern.test(html)) throw new Error('Navigation source not found');
  let localized = html
    .replace('</style>', `${LANGUAGE_SWITCH_CSS}</style>`)
    .replace('</head>', `${alternateLinks(page)}</head>`)
    .replace(navPattern, languageNav(locale, page));
  if (page === 'index') {
    localized = localized.replace('</body>', '<script>const languageLink=document.querySelector(\'.language-switch a\'),syncLanguageLink=()=>{languageLink.hash=location.hash};for(const event of [\'pointerenter\',\'pointerdown\',\'focus\'])languageLink.addEventListener(event,syncLanguageLink);addEventListener(\'popstate\',syncLanguageLink);syncLanguageLink()</script></body>');
  }
  return localized;
}

module.exports = { localizeShell, replaceExact };
