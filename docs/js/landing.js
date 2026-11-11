/* The front page: the tabs of "What are you working on?" and of the Drive folder, and the jumps to its sections.
   Nothing here touches the search itself (main.js). */
const all = (selector, root = document) => [...root.querySelectorAll(selector)];

/* Tabs as the ARIA practices describe them: one tab is in the tab order, the arrow keys move between tabs. */
function tabs(list) {
  const items = all('[role="tab"]', list);
  const panel = (tab) => document.getElementById(tab.getAttribute("aria-controls"));
  const select = (tab, focus) => {
    for (const t of items) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      panel(t).hidden = !on;
    }
    if (focus) {
      tab.focus({ preventScroll: true });
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };
  items.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      const to = step ? items[(i + step + items.length) % items.length] : e.key === "Home" ? items[0] : e.key === "End" ? items[items.length - 1] : null;
      if (!to) return;
      e.preventDefault();
      select(to, true);
    });
  });
}
all('.landing [role="tablist"]').forEach(tabs);

all(".nav-jump").forEach((a) => a.addEventListener("click", (e) => {
  const target = document.querySelector(a.getAttribute("href"));
  if (!target) return;
  e.preventDefault();
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}));

const cta = document.getElementById("cta-search");
if (cta) {
  cta.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => document.getElementById("q").focus({ preventScroll: true }), 400);
  });
}
