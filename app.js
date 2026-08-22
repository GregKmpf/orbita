/* ==========================================================
   ÓRBITA — app.js
   ========================================================== */

/* ---------------------------------------------------------
   0. Estado global
--------------------------------------------------------- */
let goals = [];              // array de {id, name, type, color, completions:[]}
let goalsUnsub = null;       // função para cancelar o listener do Firestore
let calendarCursor = (() => {
  const n = new Date();
  return { year: n.getFullYear(), month: n.getMonth() };
})();
let selectedColor = "#F2B84B";
let pendingDeleteId = null;
let pendingDeleteType = null;   // 'goal' | 'post'

let posts = [];                 // array de {id, title, content, tags:[], createdAt}
let postsUnsub = null;
let selectedTags = new Set();
let activeTagFilter = null;
const DEFAULT_TAGS = ["código","trabalho","estudos","pessoal"];

const MONTH_NAMES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

const TYPE_META = {
  daily:   { label:"Diárias",  unit:"dias seguidos",    completeLabel:"Concluir hoje",   nodes:14 },
  weekly:  { label:"Semanais", unit:"semanas seguidas", completeLabel:"Concluir semana", nodes:8  },
  monthly: { label:"Mensais",  unit:"meses seguidos",   completeLabel:"Concluir mês",    nodes:6  },
};

const RANKS = [
  { key:"omega",         label:"Ômega",         min:100, icon:"Ω", color:"var(--rank-omega)" },
  { key:"estrela",       label:"Estrela",       min:30,  icon:"★", color:"var(--rank-estrela)" },
  { key:"intermediario", label:"Intermediário", min:7,   icon:"◐", color:"var(--rank-intermediario)" },
  { key:"basico",        label:"Básico",        min:1,   icon:"●", color:"var(--rank-basico)" },
];
const RANK_NONE = { key:"none", label:"Sem sequência", min:0, icon:"—", color:"var(--ink-700)" };

/* ---------------------------------------------------------
   1. Utilidades de data
--------------------------------------------------------- */
function todayStr(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function dayIndex(dateStr){
  const [y,m,d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m-1, d) / 86400000;
}
function weekIndex(dateStr){
  const [y,m,d] = dateStr.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m-1, d));
  const weekday = (utc.getUTCDay() + 6) % 7; // segunda=0 ... domingo=6
  const mondayIdx = dayIndex(dateStr) - weekday;
  return Math.floor(mondayIdx / 7);
}
function monthIndex(dateStr){
  const [y,m] = dateStr.split("-").map(Number);
  return y*12 + (m-1);
}
function indexFnFor(type){
  return type === "daily" ? dayIndex : type === "weekly" ? weekIndex : monthIndex;
}
function currentIndexFor(type){
  return indexFnFor(type)(todayStr());
}

/* ---------------------------------------------------------
   2. Cálculo de sequências e nível
--------------------------------------------------------- */
function computeStreaks(completions, type){
  const idxFn = indexFnFor(type);
  const indices = Array.from(new Set(completions.map(idxFn))).sort((a,b) => a-b);
  if (indices.length === 0) return { current:0, best:0, indexSet:new Set() };

  let best = 1, run = 1;
  for (let i=1; i<indices.length; i++){
    run = (indices[i] === indices[i-1] + 1) ? run+1 : 1;
    if (run > best) best = run;
  }

  const todayIdx = currentIndexFor(type);
  const lastIdx = indices[indices.length - 1];
  let current = 0;
  if (lastIdx === todayIdx || lastIdx === todayIdx - 1){
    current = 1;
    for (let i=indices.length-2; i>=0; i--){
      if (indices[i] === indices[i+1] - 1) current++; else break;
    }
  }
  return { current, best, indexSet:new Set(indices) };
}
function getRank(streak){
  for (const r of RANKS) if (streak >= r.min) return r;
  return RANK_NONE;
}

/* ---------------------------------------------------------
   3. Firebase Auth
--------------------------------------------------------- */
let authMode = "login";

const authScreen = document.getElementById("authScreen");
const appEl = document.getElementById("app");
const authForm = document.getElementById("authForm");
const authEmail = document.getElementById("authEmail");
const authPassword = document.getElementById("authPassword");
const authError = document.getElementById("authError");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const authToggleMode = document.getElementById("authToggleMode");
const userEmailLabel = document.getElementById("userEmailLabel");

