// Six views, one page: the hash says which one is showing (#/screens).
//
// A hash rather than real paths so the server keeps serving one static page,
// and so a reload, a bookmark or the back button all land where you were.

export const VIEWS = ['home', 'gestures', 'screens', 'measure', 'lab', 'settings'];

/** The view a hash names, or home for anything else. */
export function parseRoute(hash) {
  const match = /^#\/([a-z]+)\/?$/.exec(hash ?? '');
  return match && VIEWS.includes(match[1]) ? match[1] : 'home';
}

/**
 * Show one view and mark its link as the current page.
 *
 * Home is never display:none — see `.view-home` in styles.css — because the
 * camera preview lives there, and the non-Chrome detection fallback stops when
 * its video is not rendered.
 */
export function showView(name, root = document) {
  for (const section of root.querySelectorAll('[data-view]')) {
    section.classList.toggle('active', section.dataset.view === name);
  }
  for (const link of root.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
