// Small helpers shared by the phone page and the host page. Names and answers always go in
// through textContent, never innerHTML, so nothing a player types can become markup.
export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const ranked = (players) => [...players].sort((a, b) => b.score - a.score || b.raceWins - a.raceWins);
export const ordinal = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
export const tierLevel = (points) => (points >= 85 ? 5 : points >= 60 ? 4 : points >= 30 ? 3 : points >= 15 ? 2 : 1);

export function tierBadge(entry) {
  const badge = el('span', 'tier', entry.tier);
  badge.dataset.level = String(tierLevel(entry.points ?? 0));
  return badge;
}

export function fillBoard(list, players, meId) {
  list.replaceChildren(...ranked(players).map((p, i) => {
    const row = el('li', p.id === meId ? 'me' : '');
    const name = el('span', 'name', p.name);
    name.setAttribute('dir', 'auto');
    row.append(el('span', 'pos', String(i + 1)), name, el('span', 'score', String(p.score)), el('span', 'wins', p.raceWins ? `⚡${p.raceWins}` : ''));
    return row;
  }));
}

export async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}