authToggleMode.addEventListener("click", () => {
  authMode = authMode === "login" ? "signup" : "login";
  authSubmitBtn.textContent = authMode === "login" ? "Entrar" : "Criar conta";
  authToggleMode.textContent = authMode === "login"
    ? "Ainda não tenho conta — criar agora"
    : "Já tenho conta — entrar";
  authError.hidden = true;
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.hidden = true;
  const email = authEmail.value.trim();
  const password = authPassword.value;
  authSubmitBtn.disabled = true;
  try{
    if (authMode === "login"){
      await auth.signInWithEmailAndPassword(email, password);
    } else {
      await auth.createUserWithEmailAndPassword(email, password);
    }
  } catch(err){
    authError.textContent = traduzErroFirebase(err);
    authError.hidden = false;
  } finally {
    authSubmitBtn.disabled = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => auth.signOut());

function traduzErroFirebase(err){
  const map = {
    "auth/invalid-email": "E-mail inválido.",
    "auth/user-not-found": "Usuário não encontrado.",
    "auth/wrong-password": "Senha incorreta.",
    "auth/email-already-in-use": "Esse e-mail já tem uma conta.",
    "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/network-request-failed": "Falha de rede. Verifique sua conexão.",
    "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "Configuração do Firebase inválida — confira firebase-config.js.",
  };
  return map[err.code] || (err.message || "Não foi possível concluir. Tente novamente.");
}

auth.onAuthStateChanged((user) => {
  if (user){
    authScreen.classList.add("hidden");
    appEl.classList.remove("hidden");
    userEmailLabel.textContent = user.email;
    subscribeGoals(user.uid);
    subscribePosts(user.uid);
  } else {
    appEl.classList.add("hidden");
    authScreen.classList.remove("hidden");
    if (goalsUnsub) { goalsUnsub(); goalsUnsub = null; }
    if (postsUnsub) { postsUnsub(); postsUnsub = null; }
    goals = [];
    posts = [];
    activeTagFilter = null;
  }
});

/* ---------------------------------------------------------
   4. Firestore — metas
--------------------------------------------------------- */
function goalsRef(uid){
  return db.collection("users").doc(uid).collection("goals");
}
function subscribeGoals(uid){
  if (goalsUnsub) goalsUnsub();
  goalsUnsub = goalsRef(uid).orderBy("createdAt", "asc").onSnapshot((snap) => {
    goals = snap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        type: data.type,
        color: data.color || "#4FA3E3",
        completions: Array.isArray(data.completions) ? data.completions : [],
      };
    });
    renderAll();
  }, (err) => {
    console.error(err);
    showToast("Erro ao carregar metas: " + err.message);
  });
}
async function addGoal(name, type, color){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await goalsRef(user.uid).add({
      name, type, color, completions: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast("Meta criada.");
  } catch(err){
    console.error(err);
    showToast("Erro ao criar meta: " + err.message);
  }
}
async function deleteGoal(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await goalsRef(user.uid).doc(id).delete();
    showToast("Meta excluída.");
  } catch(err){
    console.error(err);
    showToast("Erro ao excluir meta: " + err.message);
  }
}
async function toggleCompletion(id, dateStr){
  const user = auth.currentUser;
  if (!user) return;
  const goal = goals.find(g => g.id === id);
  if (!goal) return;
  const has = goal.completions.includes(dateStr);
  const field = has
    ? firebase.firestore.FieldValue.arrayRemove(dateStr)
    : firebase.firestore.FieldValue.arrayUnion(dateStr);
  try{
    await goalsRef(user.uid).doc(id).update({ completions: field });
  } catch(err){
    console.error(err);
    showToast("Erro ao atualizar meta: " + err.message);
  }
}

