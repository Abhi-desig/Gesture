// Puts the mascot's art into the page: one file, ui/mascot.svg, for the header
// face and the orb alike, so new artwork is drawn once.

let art = null;

/** Append the art to each element given. Fetched once per page. */
export async function mountMascotArt(...roots) {
  art ??= fetch(new URL('./mascot.svg', import.meta.url)).then((res) => res.text());
  const svg = await art;
  for (const root of roots) root.insertAdjacentHTML('beforeend', svg);
}
