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
let pendingDeleteType = null;   // 'goal' | 'post' | 'subject' | 'session'

let posts = [];                 // array de {id, title, content, tags:[], createdAt}
let postsUnsub = null;
let selectedTags = new Set();
let activeTagFilter = null;
const DEFAULT_TAGS = ["código","trabalho","estudos","pessoal"];

/* ---- Pomodoro ---- */
let subjects = [];              // array de {id, name, color}
let subjectsUnsub = null;
let pomoSessions = [];          // array de {id, subjectId, subjectName, color, minutes, dateStr, createdAt}
let sessionsUnsub = null;
let selectedSubjectId = null;
let selectedSubjectColor = "#F2B84B";   // cor escolhida no modal de nova matéria

let pomoPhase = "focus";        // 'focus' | 'break'
let pomoRunning = false;
let pomoInterval = null;
let pomoFocusMinutes = 25;
let pomoBreakMinutes = 5;
let pomoRemainingSeconds = pomoFocusMinutes * 60;
let pomoFocusElapsedSeconds = 0;
const POMO_RING_CIRCUMFERENCE = 2 * Math.PI * 88;

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

/* ---- XP da Coruja ---- */
const XP_PER_TYPE = { daily:10, weekly:25, monthly:50 };
// XP acumulado necessário para alcançar cada nível: 20 * (nível-1)^2 — cresce sem teto.
function xpThreshold(level){ return 20 * (level - 1) * (level - 1); }
function levelForXP(xp){
  let level = Math.max(1, Math.floor(1 + Math.sqrt(xp / 20)));
  while (xpThreshold(level) > xp) level--;
  while (xpThreshold(level + 1) <= xp) level++;
  return level;
}
const OWL_TIERS = [
  { minLevel:50, key:"omega",         label:"Coruja Ômega",     color:"var(--rank-omega)" },
  { minLevel:25, key:"estrela",       label:"Coruja Estelar",   color:"var(--rank-estrela)" },
  { minLevel:10, key:"intermediario", label:"Coruja Vigilante", color:"var(--rank-intermediario)" },
  { minLevel:1,  key:"basico",        label:"Coruja Filhote",   color:"var(--rank-basico)" },
];
function getOwlTier(level){
  for (const t of OWL_TIERS) if (level >= t.minLevel) return t;
  return OWL_TIERS[OWL_TIERS.length - 1];
}
function computeOwlState(){
  let totalXp = 0, totalCompletions = 0;
  goals.forEach(g => {
    const n = g.completions.length;
    totalCompletions += n;
    totalXp += n * (XP_PER_TYPE[g.type] || 10);
  });
  const level = levelForXP(totalXp);
  const cur = xpThreshold(level);
  const next = xpThreshold(level + 1);
  const into = totalXp - cur;
  const span = next - cur;
  const pct = span > 0 ? Math.min(100, (into / span) * 100) : 100;
  const tier = getOwlTier(level);
  return { totalXp, totalCompletions, level, into, span, next, pct, tier };
}

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
    subscribeSubjects(user.uid);
    subscribeSessions(user.uid);
  } else {
    appEl.classList.add("hidden");
    authScreen.classList.remove("hidden");
    if (goalsUnsub) { goalsUnsub(); goalsUnsub = null; }
    if (postsUnsub) { postsUnsub(); postsUnsub = null; }
    if (subjectsUnsub) { subjectsUnsub(); subjectsUnsub = null; }
    if (sessionsUnsub) { sessionsUnsub(); sessionsUnsub = null; }
    goals = [];
    posts = [];
    subjects = [];
    pomoSessions = [];
    selectedSubjectId = null;
    activeTagFilter = null;
    resetTimer();
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
   4c. Firestore — matérias e sessões de Pomodoro
--------------------------------------------------------- */
function subjectsRef(uid){
  return db.collection("users").doc(uid).collection("subjects");
}
function sessionsRef(uid){
  return db.collection("users").doc(uid).collection("pomodoroSessions");
}

function subscribeSubjects(uid){
  if (subjectsUnsub) subjectsUnsub();
  subjectsUnsub = subjectsRef(uid).orderBy("createdAt", "asc").onSnapshot((snap) => {
    subjects = snap.docs.map(doc => {
      const data = doc.data();
      return { id: doc.id, name: data.name, color: data.color || "#4FA3E3" };
    });
    if (selectedSubjectId && !subjects.some(s => s.id === selectedSubjectId)) selectedSubjectId = null;
    renderSubjectChips();
    renderSubjectManageList();
  }, (err) => {
    console.error(err);
    showToast("Erro ao carregar matérias: " + err.message);
  });
}
async function addSubject(name, color){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await subjectsRef(user.uid).add({
      name, color, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast("Matéria adicionada.");
  } catch(err){
    console.error(err);
    showToast("Erro ao adicionar matéria: " + err.message);
  }
}
async function deleteSubject(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await subjectsRef(user.uid).doc(id).delete();
    showToast("Matéria removida.");
  } catch(err){
    console.error(err);
    showToast("Erro ao remover matéria: " + err.message);
  }
}

function subscribeSessions(uid){
  if (sessionsUnsub) sessionsUnsub();
  sessionsUnsub = sessionsRef(uid).orderBy("createdAt", "desc").limit(500).onSnapshot((snap) => {
    pomoSessions = snap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        subjectId: data.subjectId || null,
        subjectName: data.subjectName || "Sem matéria",
        color: data.color || "#8B90AC",
        minutes: data.minutes || 0,
        dateStr: data.dateStr,
        createdAt: data.createdAt || null,
      };
    });
    renderPomodoroStats();
    if (document.getElementById("view-calendario").classList.contains("active")) renderCalendar();
    if (document.getElementById("view-coruja").classList.contains("active")) renderCoruja();
  }, (err) => {
    console.error(err);
    showToast("Erro ao carregar sessões: " + err.message);
  });
}
async function logPomoSession(minutes){
  const user = auth.currentUser;
  if (!user || !selectedSubjectId || minutes < 1) return;
  const subject = subjects.find(s => s.id === selectedSubjectId);
  if (!subject) return;
  try{
    await sessionsRef(user.uid).add({
      subjectId: subject.id,
      subjectName: subject.name,
      color: subject.color,
      minutes: Math.round(minutes),
      dateStr: todayStr(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast(`+${Math.round(minutes)} min registrados em ${subject.name}.`);
  } catch(err){
    console.error(err);
    showToast("Erro ao registrar sessão: " + err.message);
  }
}
async function deleteSession(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await sessionsRef(user.uid).doc(id).delete();
    showToast("Sessão excluída.");
  } catch(err){
    console.error(err);
    showToast("Erro ao excluir sessão: " + err.message);
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
  if (view === "coruja") renderCoruja();
  if (view === "pomodoro") { renderSubjectChips(); renderPomodoroStats(); }
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
   8c. Pomodoro — matérias, timer e histórico
--------------------------------------------------------- */

/* ---- matérias: chips de seleção + gerenciamento no modal ---- */
function renderSubjectChips(){
  const row = document.getElementById("pomoSubjectRow");
  if (subjects.length === 0){
    row.innerHTML = `<div class="pomo-subject-empty">Nenhuma matéria ainda — clique em "gerenciar matérias" para criar a primeira.</div>`;
  } else {
    row.innerHTML = subjects.map(s => `
      <button type="button" class="pomo-subject-chip ${s.id === selectedSubjectId ? "active" : ""}" data-id="${s.id}" style="--chip-color:${s.color}">
        <span class="dot" style="background:${s.color}"></span>${esc(s.name)}
      </button>
    `).join("");
  }
  const current = document.getElementById("pomoCurrentSubject");
  const subj = subjects.find(s => s.id === selectedSubjectId);
  current.textContent = subj ? subj.name : "Escolha uma matéria";
  updateTimerRingColor();
}

document.getElementById("pomoSubjectRow").addEventListener("click", (e) => {
  const chip = e.target.closest(".pomo-subject-chip");
  if (!chip) return;
  selectedSubjectId = chip.dataset.id === selectedSubjectId ? selectedSubjectId : chip.dataset.id;
  renderSubjectChips();
});

function renderSubjectManageList(){
  const list = document.getElementById("subjectManageList");
  if (subjects.length === 0){
    list.innerHTML = `<div class="subject-manage-empty">Nenhuma matéria cadastrada ainda.</div>`;
    return;
  }
  list.innerHTML = subjects.map(s => `
    <div class="subject-manage-row">
      <span class="subject-manage-row-name"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</span>
      <button type="button" class="subject-delete" data-id="${s.id}" title="Remover matéria">🗑</button>
    </div>
  `).join("");
}

const newSubjectModal = document.getElementById("newSubjectModal");
document.getElementById("openSubjectModalBtn").addEventListener("click", () => {
  document.getElementById("newSubjectForm").reset();
  selectedSubjectColor = "#F2B84B";
  document.querySelectorAll("#subjectColorPicker .color-swatch").forEach((sw, i) => sw.classList.toggle("selected", i === 0));
  renderSubjectManageList();
  openModal("newSubjectModal");
});
document.getElementById("closeNewSubjectModal").addEventListener("click", () => closeModal("newSubjectModal"));
document.getElementById("subjectColorPicker").addEventListener("click", (e) => {
  const sw = e.target.closest(".color-swatch");
  if (!sw) return;
  selectedSubjectColor = sw.dataset.color;
  document.querySelectorAll("#subjectColorPicker .color-swatch").forEach(s => s.classList.remove("selected"));
  sw.classList.add("selected");
});
document.getElementById("newSubjectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("newSubjectName").value.trim();
  if (!name) return;
  await addSubject(name, selectedSubjectColor);
  document.getElementById("newSubjectForm").reset();
  document.querySelectorAll("#subjectColorPicker .color-swatch").forEach((sw, i) => sw.classList.toggle("selected", i === 0));
  selectedSubjectColor = "#F2B84B";
});
document.getElementById("subjectManageList").addEventListener("click", (e) => {
  const btn = e.target.closest(".subject-delete");
  if (!btn) return;
  pendingDeleteId = btn.dataset.id;
  pendingDeleteType = "subject";
  document.getElementById("confirmModalTitle").textContent = "Remover matéria?";
  document.getElementById("confirmModalText").textContent = "As sessões já registradas com essa matéria continuam no seu histórico. Não pode ser desfeita.";
  openModal("confirmModal");
});

/* ---- timer ---- */
function formatClock(totalSeconds){
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function currentPhaseTotalSeconds(){
  return (pomoPhase === "focus" ? pomoFocusMinutes : pomoBreakMinutes) * 60;
}
function updateTimerRingColor(){
  const subj = subjects.find(s => s.id === selectedSubjectId);
  const color = pomoPhase === "break" ? "var(--success)" : (subj ? subj.color : "var(--rank-intermediario)");
  document.querySelector(".pomo-timer-card").style.setProperty("--pomo-color", color);
}
function updateTimerDisplay(){
  document.getElementById("pomoClock").textContent = formatClock(pomoRemainingSeconds);
  document.getElementById("pomoPhaseLabel").textContent = pomoPhase === "focus" ? "Foco" : "Pausa";
  document.getElementById("pomoStartPauseBtn").textContent = pomoRunning ? "Pausar" : "Iniciar";
  updateTimerRingColor();

  const total = currentPhaseTotalSeconds();
  const pct = total > 0 ? (total - pomoRemainingSeconds) / total : 0;
  const offset = POMO_RING_CIRCUMFERENCE * (1 - pct);
  document.getElementById("pomoRingProgress").style.strokeDashoffset = String(offset);

  document.querySelectorAll(".pomo-duration-btn").forEach(btn => {
    btn.classList.toggle("active", Number(btn.dataset.min) === pomoFocusMinutes);
    btn.disabled = pomoRunning;
  });
}
function tickTimer(){
  pomoRemainingSeconds--;
  if (pomoPhase === "focus") pomoFocusElapsedSeconds++;
  if (pomoRemainingSeconds <= 0){
    completePhase();
  } else {
    updateTimerDisplay();
  }
}
function startTimer(){
  if (pomoRunning) return;
  if (pomoPhase === "focus" && !selectedSubjectId){
    showToast("Escolha uma matéria antes de iniciar o foco.");
    return;
  }
  pomoRunning = true;
  pomoInterval = setInterval(tickTimer, 1000);
  updateTimerDisplay();
}
function pauseTimer(){
  pomoRunning = false;
  clearInterval(pomoInterval);
  pomoInterval = null;
  updateTimerDisplay();
}
function resetTimer(){
  pauseTimer();
  pomoPhase = "focus";
  pomoRemainingSeconds = pomoFocusMinutes * 60;
  pomoFocusElapsedSeconds = 0;
  updateTimerDisplay();
}
function completePhase(){
  pauseTimer();
  if (pomoPhase === "focus"){
    logPomoSession(pomoFocusMinutes);
    pomoFocusElapsedSeconds = 0;
    pomoPhase = "break";
    pomoRemainingSeconds = pomoBreakMinutes * 60;
    showToast("Foco concluído! Hora da pausa. 🦉");
  } else {
    pomoPhase = "focus";
    pomoRemainingSeconds = pomoFocusMinutes * 60;
    showToast("Pausa concluída — bora focar de novo.");
  }
  updateTimerDisplay();
}
function skipPhase(){
  const wasRunning = pomoRunning;
  pauseTimer();
  if (pomoPhase === "focus" && pomoFocusElapsedSeconds >= 60){
    logPomoSession(Math.round(pomoFocusElapsedSeconds / 60));
  }
  pomoFocusElapsedSeconds = 0;
  pomoPhase = pomoPhase === "focus" ? "break" : "focus";
  pomoRemainingSeconds = currentPhaseTotalSeconds();
  updateTimerDisplay();
  if (wasRunning) showToast("Fase pulada.");
}

document.getElementById("pomoStartPauseBtn").addEventListener("click", () => {
  if (pomoRunning) pauseTimer(); else startTimer();
});
document.getElementById("pomoResetBtn").addEventListener("click", () => {
  resetTimer();
  showToast("Timer reiniciado.");
});
document.getElementById("pomoSkipBtn").addEventListener("click", skipPhase);
document.getElementById("pomoDurationRow").addEventListener("click", (e) => {
  const btn = e.target.closest(".pomo-duration-btn");
  if (!btn || pomoRunning) return;
  pomoFocusMinutes = Number(btn.dataset.min);
  if (pomoPhase === "focus") pomoRemainingSeconds = pomoFocusMinutes * 60;
  updateTimerDisplay();
});

/* ---- estatísticas do dia + histórico ---- */
function formatMinutes(total){
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  return `${h}h ${m}min`;
}
function formatHistoryDate(dateStr){
  const [y,m,d] = dateStr.split("-").map(Number);
  const today = todayStr();
  const yestDate = new Date(); yestDate.setDate(yestDate.getDate() - 1);
  const yesterday = `${yestDate.getFullYear()}-${String(yestDate.getMonth()+1).padStart(2,"0")}-${String(yestDate.getDate()).padStart(2,"0")}`;
  if (dateStr === today) return "Hoje";
  if (dateStr === yesterday) return "Ontem";
  return `${d} de ${MONTH_NAMES[m-1]} de ${y}`;
}

function renderPomodoroStats(){
  const today = todayStr();
  const todaySessions = pomoSessions.filter(s => s.dateStr === today);
  const todayTotal = todaySessions.reduce((sum, s) => sum + s.minutes, 0);
  const allTimeTotal = pomoSessions.reduce((sum, s) => sum + s.minutes, 0);

  document.getElementById("pomoTodayTotal").textContent = formatMinutes(todayTotal);
  document.getElementById("pomoTodaySessions").textContent = `${todaySessions.length} sessões concluídas`;
  document.getElementById("pomoAllTimeTotal").textContent = formatMinutes(allTimeTotal);

  const breakdownList = document.getElementById("pomoBreakdownList");
  if (todaySessions.length === 0){
    breakdownList.innerHTML = `<div class="pomo-breakdown-empty">Nenhuma sessão concluída hoje ainda.</div>`;
  } else {
    const bySubject = {};
    todaySessions.forEach(s => {
      const key = s.subjectId || s.subjectName;
      if (!bySubject[key]) bySubject[key] = { name: s.subjectName, color: s.color, minutes: 0 };
      bySubject[key].minutes += s.minutes;
    });
    const rows = Object.values(bySubject).sort((a,b) => b.minutes - a.minutes);
    const max = Math.max(...rows.map(r => r.minutes));
    breakdownList.innerHTML = rows.map(r => `
      <div class="pomo-breakdown-row">
        <div class="pomo-breakdown-row-top">
          <span class="name"><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</span>
          <span class="time">${formatMinutes(r.minutes)}</span>
        </div>
        <div class="pomo-breakdown-bar-track">
          <div class="pomo-breakdown-bar-fill" style="width:${max > 0 ? (r.minutes / max) * 100 : 0}%; background:${r.color}"></div>
        </div>
      </div>
    `).join("");
  }

  const historyList = document.getElementById("pomoHistoryList");
  if (pomoSessions.length === 0){
    historyList.innerHTML = `<div class="pomo-history-empty">Suas sessões de estudo vão aparecer aqui, agrupadas por dia.</div>`;
    return;
  }
  const byDate = {};
  pomoSessions.forEach(s => {
    if (!byDate[s.dateStr]) byDate[s.dateStr] = [];
    byDate[s.dateStr].push(s);
  });
  const dates = Object.keys(byDate).sort((a,b) => b.localeCompare(a));
  historyList.innerHTML = dates.map(dateStr => {
    const entries = byDate[dateStr];
    const total = entries.reduce((sum, s) => sum + s.minutes, 0);
    return `
      <div class="pomo-history-day">
        <div class="pomo-history-day-head">
          <span class="pomo-history-day-date">${formatHistoryDate(dateStr)}</span>
          <span class="pomo-history-day-total">${formatMinutes(total)}</span>
        </div>
        <div class="pomo-history-entries">
          ${entries.map(s => `
            <span class="pomo-history-entry">
              <span class="dot" style="background:${s.color}"></span>
              <span class="label">${esc(s.subjectName)}</span>
              <span class="mins">${s.minutes}min</span>
              <button type="button" class="entry-delete" data-id="${s.id}" title="Excluir sessão">&times;</button>
            </span>
          `).join("")}
        </div>
      </div>
    `;
  }).join("");
}

document.getElementById("pomoHistoryList").addEventListener("click", (e) => {
  const btn = e.target.closest(".entry-delete");
  if (!btn) return;
  pendingDeleteId = btn.dataset.id;
  pendingDeleteType = "session";
  document.getElementById("confirmModalTitle").textContent = "Excluir sessão?";
  document.getElementById("confirmModalText").textContent = "Essa ação apaga esse registro de tempo estudado. Não pode ser desfeita.";
  openModal("confirmModal");
});

updateTimerDisplay(); // estado inicial do relógio (25:00) antes de qualquer login

/* ---------------------------------------------------------
   9. Excluir meta / publicação — modal de confirmação
--------------------------------------------------------- */
document.getElementById("closeConfirmModal").addEventListener("click", () => closeModal("confirmModal"));
document.getElementById("cancelDeleteBtn").addEventListener("click", () => closeModal("confirmModal"));
document.getElementById("confirmDeleteBtn").addEventListener("click", async () => {
  if (pendingDeleteId && pendingDeleteType === "goal") await deleteGoal(pendingDeleteId);
  if (pendingDeleteId && pendingDeleteType === "post") await deletePost(pendingDeleteId);
  if (pendingDeleteId && pendingDeleteType === "subject") await deleteSubject(pendingDeleteId);
  if (pendingDeleteId && pendingDeleteType === "session") await deleteSession(pendingDeleteId);
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
    const daySessions = pomoSessions.filter(s => s.dateStr === dateStr);
    const dayMinutes = daySessions.reduce((sum, s) => sum + s.minutes, 0);
    const timeBadge = dayMinutes > 0 ? `<span class="cal-day-time">${formatMinutes(dayMinutes)}</span>` : "";
    html += `
      <div class="cal-day ${dateStr === today ? "today" : ""}" data-date="${dateStr}">
        <span class="cal-day-num">${day}</span>
        ${timeBadge}
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

  renderCalendarStudySummary();
}

function renderCalendarStudySummary(){
  const { year, month } = calendarCursor;
  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
  const yearPrefix = `${year}-`;

  const monthSessions = pomoSessions.filter(s => s.dateStr && s.dateStr.startsWith(monthPrefix));
  const yearSessions = pomoSessions.filter(s => s.dateStr && s.dateStr.startsWith(yearPrefix));

  const monthTotal = monthSessions.reduce((sum, s) => sum + s.minutes, 0);
  const yearTotal = yearSessions.reduce((sum, s) => sum + s.minutes, 0);

  const monthTotalEl = document.getElementById("studySummaryMonthTotal");
  const yearTotalEl = document.getElementById("studySummaryYearTotal");
  if (monthTotalEl) monthTotalEl.textContent = formatMinutes(monthTotal);
  if (yearTotalEl) yearTotalEl.textContent = formatMinutes(yearTotal);

  const listEl = document.getElementById("studySummaryList");
  if (!listEl) return;

  if (monthSessions.length === 0){
    listEl.innerHTML = `<div class="pomo-breakdown-empty">Nenhuma sessão de estudo registrada neste mês ainda.</div>`;
    return;
  }

  const bySubject = {};
  monthSessions.forEach(s => {
    const key = s.subjectId || s.subjectName;
    if (!bySubject[key]) bySubject[key] = { name: s.subjectName, color: s.color, minutes: 0 };
    bySubject[key].minutes += s.minutes;
  });
  const rows = Object.values(bySubject).sort((a, b) => b.minutes - a.minutes);
  const max = Math.max(...rows.map(r => r.minutes));

  listEl.innerHTML = rows.map(r => `
    <div class="pomo-breakdown-row">
      <div class="pomo-breakdown-row-top">
        <span class="name"><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</span>
        <span class="time">${formatMinutes(r.minutes)}</span>
      </div>
      <div class="pomo-breakdown-bar-track">
        <div class="pomo-breakdown-bar-fill" style="width:${max > 0 ? (r.minutes / max) * 100 : 0}%; background:${r.color}"></div>
      </div>
    </div>
  `).join("");
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

function renderDayModalStudy(dateStr){
  const container = document.getElementById("dayModalStudy");
  if (!container) return;
  const daySessions = pomoSessions.filter(s => s.dateStr === dateStr);
  const total = daySessions.reduce((sum, s) => sum + s.minutes, 0);

  if (daySessions.length === 0){
    container.innerHTML = `
      <div class="day-modal-study-head">
        <span>Tempo estudado</span>
        <span class="day-modal-study-total">0min</span>
      </div>
      <div class="pomo-breakdown-empty">Nenhuma sessão de estudo registrada neste dia.</div>
    `;
    return;
  }

  const bySubject = {};
  daySessions.forEach(s => {
    const key = s.subjectId || s.subjectName;
    if (!bySubject[key]) bySubject[key] = { name: s.subjectName, color: s.color, minutes: 0 };
    bySubject[key].minutes += s.minutes;
  });
  const rows = Object.values(bySubject).sort((a, b) => b.minutes - a.minutes);
  const max = Math.max(...rows.map(r => r.minutes));

  container.innerHTML = `
    <div class="day-modal-study-head">
      <span>Tempo estudado</span>
      <span class="day-modal-study-total">${formatMinutes(total)}</span>
    </div>
    <div class="pomo-breakdown-list">
      ${rows.map(r => `
        <div class="pomo-breakdown-row">
          <div class="pomo-breakdown-row-top">
            <span class="name"><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</span>
            <span class="time">${formatMinutes(r.minutes)}</span>
          </div>
          <div class="pomo-breakdown-bar-track">
            <div class="pomo-breakdown-bar-fill" style="width:${max > 0 ? (r.minutes / max) * 100 : 0}%; background:${r.color}"></div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function openDayModal(dateStr){
  const [y,m,d] = dateStr.split("-").map(Number);
  const label = `${d} de ${MONTH_NAMES[m-1]} de ${y}`;
  document.getElementById("dayModalTitle").textContent = label;
  renderDayModalStudy(dateStr);
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
   10.5 Coruja (XP)
--------------------------------------------------------- */
function renderCoruja(){
  const state = computeOwlState();

  const visual = document.getElementById("owlVisual");
  visual.style.setProperty("--owl-color", state.tier.color);

  const badge = document.getElementById("owlTierBadge");
  badge.textContent = state.tier.label;
  badge.style.setProperty("--owl-badge-color", state.tier.color);

  document.getElementById("owlLevelLabel").textContent = `Nível ${state.level}`;

  const fill = document.getElementById("xpBarFill");
  fill.style.width = `${state.pct}%`;
  fill.style.setProperty("--owl-badge-color", state.tier.color);

  document.getElementById("xpBarLabel").textContent =
    `${state.into.toLocaleString("pt-BR")} / ${state.span.toLocaleString("pt-BR")} XP para o nível ${state.level + 1}`;
  document.getElementById("owlTotalXp").textContent = state.totalXp.toLocaleString("pt-BR");
  document.getElementById("owlTotalCompletions").textContent = state.totalCompletions.toLocaleString("pt-BR");
}

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
  renderCoruja();
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