/* ---------------------------------------------------------
   4b. Firestore — publicações
--------------------------------------------------------- */
function postsRef(uid){
  return db.collection("users").doc(uid).collection("posts");
}
function subscribePosts(uid){
  if (postsUnsub) postsUnsub();
  postsUnsub = postsRef(uid).orderBy("createdAt", "desc").onSnapshot((snap) => {
    posts = snap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title,
        content: data.content,
        tags: Array.isArray(data.tags) ? data.tags : [],
        createdAt: data.createdAt || null,
      };
    });
    renderPosts();
  }, (err) => {
    console.error(err);
    showToast("Erro ao carregar publicações: " + err.message);
  });
}
async function addPost(title, content, tags){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await postsRef(user.uid).add({
      title, content, tags,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast("Publicação criada.");
  } catch(err){
    console.error(err);
    showToast("Erro ao publicar: " + err.message);
  }
}
async function deletePost(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await postsRef(user.uid).doc(id).delete();
    showToast("Publicação excluída.");
  } catch(err){
    console.error(err);
    showToast("Erro ao excluir publicação: " + err.message);
  }
}

/* ---------------------------------------------------------
   5. Navegação por abas
--------------------------------------------------------- */
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const view = btn.dataset.view;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + view).classList.add("active");
  if (view === "calendario") renderCalendar();
});

/* ---------------------------------------------------------
   6. Render — dashboard
--------------------------------------------------------- */
function renderDashboard(){
  const dash = document.getElementById("dashboard");
  if (goals.length === 0){
    dash.innerHTML = `<div class="dash-empty">Cadastre sua primeira meta abaixo para começar a construir sua sequência.</div>`;
    return;
  }
  const withStreak = goals.map(g => ({ g, s: computeStreaks(g.completions, g.type) }));
  const active = withStreak.filter(x => x.s.current > 0);
  const topStreak = withStreak.reduce((max, x) => x.s.current > max.s.current ? x : max, withStreak[0]);
  const highestRank = withStreak.reduce((best, x) => {
    const r = getRank(x.s.current);
    const bi = RANKS.findIndex(rr => rr.key === best.key);
    const ri = RANKS.findIndex(rr => rr.key === r.key);
    if (best.key === "none") return r;
    if (ri !== -1 && (bi === -1 || ri < bi)) return r;
    return best;
  }, RANK_NONE);

  dash.innerHTML = `
    <div class="dash-card">
      <div class="dash-label">Metas cadastradas</div>
      <div class="dash-value">${goals.length}</div>
      <div class="dash-sub">${active.length} em sequência ativa</div>
    </div>
    <div class="dash-card">
      <div class="dash-label">Maior sequência atual</div>
      <div class="dash-value">${topStreak.s.current}</div>
      <div class="dash-sub">${topStreak.s.current > 0 ? esc(topStreak.g.name) : "nenhuma sequência ativa"}</div>
    </div>
    <div class="dash-card">
      <div class="dash-label">Nível mais alto</div>
      <div class="dash-value" style="color:${highestRank.color}">${highestRank.icon} ${highestRank.label}</div>
      <div class="dash-sub">continue firme para evoluir</div>
    </div>
  `;
}

/* ---------------------------------------------------------
   7. Render — colunas de metas
--------------------------------------------------------- */
function buildConstellation(indexSet, currentIdx, count, color){
  let html = "";
  for (let i = count - 1; i >= 0; i--){
    const lit = indexSet.has(currentIdx - i);
    html += `<span class="node ${lit ? "lit" : ""}" style="--goal-color:${color}"></span>`;
  }
  return html;
}

function renderGoalColumns(){
  ["daily","weekly","monthly"].forEach(type => {
    const list = document.getElementById("list-" + type);
    const count = document.getElementById("count-" + type);
    const items = goals.filter(g => g.type === type);
    count.textContent = items.length;

    if (items.length === 0){
      list.innerHTML = `<div class="goal-list-empty">Nenhuma meta ${TYPE_META[type].label.toLowerCase()} ainda.</div>`;
      return;
    }

    const meta = TYPE_META[type];
    const idxFn = indexFnFor(type);
    const curIdx = currentIndexFor(type);

    list.innerHTML = items.map(g => {
      const { current, best, indexSet } = computeStreaks(g.completions, g.type);
      const rank = getRank(current);
      const doneNow = indexSet.has(curIdx);
      const nodes = buildConstellation(indexSet, curIdx, meta.nodes, g.color);
      return `
        <div class="goal-card" style="--goal-color:${g.color}">
          <div class="goal-card-top">
            <div>
              <div class="goal-name">${esc(g.name)}</div>
              <span class="rank-badge" style="--badge-color:${rank.color}">${rank.icon} ${rank.label}</span>
            </div>
            <button class="goal-delete" data-id="${g.id}" title="Excluir meta">🗑</button>
          </div>
          <div class="constellation">${nodes}</div>
          <div class="goal-card-bottom">
            <span class="goal-streak-num"><b>${current}</b> ${meta.unit} &middot; recorde <b>${best}</b></span>
            <button class="goal-complete-btn ${doneNow ? "done" : ""}" data-id="${g.id}" style="--goal-color:${g.color}">
              ${doneNow ? "✓ Feito" : meta.completeLabel}
            </button>
          </div>
        </div>
      `;
    }).join("");
  });
}

