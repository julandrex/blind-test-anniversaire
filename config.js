// Connexion au projet Supabase "blind-test-anniversaire".
// La clé "anon" est publique par conception : la sécurité est assurée côté base
// (RLS + fonctions, et le code PIN pour l'animateur).
window.QUIZ_CONFIG = {
  supabaseUrl: "https://eebmedpowzrpccbfijje.supabase.co",
  supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVlYm1lZHBvd3pycGNjYmZpamplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyOTAwNTEsImV4cCI6MjEwODg2NjA1MX0.GO_QU0KOfOonxv3aJ4iZs-DiD0FF1cM7elR15kyvCnE",
  // Durée (s) pendant laquelle le bonus de rapidité diminue — doit correspondre à private.score_for
  bonusSeconds: 30,
  // Adresse publique de la page invités (utilisée pour le QR code). Vide = déduite de l'adresse actuelle.
  publicUrl: "https://julandrex.github.io/blind-test-anniversaire/"
};

window.playerUrl = QUIZ_CONFIG.publicUrl || new URL("./", location.href).href;
window.isLocalUrl = !/^https?:/.test(playerUrl) || /\/\/(localhost|127\.0\.0\.1)/.test(playerUrl);

window.quizDb = supabase.createClient(QUIZ_CONFIG.supabaseUrl, QUIZ_CONFIG.supabaseKey, {
  auth: { persistSession: false }
});

window.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Rafraîchit `refresh` à chaque changement de la partie (temps réel) + filet de sécurité par polling.
window.watchGame = (refresh, pollMs) => {
  quizDb.channel("game").on("postgres_changes", { event: "*", schema: "public", table: "game" }, () => refresh()).subscribe();
  setInterval(refresh, pollMs);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  refresh();
};

// Avatars : petite pastille (photo si le joueur en a mis une, sinon initiale).
// Les photos sont chargées à part et une seule fois, dès qu'une pastille apparaît dans la page.
const avatarCache = {};
window.avatarTag = (id, name) => `<i class="av" data-av="${esc(id)}">${esc((name || "?").trim().charAt(0).toUpperCase())}</i>`;

function paintAvatars() {
  document.querySelectorAll(".av[data-av]:not([data-done])").forEach((el) => {
    const id = el.dataset.av;
    if (!(id in avatarCache)) return;
    el.dataset.done = "1";
    if (avatarCache[id]) { const img = new Image(); img.alt = ""; img.src = avatarCache[id]; el.replaceChildren(img); }
  });
}

let avatarTimer = null;
async function loadAvatars() {
  avatarTimer = null;
  const ids = [...new Set([...document.querySelectorAll(".av[data-av]")].map((el) => el.dataset.av))].filter((id) => !(id in avatarCache));
  if (ids.length) {
    const { data, error } = await quizDb.rpc("get_avatars", { p_ids: ids.slice(0, 100) });
    if (error) return;
    ids.slice(0, 100).forEach((id) => { avatarCache[id] = data?.[id] || null; });
  }
  paintAvatars();
}
new MutationObserver(() => {
  paintAvatars();
  if (!avatarTimer && document.querySelector(".av[data-av]:not([data-done])")) avatarTimer = setTimeout(loadAvatars, 150);
}).observe(document.body, { childList: true, subtree: true });