document.getElementById("goalColumns").addEventListener("click", async (e) => {
  const completeBtn = e.target.closest(".goal-complete-btn");
  const deleteBtn = e.target.closest(".goal-delete");
  if (completeBtn){
    await toggleCompletion(completeBtn.dataset.id, todayStr());
  } else if (deleteBtn){
    pendingDeleteId = deleteBtn.dataset.id;
    pendingDeleteType = "goal";
    document.getElementById("confirmModalTitle").textContent = "Excluir meta?";
    document.getElementById("confirmModalText").textContent = "Essa ação apaga a meta e todo o histórico de sequência dela. Não pode ser desfeita.";
    openModal("confirmModal");
  }
});

/* ---------------------------------------------------------
   8. Nova meta — modal
--------------------------------------------------------- */
const newGoalModal = document.getElementById("newGoalModal");
document.getElementById("openNewGoalBtn").addEventListener("click", () => {
  document.getElementById("newGoalForm").reset();
  selectedColor = "#F2B84B";
  document.querySelectorAll(".color-swatch").forEach((sw, i) => sw.classList.toggle("selected", i === 0));
  openModal("newGoalModal");
});
document.getElementById("closeNewGoalModal").addEventListener("click", () => closeModal("newGoalModal"));
document.getElementById("colorPicker").addEventListener("click", (e) => {
  const sw = e.target.closest(".color-swatch");
  if (!sw) return;
  selectedColor = sw.dataset.color;
  document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("selected"));
  sw.classList.add("selected");
});
document.getElementById("newGoalForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("newGoalName").value.trim();
  const type = document.getElementById("newGoalType").value;
  if (!name) return;
  await addGoal(name, type, selectedColor);
  closeModal("newGoalModal");
});

/* ---------------------------------------------------------
   8b. Publicações — render, filtro por tag e modal
--------------------------------------------------------- */
function formatPostDate(ts){
  if (!ts || typeof ts.toDate !== "function") return "agora há pouco";
  const d = ts.toDate();
  return `${String(d.getDate()).padStart(2,"0")} de ${MONTH_NAMES[d.getMonth()]} de ${d.getFullYear()}`;
}

function allPostTags(){
  const set = new Set();
  posts.forEach(p => p.tags.forEach(t => set.add(t)));
  return Array.from(set).sort((a,b) => a.localeCompare(b, "pt-BR"));
}

function renderPostsFilter(){
  const filterEl = document.getElementById("postsFilter");
  const tags = allPostTags();
  if (tags.length === 0){
    filterEl.innerHTML = "";
    return;
  }
  filterEl.innerHTML = `
    <button class="tag-filter-btn ${activeTagFilter === null ? "active" : ""}" data-tag="">Todas</button>
    ${tags.map(t => `<button class="tag-filter-btn ${activeTagFilter === t ? "active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}
  `;
}

function renderPosts(){
  renderPostsFilter();
  const list = document.getElementById("postsList");

  if (posts.length === 0){
    list.innerHTML = `<div class="posts-empty">Nenhuma publicação ainda. Compartilhe o que você andou estudando ou pensando.</div>`;
    return;
  }

  const visible = activeTagFilter ? posts.filter(p => p.tags.includes(activeTagFilter)) : posts;
  if (visible.length === 0){
    list.innerHTML = `<div class="posts-empty">Nenhuma publicação com essa tag.</div>`;
    return;
  }

  list.innerHTML = visible.map(p => `
    <article class="post-card">
      <div class="post-card-head">
        <div>
          <h3 class="post-title">${esc(p.title)}</h3>
          <span class="post-date">${formatPostDate(p.createdAt)}</span>
        </div>
        <button class="post-delete" data-id="${p.id}" title="Excluir publicação">🗑</button>
      </div>
      <p class="post-content">${esc(p.content)}</p>
      ${p.tags.length ? `<div class="post-tags">${p.tags.map(t => `<span class="post-tag">${esc(t)}</span>`).join("")}</div>` : ""}
    </article>
  `).join("");
}

document.getElementById("postsFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".tag-filter-btn");
  if (!btn) return;
  activeTagFilter = btn.dataset.tag || null;
  renderPosts();
});

document.getElementById("postsList").addEventListener("click", (e) => {
  const delBtn = e.target.closest(".post-delete");
  if (!delBtn) return;
  pendingDeleteId = delBtn.dataset.id;
  pendingDeleteType = "post";
  document.getElementById("confirmModalTitle").textContent = "Excluir publicação?";
  document.getElementById("confirmModalText").textContent = "Essa ação apaga a publicação permanentemente. Não pode ser desfeita.";
  openModal("confirmModal");
});

function renderCustomTagChips(){
  const container = document.getElementById("customTagChips");
  const custom = Array.from(selectedTags).filter(t => !DEFAULT_TAGS.includes(t));
  container.innerHTML = custom.map(t => `
    <span class="tag-chip custom selected" data-tag="${esc(t)}">${esc(t)} <b class="tag-remove">&times;</b></span>
  `).join("");
}

document.getElementById("openNewPostBtn").addEventListener("click", () => {
  document.getElementById("newPostForm").reset();
  selectedTags = new Set();
  document.querySelectorAll("#tagPicker .tag-chip").forEach(c => c.classList.remove("selected"));
  renderCustomTagChips();
  openModal("newPostModal");
});
document.getElementById("closeNewPostModal").addEventListener("click", () => closeModal("newPostModal"));

document.getElementById("tagPicker").addEventListener("click", (e) => {
  const chip = e.target.closest(".tag-chip");
  if (!chip) return;
  const tag = chip.dataset.tag;
  if (selectedTags.has(tag)){
    selectedTags.delete(tag);
    chip.classList.remove("selected");
  } else {
    selectedTags.add(tag);
    chip.classList.add("selected");
  }
});

document.getElementById("newPostCustomTag").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const input = e.target;
  const tag = input.value.trim().toLowerCase();
  if (!tag) return;
  selectedTags.add(tag);
  input.value = "";
  renderCustomTagChips();
});

document.getElementById("customTagChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".tag-chip.custom");
  if (!chip) return;
  selectedTags.delete(chip.dataset.tag);
  renderCustomTagChips();
});

document.getElementById("newPostForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("newPostTitle").value.trim();
  const content = document.getElementById("newPostContent").value.trim();
  if (!title || !content) return;
  await addPost(title, content, Array.from(selectedTags));
  closeModal("newPostModal");
});

/* ---------------------------------------------------------
   9. Excluir meta / publicação — modal de confirmação
--------------------------------------------------------- */
document.getElementById("closeConfirmModal").addEventListener("click", () => closeModal("confirmModal"));
document.getElementById("cancelDeleteBtn").addEventListener("click", () => closeModal("confirmModal"));
document.getElementById("confirmDeleteBtn").addEventListener("click", async () => {
  if (pendingDeleteId && pendingDeleteType === "goal") await deleteGoal(pendingDeleteId);
  if (pendingDeleteId && pendingDeleteType === "post") await deletePost(pendingDeleteId);
  pendingDeleteId = null;
  pendingDeleteType = null;
  closeModal("confirmModal");
});

/* ---------------------------------------------------------
   10. Calendário
--------------------------------------------------------- */
function renderCalendar(){
  const { year, month } = calendarCursor;
  document.getElementById("calendarMonthLabel").textContent = `${MONTH_NAMES[month]} de ${year}`;

  const grid = document.getElementById("calendarGrid");
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=dom
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  let html = "";
  for (let i = 0; i < firstWeekday; i++) html += `<div class="cal-day empty"></div>`;

  for (let day = 1; day <= daysInMonth; day++){
    const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const dayGoals = goals.filter(g => g.completions.includes(dateStr));
    const dots = dayGoals.slice(0, 8).map(g => `<span class="dot" style="background:${g.color}"></span>`).join("");
    html += `
      <div class="cal-day ${dateStr === today ? "today" : ""}" data-date="${dateStr}">
        <span class="cal-day-num">${day}</span>
        <div class="cal-day-dots">${dots}</div>
      </div>
    `;
  }
  grid.innerHTML = html;

  const legend = document.getElementById("calendarLegend");
  if (goals.length === 0){
    legend.innerHTML = "";
  } else {
    legend.innerHTML = goals.map(g => `
      <div class="legend-item"><span class="dot" style="background:${g.color}"></span>${esc(g.name)}</div>
    `).join("");
  }
}

document.getElementById("prevMonthBtn").addEventListener("click", () => {
  calendarCursor.month--;
  if (calendarCursor.month < 0){ calendarCursor.month = 11; calendarCursor.year--; }
  renderCalendar();
});
document.getElementById("nextMonthBtn").addEventListener("click", () => {
  calendarCursor.month++;
  if (calendarCursor.month > 11){ calendarCursor.month = 0; calendarCursor.year++; }
  renderCalendar();
});
document.getElementById("todayBtn").addEventListener("click", () => {
  const n = new Date();
  calendarCursor = { year: n.getFullYear(), month: n.getMonth() };
  renderCalendar();
});

document.getElementById("calendarGrid").addEventListener("click", (e) => {
  const cell = e.target.closest(".cal-day:not(.empty)");
  if (!cell) return;
  openDayModal(cell.dataset.date);
});

function openDayModal(dateStr){
  const [y,m,d] = dateStr.split("-").map(Number);
  const label = `${d} de ${MONTH_NAMES[m-1]} de ${y}`;
  document.getElementById("dayModalTitle").textContent = label;
  const list = document.getElementById("dayModalList");

  if (goals.length === 0){
    list.innerHTML = `<div class="day-goal-empty">Você ainda não tem metas cadastradas.</div>`;
  } else {
    list.innerHTML = goals.map(g => {
      const on = g.completions.includes(dateStr);
      return `
        <div class="day-goal-row">
          <span class="day-goal-row-name"><span class="dot" style="background:${g.color}"></span>${esc(g.name)}</span>
          <button class="day-toggle ${on ? "on" : ""}" data-id="${g.id}" data-date="${dateStr}">${on ? "✓" : ""}</button>
        </div>
      `;
    }).join("");
  }
  openModal("dayModal");
}

document.getElementById("dayModalList").addEventListener("click", async (e) => {
  const btn = e.target.closest(".day-toggle");
  if (!btn) return;
  await toggleCompletion(btn.dataset.id, btn.dataset.date);
  openDayModal(btn.dataset.date); // re-render com estado atualizado
});

/* ---------------------------------------------------------
   11. Modais — helpers genéricos
--------------------------------------------------------- */
function openModal(id){
  document.getElementById(id).hidden = false;
}
function closeModal(id){
  document.getElementById(id).hidden = true;
}
document.querySelectorAll(".modal-backdrop").forEach(bd => {
  bd.addEventListener("click", (e) => {
    if (e.target === bd) bd.hidden = true;
  });
});
document.getElementById("closeDayModal").addEventListener("click", () => closeModal("dayModal"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape"){
    document.querySelectorAll(".modal-backdrop").forEach(bd => bd.hidden = true);
  }
});

/* ---------------------------------------------------------
   12. Toast
--------------------------------------------------------- */
let toastTimer = null;
function showToast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------------------------------------------------
   13. Render geral
--------------------------------------------------------- */
function renderAll(){
  renderDashboard();
  renderGoalColumns();
  if (document.getElementById("view-calendario").classList.contains("active")) renderCalendar();
}

/* ---------------------------------------------------------
   14. Escapar HTML (evitar XSS ao exibir nomes de metas)
--------------------------------------------------------- */
function esc(str){
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ---------------------------------------------------------
   15. Campo de estrelas decorativo (fundo)
--------------------------------------------------------- */
(function starfield(){
  const canvas = document.getElementById("starfield");
  const ctx = canvas.getContext("2d");
  let stars = [];
  function resize(){
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const count = Math.floor((canvas.width * canvas.height) / 9000);
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.2 + 0.2,
      a: Math.random() * 0.6 + 0.15,
    }));
    draw();
  }
  function draw(){
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    stars.forEach(s => {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(237,239,247,${s.a})`;
      ctx.fill();
    });
  }
  window.addEventListener("resize", resize);
  resize();
})();
