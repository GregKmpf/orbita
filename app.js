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
let pendingDeleteType = null;   // 'goal' | 'post' | 'subject' | 'session' | 'project' | 'ptask' | 'kboard' | 'kcolumn' | 'kcard' | 'ntrow' | 'ntnote'

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

/* ---- Atividades avulsas (tasks) ---- */
let tasks = [];                 // array de {id, title, dueDate, done, completedDate, createdAt}
let tasksUnsub = null;
/* ---- Projetos ---- */
let projects = [];              // {id, name, description, color, kind, deadline, status, phases:[{id,name}], subjectId}
let projectsUnsub = null;
let projectTasks = [];          // {id, projectId, title, notes, status, priority, dueDate, phaseId, subtasks:[], completedDate}
let projectTasksUnsub = null;
let activeProjectId = null;     // null = visão geral
let projStatusFilter = "active";
let projView = "board";         // 'board' | 'list'
let projPhaseFilter = "all";    // 'all' | 'none' | id da etapa
let projHideDone = false;
let editingProjectId = null;
let editingTaskId = null;
let selectedProjectColor = "#4FA3E3";
let draftPhases = [];           // etapas em edição no modal de projeto
let draftSubtasks = [];         // subtarefas em edição no modal de tarefa

let kbBoards = [];              // {id, name, description, color, columns:[{id,name,done}]}
let kbCards = [];               // {id, boardId, columnId, title, notes, label, dueDate, order}
let kbBoardsUnsub = null;
let kbCardsUnsub = null;
let kbLoaded = false;           // já recebeu os quadros do Firestore?
let kbActiveId = (() => { try{ return localStorage.getItem("orbita.kanban.active") || null; } catch(e){ return null; } })();
let kbSearch = "";
let kbAddingCol = null;         // coluna com o campo "adicionar card" aberto
let kbAddDraft = "";
let kbRendering = false;
let kbDraggedId = null;
let kbBoardColor = "#4FA3E3";
let kbCardLabel = null;
let editingKbBoardId = null;
let editingKbColumnId = null;
let editingKbCardId = null;

let pomoRunning = false;
let pomoInterval = null;
let pomoFocusMinutes = 25;
let pomoBreakMinutes = 5;
let pomoRemainingSeconds = pomoFocusMinutes * 60;
let pomoFocusElapsedSeconds = 0;
let pomoPhaseEndAt = null; // timestamp (ms) em que a fase atual deve zerar
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
  { minLevel:50, maxLevel:null, key:"omega",         label:"Coruja Ômega",     color:"var(--rank-omega)" },
  { minLevel:25, maxLevel:49,   key:"estrela",       label:"Coruja Estelar",   color:"var(--rank-estrela)" },
  { minLevel:10, maxLevel:24,   key:"intermediario", label:"Coruja Vigilante", color:"var(--rank-intermediario)" },
  { minLevel:1,  maxLevel:9,    key:"basico",        label:"Coruja Filhote",   color:"var(--rank-basico)" },
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
  const allIndices = Array.from(new Set(completions.map(idxFn))).sort((a,b) => a-b);
  if (allIndices.length === 0) return { current:0, best:0, indexSet:new Set() };

  const todayIdx = currentIndexFor(type);
  // Datas futuras (ex.: marcadas por engano, ou testes) não contam para a sequência atual
  // nem para o recorde — evita que uma data "adiantada" quebre o cálculo.
  const indices = allIndices.filter(i => i <= todayIdx);
  if (indices.length === 0) return { current:0, best:0, indexSet:new Set(allIndices) };

  let best = 1, run = 1;
  for (let i=1; i<indices.length; i++){
    run = (indices[i] === indices[i-1] + 1) ? run+1 : 1;
    if (run > best) best = run;
  }

  const lastIdx = indices[indices.length - 1];
  let current = 0;
  if (lastIdx === todayIdx || lastIdx === todayIdx - 1){
    current = 1;
    for (let i=indices.length-2; i>=0; i--){
      if (indices[i] === indices[i+1] - 1) current++; else break;
    }
  }
  return { current, best, indexSet:new Set(allIndices) };
}
function getRank(streak){
  for (const r of RANKS) if (streak >= r.min) return r;
  return RANK_NONE;
}

/* ---------------------------------------------------------
   3. Firebase Auth
--------------------------------------------------------- */
const authScreen = document.getElementById("authScreen");
const appEl = document.getElementById("app");
const authForm = document.getElementById("authForm");
const authEmail = document.getElementById("authEmail");
const authPassword = document.getElementById("authPassword");
const authError = document.getElementById("authError");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const userEmailLabel = document.getElementById("userEmailLabel");
const googleProvider = new firebase.auth.GoogleAuthProvider();

// Login por e-mail/senha — só para contas já existentes (sem opção de criar conta nova).
authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.hidden = true;
  const email = authEmail.value.trim();
  const password = authPassword.value;
  authSubmitBtn.disabled = true;
  try{
    await auth.signInWithEmailAndPassword(email, password);
  } catch(err){
    authError.textContent = traduzErroFirebase(err);
    authError.hidden = false;
  } finally {
    authSubmitBtn.disabled = false;
  }
});

// Login com qualquer conta Google.
googleSignInBtn.addEventListener("click", async () => {
  authError.hidden = true;
  googleSignInBtn.disabled = true;
  try{
    await auth.signInWithPopup(googleProvider);
  } catch(err){
    if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request"){
      authError.textContent = traduzErroFirebase(err);
      authError.hidden = false;
    }
  } finally {
    googleSignInBtn.disabled = false;
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
    "auth/popup-blocked": "O navegador bloqueou a janela do Google. Permita pop-ups para este site e tente de novo.",
    "auth/account-exists-with-different-credential": "Esse e-mail já tem conta com senha. Entre usando e-mail e senha.",
    "auth/operation-not-allowed": "Login com Google ainda não foi ativado no Firebase (veja o README.md).",
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
    subscribeTasks(user.uid);
    subscribeProjects(user.uid);
    subscribeProjectTasks(user.uid);
    subscribeKanban(user.uid);
    subscribeNotes(user.uid);
  } else {
    appEl.classList.add("hidden");
    authScreen.classList.remove("hidden");
    if (goalsUnsub) { goalsUnsub(); goalsUnsub = null; }
    if (postsUnsub) { postsUnsub(); postsUnsub = null; }
    if (subjectsUnsub) { subjectsUnsub(); subjectsUnsub = null; }
    if (sessionsUnsub) { sessionsUnsub(); sessionsUnsub = null; }
    if (tasksUnsub) { tasksUnsub(); tasksUnsub = null; }
    if (projectsUnsub) { projectsUnsub(); projectsUnsub = null; }
    if (projectTasksUnsub) { projectTasksUnsub(); projectTasksUnsub = null; }
    if (kbBoardsUnsub) { kbBoardsUnsub(); kbBoardsUnsub = null; }
    if (kbCardsUnsub) { kbCardsUnsub(); kbCardsUnsub = null; }
    if (ntRowsUnsub) { ntRowsUnsub(); ntRowsUnsub = null; }
    if (ntNotesUnsub) { ntNotesUnsub(); ntNotesUnsub = null; }
    goals = [];
    posts = [];
    subjects = [];
    pomoSessions = [];
    tasks = [];
    projects = [];
    projectTasks = [];
    kbBoards = [];
    kbCards = [];
    kbLoaded = false;
    kbAddingCol = null;
    ntRows = [];
    ntNotes = [];
    ntLoaded = false;
    ntSearch = "";
    ntTagFilter = null;
    activeProjectId = null;
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
    if (document.getElementById("view-projetos").classList.contains("active")) renderProjects();
  }, (err) => {
    console.error(err);
    showToast("Erro ao carregar sessões: " + err.message);
  });
}
function tasksRef(uid){
  return db.collection("users").doc(uid).collection("tasks");
}
function subscribeTasks(uid){
  if (tasksUnsub) tasksUnsub();
  tasksUnsub = tasksRef(uid).orderBy("dueDate", "asc").onSnapshot((snap) => {
    tasks = snap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title,
        dueDate: data.dueDate,
        done: !!data.done,
        completedDate: data.completedDate || null,
        createdAt: data.createdAt || null,
      };
    });
    renderUpcomingTasks();
    if (document.getElementById("view-calendario").classList.contains("active")) renderCalendar();
    const openDayForm = document.getElementById("dayTaskAddForm");
    if (openDayForm && !document.getElementById("dayModal").hidden){
      renderDayModalTasks(openDayForm.dataset.date);
    }
  }, (err) => {
    console.error(err);
    showToast("Erro ao carregar atividades: " + err.message);
  });
}
async function addTask(title, dueDate){
  const user = auth.currentUser;
  if (!user || !title.trim()) return;
  try{
    await tasksRef(user.uid).add({
      title: title.trim(), dueDate, done:false, completedDate:null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast("Atividade adicionada.");
  } catch(err){
    console.error(err);
    showToast("Erro ao adicionar atividade: " + err.message);
  }
}
async function completeTask(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await tasksRef(user.uid).doc(id).update({ done:true, completedDate: todayStr() });
    showToast("Atividade concluída!");
  } catch(err){
    console.error(err);
    showToast("Erro ao concluir atividade: " + err.message);
  }
}
async function deleteTask(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await tasksRef(user.uid).doc(id).delete();
  } catch(err){
    console.error(err);
    showToast("Erro ao excluir atividade: " + err.message);
  }
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
  if (view === "kanban") renderKanban();
  if (view === "notas") renderNotes();
  if (view === "projetos") renderProjects();
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
function renderPostTextChunk(text){
  const trimmed = text.replace(/^\n+|\n+$/g, "");
  if (!trimmed) return "";
  return trimmed.split(/\n{2,}/).map(para => {
    const safe = esc(para).replace(/\n/g, "<br>");
    return `<p class="post-content">${safe}</p>`;
  }).join("");
}

function renderPostBody(content){
  const regex = /```([a-zA-Z0-9+#.\-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0, match, html = "";
  while ((match = regex.exec(content)) !== null){
    if (match.index > lastIndex) html += renderPostTextChunk(content.slice(lastIndex, match.index));
    const lang = match[1] || "código";
    const code = match[2].replace(/\n$/, "");
    html += `
      <div class="post-code-block">
        <div class="post-code-head"><span>${esc(lang)}</span></div>
        <pre class="post-code"><code>${esc(code)}</code></pre>
      </div>
    `;
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < content.length) html += renderPostTextChunk(content.slice(lastIndex));
  return html || renderPostTextChunk(content);
}

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
      <div class="post-body">${renderPostBody(p.content)}</div>
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

document.getElementById("insertCodeBlockBtn").addEventListener("click", () => {
  const textarea = document.getElementById("newPostContent");
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const before = textarea.value.slice(0, start);
  const selected = textarea.value.slice(start, end);
  const after = textarea.value.slice(end);
  const needsNewlineBefore = before.length > 0 && !before.endsWith("\n");
  const body = selected || "seu código aqui";
  const snippet = `${needsNewlineBefore ? "\n" : ""}\`\`\`linguagem\n${body}\n\`\`\`\n`;

  textarea.value = before + snippet + after;

  const langStart = before.length + (needsNewlineBefore ? 1 : 0) + 3;
  const langEnd = langStart + "linguagem".length;
  textarea.focus();
  textarea.setSelectionRange(langStart, langEnd);
});

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
  if (!pomoRunning || pomoPhaseEndAt === null) return;
  const secondsLeft = Math.max(0, Math.round((pomoPhaseEndAt - Date.now()) / 1000));
  if (pomoPhase === "focus") pomoFocusElapsedSeconds = currentPhaseTotalSeconds() - secondsLeft;
  pomoRemainingSeconds = secondsLeft;
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
  pomoPhaseEndAt = Date.now() + pomoRemainingSeconds * 1000;
  pomoInterval = setInterval(tickTimer, 1000);
  updateTimerDisplay();
}
function pauseTimer(){
  if (pomoRunning && pomoPhaseEndAt !== null){
    pomoRemainingSeconds = Math.max(0, Math.round((pomoPhaseEndAt - Date.now()) / 1000));
  }
  pomoRunning = false;
  pomoPhaseEndAt = null;
  clearInterval(pomoInterval);
  pomoInterval = null;
  updateTimerDisplay();
}
// Quando a aba volta a ficar visível, corrige o timer imediatamente em vez de
// esperar o próximo tick (o navegador reduz drasticamente a frequência de
// setInterval em abas em segundo plano, o que fazia o cronômetro "atrasar").
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pomoRunning) tickTimer();
});
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
  if (pendingDeleteId && pendingDeleteType === "project") await deleteProject(pendingDeleteId);
  if (pendingDeleteId && pendingDeleteType === "ptask") await deleteProjectTask(pendingDeleteId);
  if (pendingDeleteId && pendingDeleteType === "kboard") await deleteKbBoard(pendingDeleteId);
  if (pendingDeleteId && pendingDeleteType === "kcolumn") await deleteKbColumn(pendingDeleteId);
  if (pendingDeleteId && pendingDeleteType === "kcard") await deleteKbCard(pendingDeleteId);
  if (pendingDeleteId && pendingDeleteType === "ntrow") await deleteNtRow(pendingDeleteId);
  if (pendingDeleteId && pendingDeleteType === "ntnote") await deleteNtNote(pendingDeleteId);
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
    const pendingTasks = tasks.filter(t => t.dueDate === dateStr && !t.done);
    const pendingProjectTasks = projectTasks.filter(t => t.dueDate === dateStr && t.status !== "done" && projects.some(p => p.id === t.projectId && p.status === "active"));
    const pendingCount = pendingTasks.length + pendingProjectTasks.length;
    const taskFlag = pendingCount > 0
      ? `<span class="cal-day-task-flag" title="${pendingCount} atividade(s) pendente(s)">🚩</span>`
      : "";
    html += `
      <div class="cal-day ${dateStr === today ? "today" : ""}" data-date="${dateStr}">
        ${taskFlag}
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
  renderUpcomingTasks();
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

function renderDayModalTasks(dateStr){
  const container = document.getElementById("dayModalTasks");
  if (!container) return;
  const dayTasks = tasks.filter(t => t.dueDate === dateStr);
  const pending = dayTasks.filter(t => !t.done);
  const done = dayTasks.filter(t => t.done);
  const rows = [...pending, ...done];

  const rowsHtml = rows.length === 0
    ? `<div class="day-task-empty">Nenhuma atividade cadastrada para este dia.</div>`
    : rows.map(t => `
        <div class="day-task-row ${t.done ? "done" : ""}">
          <span class="day-task-title">${esc(t.title)}</span>
          ${t.done
            ? `<span class="day-task-done-label">✓ concluída</span>`
            : `<button class="day-task-complete-btn" data-id="${t.id}" type="button">Concluir</button>`}
          <button class="day-task-delete" data-id="${t.id}" type="button" title="Excluir atividade">&times;</button>
        </div>
      `).join("");

  container.innerHTML = `
    <div class="day-modal-tasks-head">Atividades do dia</div>
    <div class="day-task-list">${rowsHtml}</div>
    <form class="day-task-add-form" id="dayTaskAddForm" data-date="${dateStr}">
      <input type="text" id="dayTaskAddInput" placeholder="Ex.: Estudar 3 horas" required>
      <button type="submit" class="btn btn-primary btn-sm">Adicionar</button>
    </form>
  `;
}

function openDayModal(dateStr){
  const [y,m,d] = dateStr.split("-").map(Number);
  const label = `${d} de ${MONTH_NAMES[m-1]} de ${y}`;
  document.getElementById("dayModalTitle").textContent = label;
  renderDayModalStudy(dateStr);
  renderDayModalTasks(dateStr);
  renderDayModalProjectTasks(dateStr);
  const list = document.getElementById("dayModalList");

  const isFuture = dayIndex(dateStr) > dayIndex(todayStr());

  if (goals.length === 0){
    list.innerHTML = `<div class="day-goal-empty">Você ainda não tem metas cadastradas.</div>`;
  } else if (isFuture){
    list.innerHTML = `<div class="day-goal-empty">Metas só podem ser marcadas até o dia de hoje. Use "Atividades do dia" acima para agendar algo para esta data.</div>`;
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

document.getElementById("dayModalTasks").addEventListener("click", async (e) => {
  const completeBtn = e.target.closest(".day-task-complete-btn");
  const deleteBtn = e.target.closest(".day-task-delete");
  if (completeBtn){
    await completeTask(completeBtn.dataset.id);
    openDayModal(document.getElementById("dayTaskAddForm").dataset.date);
  } else if (deleteBtn){
    await deleteTask(deleteBtn.dataset.id);
    openDayModal(document.getElementById("dayTaskAddForm").dataset.date);
  }
});

document.getElementById("dayModalTasks").addEventListener("submit", async (e) => {
  const form = e.target.closest("#dayTaskAddForm");
  if (!form) return;
  e.preventDefault();
  const input = document.getElementById("dayTaskAddInput");
  const title = input.value.trim();
  if (!title) return;
  await addTask(title, form.dataset.date);
  openDayModal(form.dataset.date);
});

function renderUpcomingTasks(){
  const listEl = document.getElementById("upcomingTasksList");
  if (!listEl) return;
  const todayIdx = dayIndex(todayStr());
  const pending = tasks.filter(t => !t.done).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  if (pending.length === 0){
    listEl.innerHTML = `<div class="upcoming-tasks-empty">Nenhuma atividade pendente. Clique em um dia do calendário para adicionar uma.</div>`;
    return;
  }

  listEl.innerHTML = pending.map(t => {
    const [y, m, d] = t.dueDate.split("-").map(Number);
    const dateLabel = `${d} de ${MONTH_NAMES[m-1]}`;
    const overdue = dayIndex(t.dueDate) < todayIdx;
    return `
      <div class="upcoming-task-row ${overdue ? "overdue" : ""}">
        <div class="upcoming-task-info">
          <span class="upcoming-task-title">${esc(t.title)}</span>
          <span class="upcoming-task-date">${dateLabel}${overdue ? " · atrasada" : ""}</span>
        </div>
        <div class="upcoming-task-actions">
          <button class="btn btn-ghost btn-sm upcoming-task-complete" data-id="${t.id}" type="button">Concluir atividade</button>
          <button class="upcoming-task-delete" data-id="${t.id}" type="button" title="Excluir">&times;</button>
        </div>
      </div>
    `;
  }).join("");
}

document.getElementById("upcomingTasksList").addEventListener("click", async (e) => {
  const completeBtn = e.target.closest(".upcoming-task-complete");
  const deleteBtn = e.target.closest(".upcoming-task-delete");
  if (completeBtn) await completeTask(completeBtn.dataset.id);
  else if (deleteBtn) await deleteTask(deleteBtn.dataset.id);
});

/* ---------------------------------------------------------
   10.5 Coruja (XP)
--------------------------------------------------------- */
function miniOwlSvg(){
  return `<svg viewBox="0 0 200 220" aria-hidden="true">
    <ellipse class="owl-wing" cx="42" cy="132" rx="19" ry="44"></ellipse>
    <ellipse class="owl-wing" cx="158" cy="132" rx="19" ry="44"></ellipse>
    <circle class="owl-feather" cx="38" cy="112" r="2.2"></circle>
    <circle class="owl-feather" cx="34" cy="130" r="2.2"></circle>
    <circle class="owl-feather" cx="40" cy="148" r="2.2"></circle>
    <circle class="owl-feather" cx="162" cy="112" r="2.2"></circle>
    <circle class="owl-feather" cx="166" cy="130" r="2.2"></circle>
    <circle class="owl-feather" cx="160" cy="148" r="2.2"></circle>
    <polygon class="owl-body-part" points="58,58 70,12 83,60"></polygon>
    <polygon class="owl-body-part" points="117,60 130,12 142,58"></polygon>
    <ellipse class="owl-body-part" cx="100" cy="118" rx="60" ry="66"></ellipse>
    <circle class="owl-eye-socket" cx="78" cy="108" r="22"></circle>
    <circle class="owl-eye-socket" cx="122" cy="108" r="22"></circle>
    <circle class="owl-eye-white" cx="78" cy="108" r="16.5"></circle>
    <circle class="owl-eye-white" cx="122" cy="108" r="16.5"></circle>
    <circle class="owl-eye-pupil" cx="78" cy="108" r="7.5"></circle>
    <circle class="owl-eye-pupil" cx="122" cy="108" r="7.5"></circle>
    <circle class="owl-eye-glint" cx="74" cy="103" r="2.6"></circle>
    <circle class="owl-eye-glint" cx="118" cy="103" r="2.6"></circle>
    <polygon class="owl-beak" points="100,120 91,135 109,135"></polygon>
  </svg>`;
}

function renderOwlTierGallery(currentLevel){
  const container = document.getElementById("owlTiers");
  if (!container) return;
  const ascending = [...OWL_TIERS].reverse(); // Filhote -> Vigilante -> Estelar -> Ômega

  container.innerHTML = ascending.map(t => {
    const unlocked = currentLevel >= t.minLevel;
    const isCurrent = unlocked && (t.maxLevel === null || currentLevel <= t.maxLevel);
    const rangeLabel = t.maxLevel ? `Nível ${t.minLevel}–${t.maxLevel}` : `Nível ${t.minLevel}+`;
    const statusLabel = isCurrent ? "Atual" : unlocked ? "Conquistada" : "Bloqueada";
    const statusClass = isCurrent ? "current" : unlocked ? "achieved" : "locked";
    return `
      <div class="owl-tier-card ${unlocked ? "unlocked" : ""} ${isCurrent ? "current" : ""}" style="--tier-color:${t.color}">
        ${!unlocked ? `<span class="owl-tier-lock">🔒</span>` : ""}
        <div class="owl-tier-owl" style="--owl-color:${t.color}">${miniOwlSvg()}</div>
        <div class="owl-tier-name">${t.label}</div>
        <div class="owl-tier-range">${rangeLabel}</div>
        <div class="owl-tier-status ${statusClass}">${statusLabel}</div>
      </div>
    `;
  }).join("");
}

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

  renderOwlTierGallery(state.level);
}

/* ---------------------------------------------------------
   10.7 Projetos — grandes projetos (TCC, sites, apps...)
   Coleções no Firestore:
     users/{uid}/projects      → o projeto (nome, cor, prazo, etapas...)
     users/{uid}/projectTasks  → tarefas, ligadas ao projeto por projectId
--------------------------------------------------------- */
const PROJECT_TEMPLATES = {
  blank: { label:"Em branco", phases:[] },
  tcc: {
    label:"TCC / Monografia",
    phases:[
      { name:"Tema e orientação",   tasks:["Escolher o tema","Definir orientador e marcar a primeira reunião","Escrever o pré-projeto"] },
      { name:"Referencial teórico", tasks:["Levantar artigos, livros e dissertações","Fichar as leituras principais","Escrever a revisão da literatura"] },
      { name:"Metodologia",         tasks:["Definir objetivos e pergunta de pesquisa","Escolher método e instrumentos","Submeter ao comitê de ética (se precisar)"] },
      { name:"Desenvolvimento",     tasks:["Coletar dados ou desenvolver o sistema","Analisar os resultados","Montar tabelas e figuras"] },
      { name:"Escrita",             tasks:["Introdução","Capítulos de desenvolvimento","Conclusão","Resumo e abstract"] },
      { name:"Revisão e normas",    tasks:["Revisão ortográfica e de coesão","Formatar conforme a ABNT","Conferir as referências","Enviar versão ao orientador"] },
      { name:"Defesa",              tasks:["Montar os slides","Ensaiar a apresentação","Entregar a versão final"] },
    ],
  },
  site: {
    label:"Website",
    phases:[
      { name:"Descoberta",       tasks:["Definir objetivo e público-alvo","Pesquisar referências e concorrentes","Mapear as páginas (sitemap)"] },
      { name:"Design",           tasks:["Criar wireframes","Definir paleta, tipografia e identidade","Prototipar as telas principais"] },
      { name:"Conteúdo",         tasks:["Escrever os textos","Selecionar e otimizar as imagens"] },
      { name:"Desenvolvimento",  tasks:["Estrutura HTML e CSS","Responsividade (celular e tablet)","Interações em JavaScript","Formulário de contato"] },
      { name:"Testes",           tasks:["Testar nos principais navegadores","Testar no celular","Revisar desempenho e SEO básico"] },
      { name:"Publicação",       tasks:["Registrar domínio e contratar hospedagem","Publicar o site","Configurar analytics"] },
    ],
  },
  app: {
    label:"App / Software",
    phases:[
      { name:"Planejamento",     tasks:["Definir escopo e funcionalidades do MVP","Escrever histórias de usuário","Escolher stack e arquitetura"] },
      { name:"Design",           tasks:["Desenhar o fluxo de telas","Criar protótipo navegável"] },
      { name:"Desenvolvimento",  tasks:["Configurar repositório e ambiente","Implementar as funcionalidades do MVP","Integrar banco de dados / API","Autenticação de usuários"] },
      { name:"Testes",           tasks:["Testar as funcionalidades","Corrigir bugs encontrados","Testar com usuários reais"] },
      { name:"Lançamento",       tasks:["Preparar a publicação","Publicar a primeira versão","Coletar feedback"] },
    ],
  },
};
const PRIORITY_META = {
  high:   { label:"Alta",  weight:0, color:"var(--danger)" },
  medium: { label:"Média", weight:1, color:"var(--rank-estrela)" },
  low:    { label:"Baixa", weight:2, color:"var(--ink-700)" },
};
const TASK_STATUS = [
  { key:"todo",  label:"A fazer" },
  { key:"doing", label:"Em andamento" },
  { key:"done",  label:"Concluído" },
];
const PROJECT_STATUS_LABEL = { active:"Ativo", paused:"Pausado", done:"Concluído" };

/* ---- helpers ---- */
function byId(id){ return document.getElementById(id); }
function uid8(){ return Math.random().toString(36).slice(2, 9); }
function tsMillis(ts){ return ts && typeof ts.toMillis === "function" ? ts.toMillis() : Number.MAX_SAFE_INTEGER; }
function plural(n, one, many){ return n === 1 ? one : many; }
function kindLabel(kind){ return (PROJECT_TEMPLATES[kind] || PROJECT_TEMPLATES.blank).label; }
function shortDate(dateStr){
  const [y, m, d] = dateStr.split("-").map(Number);
  const mon = MONTH_NAMES[m - 1].slice(0, 3);
  return y === new Date().getFullYear() ? `${d} ${mon}` : `${d} ${mon} ${y}`;
}
function dueInfo(dateStr, done){
  if (!dateStr) return null;
  if (done) return { label: shortDate(dateStr), cls: "" };
  const diff = dayIndex(dateStr) - dayIndex(todayStr());
  if (diff < 0)  return { label: `${shortDate(dateStr)} · atrasada`, cls: "overdue" };
  if (diff === 0) return { label: "hoje", cls: "soon" };
  if (diff === 1) return { label: "amanhã", cls: "soon" };
  return { label: shortDate(dateStr), cls: diff <= 7 ? "soon" : "" };
}
function deadlineText(daysLeft){
  if (daysLeft === null) return "sem prazo definido";
  if (daysLeft < 0) return `atrasado ${-daysLeft} ${plural(-daysLeft, "dia", "dias")}`;
  if (daysLeft === 0) return "vence hoje";
  if (daysLeft > 60) return `faltam ~${Math.round(daysLeft / 30)} meses`;
  return `faltam ${daysLeft} ${plural(daysLeft, "dia", "dias")}`;
}
function compareTasks(a, b){   // prioridade → prazo → criação (quadro e lista)
  const pa = (PRIORITY_META[a.priority] || PRIORITY_META.medium).weight;
  const pb = (PRIORITY_META[b.priority] || PRIORITY_META.medium).weight;
  if (pa !== pb) return pa - pb;
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;
  return tsMillis(a.createdAt) - tsMillis(b.createdAt);
}
function compareByDue(a, b){   // prazo → prioridade (agenda entre projetos)
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;
  return compareTasks(a, b);
}
function phaseOf(project, task){
  return task.phaseId ? (project.phases.find(ph => ph.id === task.phaseId) || null) : null;
}

/* ---- Firestore ---- */
function projectsRef(uid){ return db.collection("users").doc(uid).collection("projects"); }
function projectTasksRef(uid){ return db.collection("users").doc(uid).collection("projectTasks"); }

function refreshCalendarIfOpen(){
  if (byId("view-calendario").classList.contains("active")) renderCalendar();
}
function subscribeProjects(uid){
  if (projectsUnsub) projectsUnsub();
  projectsUnsub = projectsRef(uid).orderBy("createdAt", "asc").onSnapshot((snap) => {
    projects = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.name || "Projeto",
        description: d.description || "",
        color: d.color || "#4FA3E3",
        kind: d.kind || "blank",
        deadline: d.deadline || null,
        status: d.status || "active",
        phases: Array.isArray(d.phases) ? d.phases : [],
        subjectId: d.subjectId || null,
        createdAt: d.createdAt || null,
      };
    });
    renderProjects();
    refreshCalendarIfOpen();
  }, (err) => {
    console.error(err);
    showToast("Erro ao carregar projetos: " + err.message);
  });
}
function subscribeProjectTasks(uid){
  if (projectTasksUnsub) projectTasksUnsub();
  projectTasksUnsub = projectTasksRef(uid).orderBy("createdAt", "asc").onSnapshot((snap) => {
    projectTasks = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        projectId: d.projectId,
        title: d.title || "",
        notes: d.notes || "",
        status: ["todo","doing","done"].includes(d.status) ? d.status : "todo",
        priority: PRIORITY_META[d.priority] ? d.priority : "medium",
        dueDate: d.dueDate || null,
        phaseId: d.phaseId || null,
        subtasks: Array.isArray(d.subtasks) ? d.subtasks : [],
        completedDate: d.completedDate || null,
        createdAt: d.createdAt || null,
      };
    });
    renderProjects();
    refreshCalendarIfOpen();
  }, (err) => {
    console.error(err);
    showToast("Erro ao carregar tarefas de projetos: " + err.message);
  });
}

async function commitBatches(ops){   // ops: [(batch) => void]; divide em lotes de 400
  for (let i = 0; i < ops.length; i += 400){
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(fn => fn(batch));
    await batch.commit();
  }
}

async function createProject(form, includeSamples, createSubject){
  const user = auth.currentUser;
  if (!user) return;
  try{
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    const projRef = projectsRef(user.uid).doc();
    const phases = form.phases.map(ph => ({ id: ph.id, name: ph.name }));
    const ops = [];

    let subjectId = null;
    if (createSubject){
      const subjRef = subjectsRef(user.uid).doc();
      subjectId = subjRef.id;
      ops.push(b => b.set(subjRef, { name: form.name, color: form.color, createdAt: ts }));
    }
    ops.push(b => b.set(projRef, {
      name: form.name, description: form.description, color: form.color, kind: form.kind,
      deadline: form.deadline || null, status: "active", phases, subjectId, createdAt: ts,
    }));

    if (includeSamples && PROJECT_TEMPLATES[form.kind]){
      const tpl = PROJECT_TEMPLATES[form.kind];
      form.phases.forEach(ph => {
        if (ph.tpl === undefined || !tpl.phases[ph.tpl]) return;
        tpl.phases[ph.tpl].tasks.forEach(title => {
          const tRef = projectTasksRef(user.uid).doc();
          ops.push(b => b.set(tRef, {
            projectId: projRef.id, title, notes: "", status: "todo", priority: "medium",
            dueDate: null, phaseId: ph.id, subtasks: [], completedDate: null, createdAt: ts,
          }));
        });
      });
    }
    await commitBatches(ops);
    showToast("Projeto criado.");
    activeProjectId = projRef.id;
    projPhaseFilter = "all";
    renderProjects();
  } catch(err){
    console.error(err);
    showToast("Erro ao criar projeto: " + err.message);
  }
}

async function updateProject(id, form){
  const user = auth.currentUser;
  if (!user) return;
  const old = projects.find(p => p.id === id);
  if (!old) return;
  try{
    const phases = form.phases.map(ph => ({ id: ph.id, name: ph.name }));
    const keep = new Set(phases.map(ph => ph.id));
    const ops = [];
    ops.push(b => b.update(projectsRef(user.uid).doc(id), {
      name: form.name, description: form.description, color: form.color,
      deadline: form.deadline || null, status: form.status, phases,
    }));
    // tarefas de etapas removidas ficam "sem etapa"
    projectTasks.filter(t => t.projectId === id && t.phaseId && !keep.has(t.phaseId)).forEach(t => {
      ops.push(b => b.update(projectTasksRef(user.uid).doc(t.id), { phaseId: null }));
    });
    // mantém a matéria do Pomodoro com o mesmo nome/cor do projeto
    if (old.subjectId && subjects.some(s => s.id === old.subjectId)){
      ops.push(b => b.update(subjectsRef(user.uid).doc(old.subjectId), { name: form.name, color: form.color }));
    }
    await commitBatches(ops);
    showToast("Projeto atualizado.");
  } catch(err){
    console.error(err);
    showToast("Erro ao atualizar projeto: " + err.message);
  }
}

async function setProjectStatus(id, status){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await projectsRef(user.uid).doc(id).update({ status });
    showToast(status === "done" ? "Projeto concluído! 🎉" : "Status atualizado.");
  } catch(err){
    console.error(err);
    showToast("Erro ao atualizar projeto: " + err.message);
  }
}

async function deleteProject(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    const ops = projectTasks.filter(t => t.projectId === id)
      .map(t => (b => b.delete(projectTasksRef(user.uid).doc(t.id))));
    ops.push(b => b.delete(projectsRef(user.uid).doc(id)));
    await commitBatches(ops);
    if (activeProjectId === id) activeProjectId = null;
    renderProjects();
    showToast("Projeto excluído.");
  } catch(err){
    console.error(err);
    showToast("Erro ao excluir projeto: " + err.message);
  }
}

async function saveProjectTask(projectId, data, taskId){
  const user = auth.currentUser;
  if (!user) return;
  const payload = {
    title: data.title, notes: data.notes || "", status: data.status || "todo",
    priority: data.priority || "medium", dueDate: data.dueDate || null,
    phaseId: data.phaseId || null, subtasks: data.subtasks || [],
    completedDate: data.status === "done" ? (data.completedDate || todayStr()) : null,
  };
  try{
    if (taskId){
      await projectTasksRef(user.uid).doc(taskId).update(payload);
    } else {
      await projectTasksRef(user.uid).add({
        ...payload, projectId,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch(err){
    console.error(err);
    showToast("Erro ao salvar tarefa: " + err.message);
  }
}
async function addProjectTasksBulk(projectId, titles, phaseId){
  const user = auth.currentUser;
  if (!user || titles.length === 0) return;
  try{
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    const ops = titles.map(title => (b => b.set(projectTasksRef(user.uid).doc(), {
      projectId, title, notes: "", status: "todo", priority: "medium",
      dueDate: null, phaseId: phaseId || null, subtasks: [], completedDate: null, createdAt: ts,
    })));
    await commitBatches(ops);
    showToast(`${titles.length} ${plural(titles.length, "tarefa adicionada", "tarefas adicionadas")}.`);
  } catch(err){
    console.error(err);
    showToast("Erro ao adicionar tarefas: " + err.message);
  }
}
async function setProjectTaskStatus(id, status){
  const user = auth.currentUser;
  if (!user) return;
  const t = projectTasks.find(x => x.id === id);
  if (!t || t.status === status) return;
  try{
    await projectTasksRef(user.uid).doc(id).update({
      status, completedDate: status === "done" ? todayStr() : null,
    });
  } catch(err){
    console.error(err);
    showToast("Erro ao atualizar tarefa: " + err.message);
  }
}
async function deleteProjectTask(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await projectTasksRef(user.uid).doc(id).delete();
    showToast("Tarefa excluída.");
  } catch(err){
    console.error(err);
    showToast("Erro ao excluir tarefa: " + err.message);
  }
}

/* ---- ligação com o Pomodoro ---- */
async function focusOnProject(id){
  const user = auth.currentUser;
  const p = projects.find(x => x.id === id);
  if (!user || !p) return;
  try{
    let subjectId = p.subjectId;
    if (!subjectId || !subjects.some(s => s.id === subjectId)){
      const ref = subjectsRef(user.uid).doc();
      await ref.set({ name: p.name, color: p.color, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      await projectsRef(user.uid).doc(id).update({ subjectId: ref.id });
      subjectId = ref.id;
    }
    selectedSubjectId = subjectId;
    document.querySelector('.tab-btn[data-view="pomodoro"]').click();
    showToast(`Foco em "${p.name}" — escolha o tempo e inicie.`);
  } catch(err){
    console.error(err);
    showToast("Erro ao abrir o Pomodoro: " + err.message);
  }
}

/* ---- estatísticas ---- */
function projectStats(p){
  const ts = projectTasks.filter(t => t.projectId === p.id);
  const total = ts.length;
  const done = ts.filter(t => t.status === "done").length;
  const doing = ts.filter(t => t.status === "doing").length;
  const open = total - done;
  const today = todayStr();
  const overdue = ts.filter(t => t.status !== "done" && t.dueDate && t.dueDate < today).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const focusMin = p.subjectId
    ? pomoSessions.filter(s => s.subjectId === p.subjectId).reduce((sum, s) => sum + s.minutes, 0)
    : 0;
  const daysLeft = p.deadline ? dayIndex(p.deadline) - dayIndex(today) : null;
  return { ts, total, done, doing, open, overdue, pct, focusMin, daysLeft };
}

/* ---- render: visão geral ---- */
function renderProjects(){
  const overview = byId("projOverview");
  const detail = byId("projDetail");
  if (!overview || !detail) return;
  const p = activeProjectId ? projects.find(x => x.id === activeProjectId) : null;
  if (activeProjectId && !p) activeProjectId = null;
  overview.hidden = !!p;
  detail.hidden = !p;
  if (p) renderProjectDetail(p); else renderProjectOverview();
}

function projectCardHtml(p){
  const s = projectStats(p);
  const next = s.ts.filter(t => t.status !== "done").sort(compareByDue)[0];
  const dlCls = p.status === "active" && s.daysLeft !== null
    ? (s.daysLeft < 0 ? "overdue" : s.daysLeft <= 7 ? "soon" : "") : "";
  return `
    <article class="proj-card ${p.status !== "active" ? "is-" + p.status : ""}" data-id="${p.id}" style="--proj-color:${p.color}" tabindex="0">
      <div class="proj-card-top">
        <h3 class="proj-card-name">${esc(p.name)}</h3>
        <span class="proj-kind-badge">${esc(kindLabel(p.kind))}</span>
      </div>
      ${p.status !== "active" ? `<span class="proj-status-badge ${p.status}">${PROJECT_STATUS_LABEL[p.status]}</span>` : ""}
      ${p.description ? `<p class="proj-card-desc">${esc(p.description)}</p>` : ""}
      <div class="proj-progress"><div class="proj-progress-fill" style="width:${s.pct}%"></div></div>
      <div class="proj-card-progress-label">
        <span><b>${s.pct}%</b> · ${s.done}/${s.total} ${plural(s.total, "tarefa", "tarefas")}</span>
        ${p.deadline ? `<span class="proj-chip ${dlCls}">⏳ ${deadlineText(s.daysLeft)}</span>` : ""}
      </div>
      <div class="proj-card-chips">
        ${s.overdue ? `<span class="proj-chip overdue">${s.overdue} ${plural(s.overdue, "atrasada", "atrasadas")}</span>` : ""}
        ${s.doing ? `<span class="proj-chip">${s.doing} em andamento</span>` : ""}
        ${s.focusMin ? `<span class="proj-chip">⏱ ${formatMinutes(s.focusMin)}</span>` : ""}
      </div>
      ${next ? `<div class="proj-card-next"><span>Próxima</span>${esc(next.title)}</div>` : ""}
    </article>`;
}

function renderProjectOverview(){
  const today = todayStr();
  const active = projects.filter(p => p.status === "active");
  const activeIds = new Set(active.map(p => p.id));
  const openTasks = projectTasks.filter(t => activeIds.has(t.projectId) && t.status !== "done");
  const overdue = openTasks.filter(t => t.dueDate && t.dueDate < today).length;
  const subjIds = new Set(projects.map(p => p.subjectId).filter(Boolean));
  const focusTotal = pomoSessions.filter(s => subjIds.has(s.subjectId)).reduce((sum, s) => sum + s.minutes, 0);

  byId("projDashboard").innerHTML = projects.length === 0 ? "" : `
    <div class="dash-card">
      <div class="dash-label">Projetos ativos</div>
      <div class="dash-value">${active.length}</div>
      <div class="dash-sub">${projects.length} no total</div>
    </div>
    <div class="dash-card">
      <div class="dash-label">Tarefas em aberto</div>
      <div class="dash-value">${openTasks.length}</div>
      <div class="dash-sub">somando os projetos ativos</div>
    </div>
    <div class="dash-card">
      <div class="dash-label">Atrasadas</div>
      <div class="dash-value" style="color:${overdue ? "var(--danger)" : "var(--success)"}">${overdue}</div>
      <div class="dash-sub">${overdue ? "precisam de atenção" : "tudo em dia"}</div>
    </div>
    <div class="dash-card">
      <div class="dash-label">Foco em projetos</div>
      <div class="dash-value">${formatMinutes(focusTotal)}</div>
      <div class="dash-sub">registrado no Pomodoro</div>
    </div>`;

  const filters = [
    { key:"active", label:"Ativos",     n: projects.filter(p => p.status === "active").length },
    { key:"paused", label:"Pausados",   n: projects.filter(p => p.status === "paused").length },
    { key:"done",   label:"Concluídos", n: projects.filter(p => p.status === "done").length },
    { key:"all",    label:"Todos",      n: projects.length },
  ];
  byId("projFilter").innerHTML = projects.length === 0 ? "" : filters.map(f => `
    <button type="button" class="tag-filter-btn ${projStatusFilter === f.key ? "active" : ""}" data-filter="${f.key}">
      ${f.label}<span class="count">${f.n}</span>
    </button>`).join("");

  const grid = byId("projGrid");
  if (projects.length === 0){
    grid.innerHTML = `
      <div class="proj-empty">
        <div class="proj-empty-title">Nenhum projeto ainda</div>
        <p>Projetos grandes ficam mais leves quando divididos em etapas e tarefas. Crie o primeiro — há modelos prontos para TCC, website e app.</p>
        <button type="button" class="btn btn-primary" data-act="new">+ Criar primeiro projeto</button>
      </div>`;
  } else {
    const visible = projStatusFilter === "all" ? projects : projects.filter(p => p.status === projStatusFilter);
    grid.innerHTML = visible.length === 0
      ? `<div class="proj-empty"><p>Nenhum projeto nesta categoria.</p></div>`
      : visible.map(projectCardHtml).join("");
  }

  // agenda entre projetos: o que vence primeiro, de qualquer projeto
  const agendaWrap = byId("projAgendaWrap");
  const agenda = openTasks.filter(t => t.dueDate).sort(compareByDue).slice(0, 8);
  agendaWrap.hidden = active.length === 0;
  byId("projAgenda").innerHTML = agenda.length === 0
    ? `<div class="upcoming-tasks-empty">Nenhuma tarefa com prazo nos projetos ativos. Defina datas nas tarefas para ver a agenda aqui.</div>`
    : agenda.map(t => {
        const proj = projects.find(p => p.id === t.projectId);
        const due = dueInfo(t.dueDate, false);
        return `
          <div class="proj-agenda-row ${due.cls}" data-id="${t.id}" style="--proj-color:${proj ? proj.color : "var(--ink-500)"}">
            <button type="button" class="proj-check" data-act="toggle" title="Concluir tarefa">✓</button>
            <div class="proj-agenda-info">
              <span class="proj-agenda-title">${esc(t.title)}</span>
              <span class="proj-agenda-project"><span class="dot" style="background:${proj ? proj.color : "var(--ink-500)"}"></span>${proj ? esc(proj.name) : "—"}</span>
            </div>
            <span class="proj-chip ${due.cls}">${due.label}</span>
          </div>`;
      }).join("");
}

/* ---- render: detalhe do projeto ---- */
function renderProjectDetail(p){
  const s = projectStats(p);
  const detail = byId("projDetail");
  detail.style.setProperty("--proj-color", p.color);
  if (projPhaseFilter !== "all" && projPhaseFilter !== "none" && !p.phases.some(ph => ph.id === projPhaseFilter)){
    projPhaseFilter = "all";
  }

  byId("projDetailHead").innerHTML = `
    <div class="proj-head-main">
      <div class="proj-head-title">
        <span class="proj-color-bar"></span>
        <h2>${esc(p.name)}</h2>
        <span class="proj-kind-badge">${esc(kindLabel(p.kind))}</span>
        <span class="proj-status-badge ${p.status}">${PROJECT_STATUS_LABEL[p.status]}</span>
      </div>
      ${p.description ? `<p class="proj-desc">${esc(p.description)}</p>` : ""}
    </div>
    <div class="proj-head-actions">
      <button type="button" class="btn btn-primary btn-sm" data-act="focus">⏱ Focar neste projeto</button>
      ${s.total > 0 && s.open === 0 && p.status === "active"
        ? `<button type="button" class="btn btn-ghost btn-sm" data-act="finish">✓ Marcar projeto como concluído</button>` : ""}
      ${p.status === "paused" ? `<button type="button" class="btn btn-ghost btn-sm" data-act="resume">Retomar</button>` : ""}
      ${p.status === "active" ? `<button type="button" class="btn btn-ghost btn-sm" data-act="pause">Pausar</button>` : ""}
      <button type="button" class="btn btn-ghost btn-sm" data-act="edit">Editar</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="delete">Excluir</button>
    </div>`;

  // ritmo necessário até o prazo
  let paceLine = "";
  if (p.status === "active" && s.daysLeft !== null && s.daysLeft > 0 && s.open > 0){
    const weeks = Math.max(1, s.daysLeft / 7);
    const perWeek = Math.ceil(s.open / weeks);
    paceLine = `ritmo: ~${perWeek} ${plural(perWeek, "tarefa", "tarefas")}/semana`;
  } else if (p.deadline){
    paceLine = shortDate(p.deadline);
  }
  const dlColor = s.daysLeft !== null && s.daysLeft < 0 && p.status === "active" ? "var(--danger)" : "var(--ink-100)";

  byId("projDetailStats").innerHTML = `
    <div class="dash-card">
      <div class="dash-label">Progresso</div>
      <div class="dash-value">${s.pct}%</div>
      <div class="proj-progress slim"><div class="proj-progress-fill" style="width:${s.pct}%"></div></div>
    </div>
    <div class="dash-card">
      <div class="dash-label">Tarefas</div>
      <div class="dash-value">${s.done}<span class="proj-of">/${s.total}</span></div>
      <div class="dash-sub">${s.doing} em andamento · ${s.open - s.doing} a fazer</div>
    </div>
    <div class="dash-card">
      <div class="dash-label">Atrasadas</div>
      <div class="dash-value" style="color:${s.overdue ? "var(--danger)" : "var(--success)"}">${s.overdue}</div>
      <div class="dash-sub">${s.overdue ? "revise os prazos" : "tudo em dia"}</div>
    </div>
    <div class="dash-card">
      <div class="dash-label">Prazo</div>
      <div class="dash-value proj-deadline-value" style="color:${dlColor}">${p.deadline ? deadlineText(s.daysLeft) : "—"}</div>
      <div class="dash-sub">${paceLine || "defina um prazo ao editar"}</div>
    </div>
    <div class="dash-card">
      <div class="dash-label">Tempo focado</div>
      <div class="dash-value">${formatMinutes(s.focusMin)}</div>
      <div class="dash-sub">via Pomodoro</div>
    </div>`;

  // barra de etapas (filtro)
  const noneCount = s.ts.filter(t => !phaseOf(p, t)).length;
  const phaseChips = [`
    <button type="button" class="tag-filter-btn ${projPhaseFilter === "all" ? "active" : ""}" data-phase="all">
      Todas<span class="count">${s.total}</span>
    </button>`];
  p.phases.forEach(ph => {
    const inPhase = s.ts.filter(t => t.phaseId === ph.id);
    const d = inPhase.filter(t => t.status === "done").length;
    phaseChips.push(`
      <button type="button" class="tag-filter-btn ${projPhaseFilter === ph.id ? "active" : ""} ${inPhase.length > 0 && d === inPhase.length ? "complete" : ""}" data-phase="${ph.id}">
        ${esc(ph.name)}<span class="count">${d}/${inPhase.length}</span>
      </button>`);
  });
  if (p.phases.length > 0 && noneCount > 0){
    phaseChips.push(`
      <button type="button" class="tag-filter-btn ${projPhaseFilter === "none" ? "active" : ""}" data-phase="none">
        Sem etapa<span class="count">${noneCount}</span>
      </button>`);
  }
  byId("projPhaseBar").innerHTML = phaseChips.join("");

  document.querySelectorAll("#projViewToggle button").forEach(b => b.classList.toggle("active", b.dataset.v === projView));
  byId("projHideDone").checked = projHideDone;
  renderProjectContent(p);
}

function taskChipsHtml(p, t, withPhase){
  const ph = phaseOf(p, t);
  const due = dueInfo(t.dueDate, t.status === "done");
  const subDone = t.subtasks.filter(s => s.done).length;
  return `
    ${withPhase && ph ? `<span class="proj-chip">${esc(ph.name)}</span>` : ""}
    ${due ? `<span class="proj-chip ${due.cls}">📅 ${due.label}</span>` : ""}
    ${t.subtasks.length ? `<span class="proj-chip">☑ ${subDone}/${t.subtasks.length}</span>` : ""}
    ${t.notes ? `<span class="proj-chip" title="Tem anotações">✎</span>` : ""}`;
}

function taskCardHtml(p, t){
  const prio = PRIORITY_META[t.priority] || PRIORITY_META.medium;
  const idx = TASK_STATUS.findIndex(x => x.key === t.status);
  const done = t.status === "done";
  return `
    <div class="proj-task ${done ? "done" : ""}" data-id="${t.id}" draggable="true" style="--prio-color:${prio.color}" title="Prioridade ${prio.label}">
      <div class="proj-task-top">
        <button type="button" class="proj-check ${done ? "on" : ""}" data-act="toggle" title="${done ? "Reabrir" : "Concluir"}">✓</button>
        <span class="proj-task-title">${esc(t.title)}</span>
      </div>
      <div class="proj-task-meta">
        ${taskChipsHtml(p, t, true)}
        <span class="proj-task-move">
          ${idx > 0 ? `<button type="button" data-act="move" data-dir="-1" title="Mover para ${TASK_STATUS[idx - 1].label}">‹</button>` : ""}
          ${idx < 2 ? `<button type="button" data-act="move" data-dir="1" title="Mover para ${TASK_STATUS[idx + 1].label}">›</button>` : ""}
        </span>
      </div>
    </div>`;
}

function taskRowHtml(p, t){
  const prio = PRIORITY_META[t.priority] || PRIORITY_META.medium;
  const done = t.status === "done";
  return `
    <div class="proj-row ${done ? "done" : ""}" data-id="${t.id}" style="--prio-color:${prio.color}">
      <button type="button" class="proj-check ${done ? "on" : ""}" data-act="toggle" title="${done ? "Reabrir" : "Concluir"}">✓</button>
      <span class="proj-prio" title="Prioridade ${prio.label}"></span>
      <span class="proj-row-title">${esc(t.title)}</span>
      ${t.status === "doing" ? `<span class="proj-chip doing">em andamento</span>` : ""}
      ${taskChipsHtml(p, t, false)}
    </div>`;
}

function renderProjectContent(p){
  const container = byId("projContent");
  let ts = projectTasks.filter(t => t.projectId === p.id);

  if (ts.length === 0){
    container.innerHTML = `
      <div class="proj-empty">
        <div class="proj-empty-title">Projeto sem tarefas</div>
        <p>Digite uma tarefa acima e aperte Enter, ou use "+ Várias de uma vez" para colar uma lista inteira.</p>
      </div>`;
    return;
  }
  if (projPhaseFilter === "none") ts = ts.filter(t => !phaseOf(p, t));
  else if (projPhaseFilter !== "all") ts = ts.filter(t => t.phaseId === projPhaseFilter);
  const hiddenDone = projHideDone ? ts.filter(t => t.status === "done").length : 0;
  if (projHideDone) ts = ts.filter(t => t.status !== "done");

  if (projView === "board"){
    container.innerHTML = `<div class="proj-board">${TASK_STATUS.map(col => {
      const items = ts.filter(t => t.status === col.key).sort(compareTasks);
      const hiddenNote = col.key === "done" && hiddenDone ? `<div class="proj-col-empty">${hiddenDone} ${plural(hiddenDone, "oculta", "ocultas")}</div>` : "";
      return `
        <div class="proj-col" data-status="${col.key}">
          <div class="proj-col-head"><h3>${col.label}</h3><span class="goal-count">${items.length}</span></div>
          <div class="proj-col-body">
            ${items.map(t => taskCardHtml(p, t)).join("") || (hiddenNote ? "" : `<div class="proj-col-empty">Arraste tarefas para cá</div>`)}
            ${hiddenNote}
          </div>
        </div>`;
    }).join("")}</div>`;
    return;
  }

  // visão em lista, agrupada por etapa
  const groups = [];
  if (projPhaseFilter === "all"){
    p.phases.forEach(ph => groups.push({ id: ph.id, name: ph.name, items: ts.filter(t => t.phaseId === ph.id) }));
    const rest = ts.filter(t => !phaseOf(p, t));
    if (rest.length || p.phases.length === 0) groups.push({ id: "", name: p.phases.length ? "Sem etapa" : "Tarefas", items: rest });
  } else if (projPhaseFilter === "none"){
    groups.push({ id: "", name: "Sem etapa", items: ts });
  } else {
    const ph = p.phases.find(x => x.id === projPhaseFilter);
    groups.push({ id: ph.id, name: ph.name, items: ts });
  }
  container.innerHTML = groups.map(g => {
    const all = projectTasks.filter(t => t.projectId === p.id && (g.id ? t.phaseId === g.id : !phaseOf(p, t)));
    const d = all.filter(t => t.status === "done").length;
    const pct = all.length ? Math.round((d / all.length) * 100) : 0;
    return `
      <div class="proj-group">
        <div class="proj-group-head">
          <h3>${esc(g.name)}</h3>
          <span class="goal-count">${d}/${all.length}</span>
          <div class="proj-progress slim proj-group-bar"><div class="proj-progress-fill" style="width:${pct}%"></div></div>
          <button type="button" class="link-btn" data-act="add-in-phase" data-phase="${g.id}">+ tarefa</button>
        </div>
        ${g.items.length
          ? g.items.slice().sort(compareTasks).map(t => taskRowHtml(p, t)).join("")
          : `<div class="proj-col-empty">Sem tarefas aqui.</div>`}
      </div>`;
  }).join("");
}

/* ---- eventos: visão geral ---- */
function openProject(id){
  activeProjectId = id;
  projPhaseFilter = "all";
  renderProjects();
  window.scrollTo({ top: 0 });
}
byId("openNewProjectBtn").addEventListener("click", () => openProjectModal(null));
byId("projFilter").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-filter]");
  if (!btn) return;
  projStatusFilter = btn.dataset.filter;
  renderProjects();
});
byId("projGrid").addEventListener("click", (e) => {
  if (e.target.closest('[data-act="new"]')) return openProjectModal(null);
  const card = e.target.closest(".proj-card");
  if (card) openProject(card.dataset.id);
});
byId("projGrid").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const card = e.target.closest(".proj-card");
  if (card) openProject(card.dataset.id);
});
byId("projAgenda").addEventListener("click", (e) => {
  const row = e.target.closest(".proj-agenda-row");
  if (!row) return;
  if (e.target.closest('[data-act="toggle"]')) setProjectTaskStatus(row.dataset.id, "done");
  else openTaskModal(row.dataset.id);
});

/* ---- eventos: detalhe ---- */
byId("projBackBtn").addEventListener("click", () => { activeProjectId = null; renderProjects(); });
byId("projDetailHead").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || !activeProjectId) return;
  const id = activeProjectId;
  switch (btn.dataset.act){
    case "focus":  return focusOnProject(id);
    case "edit":   return openProjectModal(id);
    case "finish": return setProjectStatus(id, "done");
    case "pause":  return setProjectStatus(id, "paused");
    case "resume": return setProjectStatus(id, "active");
    case "delete":
      pendingDeleteId = id; pendingDeleteType = "project";
      byId("confirmModalTitle").textContent = "Excluir projeto?";
      byId("confirmModalText").textContent = "Apaga o projeto e todas as tarefas dele. O tempo já registrado no Pomodoro continua no histórico. Não pode ser desfeito.";
      openModal("confirmModal");
  }
});
byId("projPhaseBar").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-phase]");
  if (!btn) return;
  projPhaseFilter = btn.dataset.phase;
  renderProjects();
});
byId("projViewToggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-v]");
  if (!btn) return;
  projView = btn.dataset.v;
  renderProjects();
});
byId("projHideDone").addEventListener("change", (e) => { projHideDone = e.target.checked; renderProjects(); });

byId("projQuickAddForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = byId("projQuickAddInput");
  const title = input.value.trim();
  if (!title || !activeProjectId) return;
  input.value = "";
  const phaseId = projPhaseFilter !== "all" && projPhaseFilter !== "none" ? projPhaseFilter : null;
  await saveProjectTask(activeProjectId, { title, phaseId });
});
byId("projDetailTaskBtn").addEventListener("click", () => openTaskModal(null));
byId("projBulkBtn").addEventListener("click", () => openBulkModal());

// cliques nas tarefas (quadro, lista)
byId("projContent").addEventListener("click", (e) => {
  const addBtn = e.target.closest('[data-act="add-in-phase"]');
  if (addBtn) return openTaskModal(null, { phaseId: addBtn.dataset.phase || null });
  const item = e.target.closest(".proj-task, .proj-row");
  if (!item) return;
  const id = item.dataset.id;
  const act = e.target.closest("[data-act]");
  if (act && act.dataset.act === "toggle"){
    const t = projectTasks.find(x => x.id === id);
    return setProjectTaskStatus(id, t && t.status === "done" ? "todo" : "done");
  }
  if (act && act.dataset.act === "move"){
    const t = projectTasks.find(x => x.id === id);
    if (!t) return;
    const idx = TASK_STATUS.findIndex(x => x.key === t.status) + Number(act.dataset.dir);
    if (idx >= 0 && idx < TASK_STATUS.length) setProjectTaskStatus(id, TASK_STATUS[idx].key);
    return;
  }
  openTaskModal(id);
});
// arrastar e soltar entre colunas
let draggedTaskId = null;
byId("projContent").addEventListener("dragstart", (e) => {
  const card = e.target.closest(".proj-task");
  if (!card) return;
  draggedTaskId = card.dataset.id;
  card.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedTaskId);
});
byId("projContent").addEventListener("dragend", () => {
  draggedTaskId = null;
  document.querySelectorAll(".proj-task.dragging, .proj-col.drag-over").forEach(el => el.classList.remove("dragging", "drag-over"));
});
byId("projContent").addEventListener("dragover", (e) => {
  const col = e.target.closest(".proj-col");
  if (!col || !draggedTaskId) return;
  e.preventDefault();
  document.querySelectorAll(".proj-col.drag-over").forEach(el => { if (el !== col) el.classList.remove("drag-over"); });
  col.classList.add("drag-over");
});
byId("projContent").addEventListener("drop", (e) => {
  const col = e.target.closest(".proj-col");
  if (!col || !draggedTaskId) return;
  e.preventDefault();
  const id = draggedTaskId;
  col.classList.remove("drag-over");
  setProjectTaskStatus(id, col.dataset.status);
});

/* ---- modal: projeto (criar/editar) ---- */
function renderPhaseEditor(){
  const box = byId("phaseEditor");
  if (draftPhases.length === 0){
    box.innerHTML = `<div class="phase-empty">Sem etapas. Adicione se quiser agrupar as tarefas (ex.: Pesquisa, Escrita, Revisão).</div>`;
    return;
  }
  box.innerHTML = draftPhases.map((ph, i) => `
    <div class="phase-row" data-i="${i}">
      <span class="phase-num">${i + 1}</span>
      <input type="text" class="phase-input" value="${esc(ph.name).replace(/"/g, "&quot;")}" placeholder="Nome da etapa" maxlength="60">
      <button type="button" class="phase-btn" data-act="up" title="Subir" ${i === 0 ? "disabled" : ""}>↑</button>
      <button type="button" class="phase-btn" data-act="down" title="Descer" ${i === draftPhases.length - 1 ? "disabled" : ""}>↓</button>
      <button type="button" class="phase-btn danger" data-act="del" title="Remover etapa">&times;</button>
    </div>`).join("");
}
function loadTemplateIntoEditor(kind){
  const tpl = PROJECT_TEMPLATES[kind] || PROJECT_TEMPLATES.blank;
  draftPhases = tpl.phases.map((ph, i) => ({ id: "ph_" + uid8(), name: ph.name, tpl: i }));
  renderPhaseEditor();
  const hasTasks = tpl.phases.some(ph => ph.tasks && ph.tasks.length);
  byId("projSampleTasksRow").hidden = !hasTasks || editingProjectId !== null;
}
function openProjectModal(projectId){
  editingProjectId = projectId;
  const p = projectId ? projects.find(x => x.id === projectId) : null;
  byId("projectForm").reset();
  byId("projectModalTitle").textContent = p ? "Editar projeto" : "Novo projeto";
  byId("projectSubmitBtn").textContent = p ? "Salvar alterações" : "Criar projeto";
  byId("projTemplateRow").hidden = !!p;
  byId("projStatusRow").hidden = !p;
  byId("projSubjectRow").hidden = !!p;
  if (p){
    byId("projName").value = p.name;
    byId("projDesc").value = p.description;
    byId("projDeadline").value = p.deadline || "";
    byId("projStatusSel").value = p.status;
    selectedProjectColor = p.color;
    draftPhases = p.phases.map(ph => ({ id: ph.id, name: ph.name }));
    renderPhaseEditor();
    byId("projSampleTasksRow").hidden = true;
  } else {
    selectedProjectColor = "#4FA3E3";
    byId("projTemplate").value = "tcc";
    loadTemplateIntoEditor("tcc");
  }
  document.querySelectorAll("#projectColorPicker .color-swatch").forEach(sw =>
    sw.classList.toggle("selected", sw.dataset.color.toLowerCase() === selectedProjectColor.toLowerCase()));
  openModal("projectModal");
  byId("projName").focus();
}
byId("closeProjectModal").addEventListener("click", () => closeModal("projectModal"));
byId("projTemplate").addEventListener("change", (e) => loadTemplateIntoEditor(e.target.value));
byId("projectColorPicker").addEventListener("click", (e) => {
  const sw = e.target.closest(".color-swatch");
  if (!sw) return;
  selectedProjectColor = sw.dataset.color;
  document.querySelectorAll("#projectColorPicker .color-swatch").forEach(s => s.classList.remove("selected"));
  sw.classList.add("selected");
});
byId("addPhaseBtn").addEventListener("click", () => {
  draftPhases.push({ id: "ph_" + uid8(), name: "" });
  renderPhaseEditor();
  const inputs = byId("phaseEditor").querySelectorAll(".phase-input");
  inputs[inputs.length - 1].focus();
});
byId("phaseEditor").addEventListener("input", (e) => {
  const row = e.target.closest(".phase-row");
  if (row && e.target.classList.contains("phase-input")) draftPhases[Number(row.dataset.i)].name = e.target.value;
});
byId("phaseEditor").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList.contains("phase-input")){
    e.preventDefault();
    byId("addPhaseBtn").click();
  }
});
byId("phaseEditor").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  const row = e.target.closest(".phase-row");
  if (!btn || !row) return;
  const i = Number(row.dataset.i);
  if (btn.dataset.act === "del") draftPhases.splice(i, 1);
  if (btn.dataset.act === "up" && i > 0) [draftPhases[i - 1], draftPhases[i]] = [draftPhases[i], draftPhases[i - 1]];
  if (btn.dataset.act === "down" && i < draftPhases.length - 1) [draftPhases[i + 1], draftPhases[i]] = [draftPhases[i], draftPhases[i + 1]];
  renderPhaseEditor();
});
byId("projectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = byId("projName").value.trim();
  if (!name) return;
  const form = {
    name,
    description: byId("projDesc").value.trim(),
    deadline: byId("projDeadline").value || null,
    color: selectedProjectColor,
    kind: byId("projTemplate").value,
    status: byId("projStatusSel").value,
    phases: draftPhases.map(ph => ({ ...ph, name: ph.name.trim() })).filter(ph => ph.name),
  };
  closeModal("projectModal");
  if (editingProjectId) await updateProject(editingProjectId, form);
  else await createProject(form, byId("projSampleTasks").checked && !byId("projSampleTasksRow").hidden, byId("projCreateSubject").checked);
});

/* ---- modal: tarefa (criar/editar) ---- */
function renderDraftSubtasks(){
  const box = byId("subtaskList");
  box.innerHTML = draftSubtasks.map((s, i) => `
    <div class="subtask-row ${s.done ? "done" : ""}" data-i="${i}">
      <button type="button" class="proj-check ${s.done ? "on" : ""}" data-act="toggle">✓</button>
      <span class="subtask-title">${esc(s.title)}</span>
      <button type="button" class="phase-btn danger" data-act="del" title="Remover">&times;</button>
    </div>`).join("");
}
function fillTaskPhaseSelect(selectId, project, current){
  const sel = byId(selectId);
  sel.innerHTML = `<option value="">Sem etapa</option>` +
    project.phases.map(ph => `<option value="${ph.id}">${esc(ph.name)}</option>`).join("");
  sel.value = current && project.phases.some(ph => ph.id === current) ? current : "";
}
function openTaskModal(taskId, defaults = {}){
  const t = taskId ? projectTasks.find(x => x.id === taskId) : null;
  const projectId = t ? t.projectId : activeProjectId;
  const project = projects.find(p => p.id === projectId);
  if (!project) return;
  editingTaskId = t ? t.id : null;
  byId("projTaskForm").dataset.projectId = projectId;
  byId("projTaskModalTitle").textContent = t ? "Editar tarefa" : "Nova tarefa";
  byId("projTaskProjectLabel").textContent = project.name;
  byId("projTaskTitle").value = t ? t.title : "";
  byId("projTaskNotes").value = t ? t.notes : "";
  byId("projTaskStatus").value = t ? t.status : "todo";
  byId("projTaskPriority").value = t ? t.priority : "medium";
  byId("projTaskDue").value = t && t.dueDate ? t.dueDate : "";
  fillTaskPhaseSelect("projTaskPhase", project, t ? t.phaseId : (defaults.phaseId || (projPhaseFilter !== "all" && projPhaseFilter !== "none" ? projPhaseFilter : null)));
  draftSubtasks = t ? t.subtasks.map(s => ({ ...s })) : [];
  byId("subtaskInput").value = "";
  renderDraftSubtasks();
  byId("projTaskDeleteBtn").hidden = !t;
  openModal("projTaskModal");
  byId("projTaskTitle").focus();
}
function addDraftSubtask(){
  const input = byId("subtaskInput");
  const title = input.value.trim();
  if (!title) return;
  draftSubtasks.push({ id: uid8(), title, done: false });
  input.value = "";
  renderDraftSubtasks();
  input.focus();
}
byId("closeProjTaskModal").addEventListener("click", () => closeModal("projTaskModal"));
byId("subtaskAddBtn").addEventListener("click", addDraftSubtask);
byId("subtaskInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter"){ e.preventDefault(); addDraftSubtask(); }
});
byId("subtaskList").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  const row = e.target.closest(".subtask-row");
  if (!btn || !row) return;
  const i = Number(row.dataset.i);
  if (btn.dataset.act === "toggle") draftSubtasks[i].done = !draftSubtasks[i].done;
  if (btn.dataset.act === "del") draftSubtasks.splice(i, 1);
  renderDraftSubtasks();
});
byId("projTaskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = byId("projTaskTitle").value.trim();
  if (!title) return;
  const old = editingTaskId ? projectTasks.find(x => x.id === editingTaskId) : null;
  const status = byId("projTaskStatus").value;
  const data = {
    title,
    notes: byId("projTaskNotes").value.trim(),
    status,
    priority: byId("projTaskPriority").value,
    dueDate: byId("projTaskDue").value || null,
    phaseId: byId("projTaskPhase").value || null,
    subtasks: draftSubtasks,
    completedDate: old && old.status === "done" && status === "done" ? old.completedDate : null,
  };
  closeModal("projTaskModal");
  await saveProjectTask(byId("projTaskForm").dataset.projectId, data, editingTaskId);
});
byId("projTaskDeleteBtn").addEventListener("click", () => {
  if (!editingTaskId) return;
  pendingDeleteId = editingTaskId;
  pendingDeleteType = "ptask";
  closeModal("projTaskModal");
  byId("confirmModalTitle").textContent = "Excluir tarefa?";
  byId("confirmModalText").textContent = "Essa ação apaga a tarefa e suas subtarefas. Não pode ser desfeita.";
  openModal("confirmModal");
});

/* ---- modal: várias tarefas de uma vez ---- */
function openBulkModal(){
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;
  byId("projBulkForm").reset();
  fillTaskPhaseSelect("projBulkPhase", project, projPhaseFilter !== "all" && projPhaseFilter !== "none" ? projPhaseFilter : null);
  openModal("projBulkModal");
  byId("projBulkText").focus();
}
byId("closeProjBulkModal").addEventListener("click", () => closeModal("projBulkModal"));
byId("projBulkForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const titles = byId("projBulkText").value.split("\n")
    .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  if (titles.length === 0 || !activeProjectId) return;
  closeModal("projBulkModal");
  await addProjectTasksBulk(activeProjectId, titles, byId("projBulkPhase").value || null);
});

/* ---- calendário: tarefas de projetos com prazo no dia ---- */
function projectTasksDueOn(dateStr){
  return projectTasks.filter(t => t.dueDate === dateStr && projects.some(p => p.id === t.projectId));
}
function renderDayModalProjectTasks(dateStr){
  const box = byId("dayModalProjectTasks");
  if (!box) return;
  const items = projectTasksDueOn(dateStr);
  if (items.length === 0){ box.innerHTML = ""; return; }
  box.innerHTML = `
    <div class="day-modal-tasks-head">Tarefas de projetos</div>
    <div class="day-task-list">
      ${items.map(t => {
        const proj = projects.find(p => p.id === t.projectId);
        return `
          <div class="day-task-row ${t.status === "done" ? "done" : ""}">
            <span class="day-task-title"><span class="dot" style="background:${proj.color}"></span>${esc(t.title)}
              <small class="day-task-project">${esc(proj.name)}</small></span>
            ${t.status === "done" ? `<span class="day-task-done-label">✓ concluída</span>` : `<span class="day-task-done-label pending">pendente</span>`}
          </div>`;
      }).join("")}
    </div>`;
}

/* ---------------------------------------------------------
   10b. Kanban — vários quadros
   Coleções: users/{uid}/kanbanBoards  (nome, cor, colunas[])
             users/{uid}/kanbanCards   (boardId, columnId, título, ordem…)
   A posição de um card dentro da coluna é o campo numérico `order`.
   Ao soltar um card entre dois outros, usamos a média das ordens
   deles — assim só 1 documento é gravado por movimento.
--------------------------------------------------------- */
const KB_COLORS = ["#F2B84B","#4FA3E3","#C15FF2","#4CD9A0","#F26B6B","#8B90AC"];
const KB_GAP = 1024;
const KB_TEMPLATES = {
  classic: { label: "Clássico — A fazer, Em andamento, Em revisão, Concluído",
             columns: [["A fazer"], ["Em andamento"], ["Em revisão"], ["Concluído", true]] },
  simple:  { label: "Simples — A fazer, Fazendo, Feito",
             columns: [["A fazer"], ["Fazendo"], ["Feito", true]] },
  blank:   { label: "Em branco — só uma coluna",
             columns: [["A fazer"]] },
};

function kbBoardsRef(uid){ return db.collection("users").doc(uid).collection("kanbanBoards"); }
function kbCardsRef(uid){ return db.collection("users").doc(uid).collection("kanbanCards"); }

function kbError(prefix, err){
  console.error(err);
  if (err && err.code === "permission-denied"){
    showToast("Sem permissão no Firestore: publique as regras novas do README (kanbanBoards e kanbanCards).");
  } else {
    showToast(prefix + (err && err.message ? err.message : ""));
  }
}

function kbSaveActive(){
  try{ localStorage.setItem("orbita.kanban.active", kbActiveId || ""); } catch(e){}
}

function subscribeKanban(uid){
  if (kbBoardsUnsub) kbBoardsUnsub();
  if (kbCardsUnsub) kbCardsUnsub();
  kbLoaded = false;

  kbBoardsUnsub = kbBoardsRef(uid).orderBy("createdAt", "asc").onSnapshot((snap) => {
    kbBoards = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.name || "Quadro",
        description: d.description || "",
        color: KB_COLORS.includes(d.color) ? d.color : KB_COLORS[1],
        columns: Array.isArray(d.columns)
          ? d.columns.filter(c => c && c.id).map(c => ({ id: String(c.id), name: c.name || "Coluna", done: !!c.done }))
          : [],
      };
    });
    kbLoaded = true;
    renderKanban();
  }, (err) => kbError("Erro ao carregar quadros: ", err));

  kbCardsUnsub = kbCardsRef(uid).onSnapshot((snap) => {
    kbCards = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        boardId: d.boardId,
        columnId: d.columnId,
        title: d.title || "",
        notes: d.notes || "",
        label: KB_COLORS.includes(d.label) ? d.label : null,
        dueDate: d.dueDate || null,
        order: typeof d.order === "number" ? d.order : 0,
      };
    });
    renderKanban();
  }, (err) => kbError("Erro ao carregar cards: ", err));
}

function currentKbBoard(){
  return kbBoards.find(b => b.id === kbActiveId) || kbBoards[0] || null;
}
function kbCardsOf(boardId, columnId){
  return kbCards.filter(c => c.boardId === boardId && c.columnId === columnId)
                .sort((a, b) => a.order - b.order);
}

/* ---- gravações: quadros ---- */
async function createKbBoard(form){
  const user = auth.currentUser;
  if (!user) return;
  try{
    const ref = kbBoardsRef(user.uid).doc();
    const tpl = KB_TEMPLATES[form.template] || KB_TEMPLATES.classic;
    const columns = tpl.columns.map(([name, done]) => ({ id: uid8(), name, done: !!done }));
    kbActiveId = ref.id;
    kbSaveActive();
    await ref.set({
      name: form.name, description: form.description, color: form.color, columns,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast("Quadro criado.");
  } catch(err){ kbError("Erro ao criar quadro: ", err); }
}
async function updateKbBoard(id, form){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await kbBoardsRef(user.uid).doc(id).update({ name: form.name, description: form.description, color: form.color });
    showToast("Quadro atualizado.");
  } catch(err){ kbError("Erro ao salvar quadro: ", err); }
}
async function deleteKbBoard(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    const ops = kbCards.filter(c => c.boardId === id).map(c => (b => b.delete(kbCardsRef(user.uid).doc(c.id))));
    ops.push(b => b.delete(kbBoardsRef(user.uid).doc(id)));
    await commitBatches(ops);
    if (kbActiveId === id){ kbActiveId = null; kbSaveActive(); }
    showToast("Quadro excluído.");
  } catch(err){ kbError("Erro ao excluir quadro: ", err); }
}

/* ---- gravações: colunas ---- */
async function kbSaveColumns(boardId, columns){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await kbBoardsRef(user.uid).doc(boardId).update({ columns });
  } catch(err){ kbError("Erro ao salvar colunas: ", err); }
}
async function deleteKbColumn(columnId){
  const user = auth.currentUser;
  const board = currentKbBoard();
  if (!user || !board) return;
  try{
    const ops = kbCardsOf(board.id, columnId).map(c => (b => b.delete(kbCardsRef(user.uid).doc(c.id))));
    ops.push(b => b.update(kbBoardsRef(user.uid).doc(board.id), { columns: board.columns.filter(c => c.id !== columnId) }));
    await commitBatches(ops);
    showToast("Coluna excluída.");
  } catch(err){ kbError("Erro ao excluir coluna: ", err); }
}

/* ---- gravações: cards ---- */
async function kbAddCard(boardId, columnId, title){
  const user = auth.currentUser;
  if (!user) return;
  try{
    const last = kbCardsOf(boardId, columnId).slice(-1)[0];
    await kbCardsRef(user.uid).add({
      boardId, columnId, title, notes: "", label: null, dueDate: null,
      order: last ? last.order + KB_GAP : KB_GAP,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch(err){ kbError("Erro ao criar card: ", err); }
}
async function kbSaveCard(data, id){
  const user = auth.currentUser;
  const board = currentKbBoard();
  if (!user || !board) return;
  try{
    if (id){
      const old = kbCards.find(c => c.id === id);
      const patch = { title: data.title, notes: data.notes, label: data.label, dueDate: data.dueDate, columnId: data.columnId };
      if (old && old.columnId !== data.columnId){
        const last = kbCardsOf(board.id, data.columnId).slice(-1)[0];
        patch.order = last ? last.order + KB_GAP : KB_GAP;
      }
      await kbCardsRef(user.uid).doc(id).update(patch);
    } else {
      const last = kbCardsOf(board.id, data.columnId).slice(-1)[0];
      await kbCardsRef(user.uid).add({
        boardId: board.id, ...data,
        order: last ? last.order + KB_GAP : KB_GAP,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch(err){ kbError("Erro ao salvar card: ", err); }
}
async function deleteKbCard(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await kbCardsRef(user.uid).doc(id).delete();
    showToast("Card excluído.");
  } catch(err){ kbError("Erro ao excluir card: ", err); }
}
// Move o card para `columnId`, logo depois de `prevId` e antes de `nextId` (ambos opcionais).
async function kbMoveCard(id, columnId, prevId, nextId){
  const user = auth.currentUser;
  const card = kbCards.find(c => c.id === id);
  if (!user || !card) return;
  const prev = prevId ? kbCards.find(c => c.id === prevId) : null;
  const next = nextId ? kbCards.find(c => c.id === nextId) : null;
  try{
    if (prev && next && Math.abs(next.order - prev.order) < 0.001){
      // ordens coladas demais: renumera a coluna inteira numa tacada só
      const list = kbCardsOf(card.boardId, columnId).filter(c => c.id !== id);
      const at = list.findIndex(c => c.id === prev.id) + 1;
      list.splice(at, 0, card);
      await commitBatches(list.map((c, i) => (b => b.update(kbCardsRef(user.uid).doc(c.id), { columnId, order: (i + 1) * KB_GAP }))));
      return;
    }
    let order;
    if (prev && next) order = (prev.order + next.order) / 2;
    else if (prev)    order = prev.order + KB_GAP;
    else if (next)    order = next.order - KB_GAP;
    else              order = KB_GAP;
    if (card.columnId === columnId && card.order === order) return;
    await kbCardsRef(user.uid).doc(id).update({ columnId, order });
  } catch(err){ kbError("Erro ao mover card: ", err); }
}
function kbMoveCardToNeighbor(id, dir){
  const board = currentKbBoard();
  const card = kbCards.find(c => c.id === id);
  if (!board || !card) return;
  const idx = board.columns.findIndex(c => c.id === card.columnId) + dir;
  if (idx < 0 || idx >= board.columns.length) return;
  const target = board.columns[idx].id;
  const last = kbCardsOf(board.id, target).slice(-1)[0];
  kbMoveCard(id, target, last ? last.id : null, null);
}

/* ---- render ---- */
function kbCardHtml(col, colIndex, colCount, c){
  const due = c.dueDate ? dueInfo(c.dueDate, col.done) : null;
  const style = c.label ? ` style="--kb-label:${c.label}"` : "";
  return `
    <div class="kb-card${col.done ? " done" : ""}" draggable="true" data-id="${esc(c.id)}"${style}>
      <div class="kb-card-title">${esc(c.title)}</div>
      ${c.notes ? `<div class="kb-card-notes">${esc(c.notes)}</div>` : ""}
      <div class="kb-card-foot">
        ${due ? `<span class="kb-due ${due.cls}">${esc(due.label)}</span>` : ""}
        <span class="kb-card-move">
          ${colIndex > 0 ? `<button type="button" data-act="left" title="Mover para a coluna anterior" aria-label="Mover para a coluna anterior">&#8249;</button>` : ""}
          ${colIndex < colCount - 1 ? `<button type="button" data-act="right" title="Mover para a próxima coluna" aria-label="Mover para a próxima coluna">&#8250;</button>` : ""}
        </span>
      </div>
    </div>`;
}
function kbAddAreaHtml(colId){
  if (kbAddingCol === colId){
    return `<form class="kb-add-form" data-col="${esc(colId)}">
      <input type="text" class="kb-add-input" maxlength="200" placeholder="Título e Enter…" autocomplete="off">
    </form>`;
  }
  return `<button type="button" class="kb-add-btn" data-act="add-open" data-col="${esc(colId)}">+ Adicionar card</button>`;
}

function renderKbTabs(){
  const wrap = byId("kbBoardTabs");
  const active = currentKbBoard();
  wrap.innerHTML = kbBoards.map(b => {
    const n = kbCards.filter(c => c.boardId === b.id).length;
    return `<button type="button" class="kb-board-chip${active && active.id === b.id ? " active" : ""}" data-id="${esc(b.id)}" style="--kb-color:${b.color}">
      <span class="kb-dot"></span>${esc(b.name)}<span class="kb-chip-count">${n}</span>
    </button>`;
  }).join("");
}

function renderKanban(){
  renderKbTabs();
  const board = currentKbBoard();
  byId("kbEmpty").hidden = !(kbLoaded && !board);
  byId("kbBoardWrap").hidden = !board;
  if (!board) return;

  const wrap = byId("kbBoardWrap");
  wrap.style.setProperty("--kb-color", board.color);
  byId("kbBoardName").textContent = board.name;

  const all = kbCards.filter(c => c.boardId === board.id);
  const doneIds = new Set(board.columns.filter(c => c.done).map(c => c.id));
  const doneCount = all.filter(c => doneIds.has(c.columnId)).length;
  const parts = [`${all.length} ${plural(all.length, "card", "cards")}`];
  if (doneIds.size) parts.push(`${doneCount} ${plural(doneCount, "concluído", "concluídos")}`);
  if (board.description) parts.unshift(board.description);
  byId("kbBoardMeta").textContent = parts.join(" · ");

  const q = kbSearch.trim().toLowerCase();
  const html = board.columns.map((col, i) => {
    const list = kbCardsOf(board.id, col.id);
    const shown = q ? list.filter(c => (c.title + " " + c.notes).toLowerCase().includes(q)) : list;
    const body = shown.length
      ? shown.map(c => kbCardHtml(col, i, board.columns.length, c)).join("")
      : (q && list.length ? `<div class="kb-col-empty">Nenhum card encontrado.</div>` : "");
    return `
      <div class="kb-col${col.done ? " is-done" : ""}" data-col="${esc(col.id)}">
        <div class="kb-col-head">
          <h3>${esc(col.name)}</h3>
          <span class="kb-count">${list.length}</span>
          <button type="button" class="kb-col-menu" data-act="col-edit" title="Editar coluna" aria-label="Editar coluna">&#8943;</button>
        </div>
        <div class="kb-col-body" data-col="${esc(col.id)}">${body}</div>
        ${kbAddAreaHtml(col.id)}
      </div>`;
  }).join("") + `<button type="button" class="kb-add-col" data-act="col-add">+ Nova coluna</button>`;
  kbRendering = true;          // evita que o focusout do campo removido feche o "adicionar card"
  byId("kbBoard").innerHTML = html;
  kbRendering = false;

  if (kbAddingCol){
    const input = byId("kbBoard").querySelector(".kb-add-input");
    if (input){ input.value = kbAddDraft; input.focus(); }
    else kbAddingCol = null;
  }
}

/* ---- seletores de cor ---- */
function renderKbSwatches(containerId, selected, allowNone){
  const el = byId(containerId);
  el.innerHTML = (allowNone
      ? `<button type="button" class="color-swatch kb-swatch-none${!selected ? " selected" : ""}" data-color="" title="Sem etiqueta" aria-label="Sem etiqueta"></button>`
      : "")
    + KB_COLORS.map(c =>
      `<button type="button" class="color-swatch${selected === c ? " selected" : ""}" data-color="${c}" style="background:${c}" aria-label="Cor ${c}"></button>`
    ).join("");
}
byId("kbBoardColorPicker").addEventListener("click", (e) => {
  const sw = e.target.closest(".color-swatch");
  if (!sw) return;
  kbBoardColor = sw.dataset.color;
  renderKbSwatches("kbBoardColorPicker", kbBoardColor, false);
});
byId("kbCardLabelPicker").addEventListener("click", (e) => {
  const sw = e.target.closest(".color-swatch");
  if (!sw) return;
  kbCardLabel = sw.dataset.color || null;
  renderKbSwatches("kbCardLabelPicker", kbCardLabel, true);
});

/* ---- modal: quadro ---- */
byId("kbBoardTemplate").innerHTML = Object.entries(KB_TEMPLATES)
  .map(([key, t]) => `<option value="${key}">${esc(t.label)}</option>`).join("");

function openKbBoardModal(boardId){
  editingKbBoardId = boardId;
  const b = boardId ? kbBoards.find(x => x.id === boardId) : null;
  byId("kbBoardForm").reset();
  byId("kbBoardModalTitle").textContent = b ? "Editar quadro" : "Novo quadro";
  byId("kbBoardSubmitBtn").textContent = b ? "Salvar alterações" : "Criar quadro";
  byId("kbTemplateRow").hidden = !!b;
  byId("kbBoardDeleteBtn").hidden = !b;
  if (b){
    byId("kbBoardNameInput").value = b.name;
    byId("kbBoardDescInput").value = b.description;
    kbBoardColor = b.color;
  } else {
    kbBoardColor = KB_COLORS[kbBoards.length % KB_COLORS.length];
  }
  renderKbSwatches("kbBoardColorPicker", kbBoardColor, false);
  openModal("kbBoardModal");
  byId("kbBoardNameInput").focus();
}
byId("kbBoardForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = {
    name: byId("kbBoardNameInput").value.trim(),
    description: byId("kbBoardDescInput").value.trim(),
    color: kbBoardColor,
    template: byId("kbBoardTemplate").value,
  };
  if (!form.name) return;
  const id = editingKbBoardId;
  closeModal("kbBoardModal");
  if (id) await updateKbBoard(id, form);
  else await createKbBoard(form);
});
byId("kbBoardDeleteBtn").addEventListener("click", () => {
  const id = editingKbBoardId;
  if (!id) return;
  const n = kbCards.filter(c => c.boardId === id).length;
  pendingDeleteId = id; pendingDeleteType = "kboard";
  byId("confirmModalTitle").textContent = "Excluir quadro?";
  byId("confirmModalText").textContent = `Apaga o quadro, as colunas e ${n} ${plural(n, "card", "cards")}. Não pode ser desfeito.`;
  closeModal("kbBoardModal");
  openModal("confirmModal");
});

/* ---- modal: coluna ---- */
function openKbColumnModal(columnId){
  const board = currentKbBoard();
  if (!board) return;
  editingKbColumnId = columnId;
  const col = columnId ? board.columns.find(c => c.id === columnId) : null;
  byId("kbColumnForm").reset();
  byId("kbColumnModalTitle").textContent = col ? "Editar coluna" : "Nova coluna";
  byId("kbColumnSubmitBtn").textContent = col ? "Salvar alterações" : "Criar coluna";
  byId("kbColumnOrderRow").hidden = !col || board.columns.length < 2;
  byId("kbColumnDeleteBtn").hidden = !col || board.columns.length < 2;
  if (col){
    byId("kbColumnNameInput").value = col.name;
    byId("kbColumnDoneInput").checked = col.done;
  }
  openModal("kbColumnModal");
  byId("kbColumnNameInput").focus();
}
byId("kbColumnForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const board = currentKbBoard();
  const name = byId("kbColumnNameInput").value.trim();
  if (!board || !name) return;
  const done = byId("kbColumnDoneInput").checked;
  const id = editingKbColumnId;
  closeModal("kbColumnModal");
  const columns = id
    ? board.columns.map(c => c.id === id ? { ...c, name, done } : c)
    : [...board.columns, { id: uid8(), name, done }];
  await kbSaveColumns(board.id, columns);
});
function kbShiftColumn(dir){
  const board = currentKbBoard();
  if (!board || !editingKbColumnId) return;
  const cols = board.columns.slice();
  const i = cols.findIndex(c => c.id === editingKbColumnId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cols.length) return;
  [cols[i], cols[j]] = [cols[j], cols[i]];
  kbSaveColumns(board.id, cols);
  closeModal("kbColumnModal");
}
byId("kbColLeftBtn").addEventListener("click", () => kbShiftColumn(-1));
byId("kbColRightBtn").addEventListener("click", () => kbShiftColumn(1));
byId("kbColumnDeleteBtn").addEventListener("click", () => {
  const board = currentKbBoard();
  const id = editingKbColumnId;
  if (!board || !id) return;
  const n = kbCardsOf(board.id, id).length;
  pendingDeleteId = id; pendingDeleteType = "kcolumn";
  byId("confirmModalTitle").textContent = "Excluir coluna?";
  byId("confirmModalText").textContent = n
    ? `Apaga a coluna e os ${n} ${plural(n, "card", "cards")} dentro dela. Para guardá-los, mova antes para outra coluna. Não pode ser desfeito.`
    : "Apaga a coluna. Não pode ser desfeito.";
  closeModal("kbColumnModal");
  openModal("confirmModal");
});

/* ---- modal: card ---- */
function openKbCardModal(cardId, columnId){
  const board = currentKbBoard();
  if (!board) return;
  editingKbCardId = cardId;
  const c = cardId ? kbCards.find(x => x.id === cardId) : null;
  byId("kbCardForm").reset();
  byId("kbCardModalTitle").textContent = c ? "Editar card" : "Novo card";
  byId("kbCardSubmitBtn").textContent = c ? "Salvar alterações" : "Criar card";
  byId("kbCardDeleteBtn").hidden = !c;
  byId("kbCardColumnSelect").innerHTML = board.columns
    .map(col => `<option value="${esc(col.id)}">${esc(col.name)}</option>`).join("");
  if (c){
    byId("kbCardTitleInput").value = c.title;
    byId("kbCardNotesInput").value = c.notes;
    byId("kbCardDueInput").value = c.dueDate || "";
    byId("kbCardColumnSelect").value = c.columnId;
    kbCardLabel = c.label;
  } else {
    byId("kbCardColumnSelect").value = columnId || board.columns[0].id;
    kbCardLabel = null;
  }
  renderKbSwatches("kbCardLabelPicker", kbCardLabel, true);
  openModal("kbCardModal");
  byId("kbCardTitleInput").focus();
}
byId("kbCardForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = byId("kbCardTitleInput").value.trim();
  if (!title) return;
  const data = {
    title,
    notes: byId("kbCardNotesInput").value.trim(),
    dueDate: byId("kbCardDueInput").value || null,
    columnId: byId("kbCardColumnSelect").value,
    label: kbCardLabel,
  };
  const id = editingKbCardId;
  closeModal("kbCardModal");
  await kbSaveCard(data, id);
});
byId("kbCardDeleteBtn").addEventListener("click", () => {
  const id = editingKbCardId;
  if (!id) return;
  pendingDeleteId = id; pendingDeleteType = "kcard";
  byId("confirmModalTitle").textContent = "Excluir card?";
  byId("confirmModalText").textContent = "Essa ação apaga o card permanentemente. Não pode ser desfeita.";
  closeModal("kbCardModal");
  openModal("confirmModal");
});

// botões "×" dos modais do Kanban
document.querySelectorAll("[data-close]").forEach(btn =>
  btn.addEventListener("click", () => closeModal(btn.dataset.close)));

/* ---- eventos da tela ---- */
byId("kbNewBoardBtn").addEventListener("click", () => openKbBoardModal(null));
byId("kbEmptyCreateBtn").addEventListener("click", () => openKbBoardModal(null));
byId("kbEditBoardBtn").addEventListener("click", () => {
  const b = currentKbBoard();
  if (b) openKbBoardModal(b.id);
});
byId("kbBoardTabs").addEventListener("click", (e) => {
  const chip = e.target.closest(".kb-board-chip");
  if (!chip) return;
  kbActiveId = chip.dataset.id;
  kbSaveActive();
  kbAddingCol = null; kbAddDraft = "";
  renderKanban();
});
byId("kbSearch").addEventListener("input", (e) => {
  kbSearch = e.target.value;
  renderKanban();
});

const kbBoardEl = byId("kbBoard");
kbBoardEl.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  const cardEl = e.target.closest(".kb-card");
  if (act && act.dataset.act === "col-add") return openKbColumnModal(null);
  if (act && act.dataset.act === "col-edit") return openKbColumnModal(e.target.closest(".kb-col").dataset.col);
  if (act && act.dataset.act === "add-open"){
    kbAddingCol = act.dataset.col; kbAddDraft = "";
    renderKanban();
    return;
  }
  if (!cardEl) return;
  if (act && (act.dataset.act === "left" || act.dataset.act === "right")){
    return kbMoveCardToNeighbor(cardEl.dataset.id, act.dataset.act === "left" ? -1 : 1);
  }
  openKbCardModal(cardEl.dataset.id);
});
// adicionar card rápido (Enter adiciona e mantém o campo aberto; Esc fecha)
kbBoardEl.addEventListener("submit", async (e) => {
  const form = e.target.closest(".kb-add-form");
  if (!form) return;
  e.preventDefault();
  const board = currentKbBoard();
  const input = form.querySelector("input");
  const title = input.value.trim();
  if (!board || !title) return;
  input.value = ""; kbAddDraft = "";
  await kbAddCard(board.id, form.dataset.col, title);
});
kbBoardEl.addEventListener("input", (e) => {
  if (e.target.classList.contains("kb-add-input")) kbAddDraft = e.target.value;
});
kbBoardEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.classList.contains("kb-add-input")){
    e.stopPropagation();
    kbAddingCol = null; kbAddDraft = "";
    renderKanban();
  }
});
kbBoardEl.addEventListener("focusout", (e) => {
  if (kbRendering || !e.target.classList.contains("kb-add-input") || e.target.value.trim()) return;
  const form = e.target.closest(".kb-add-form");
  if (!form || !form.isConnected) return;
  kbAddingCol = null; kbAddDraft = "";
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "kb-add-btn";
  btn.dataset.act = "add-open"; btn.dataset.col = form.dataset.col;
  btn.textContent = "+ Adicionar card";
  form.replaceWith(btn);
});

/* ---- arrastar e soltar (com posição dentro da coluna) ---- */
const kbPlaceholder = document.createElement("div");
kbPlaceholder.className = "kb-drop-line";

function kbClearDrag(){
  kbDraggedId = null;
  kbPlaceholder.remove();
  kbBoardEl.querySelectorAll(".kb-card.dragging").forEach(el => el.classList.remove("dragging"));
  kbBoardEl.querySelectorAll(".kb-col.drag-over").forEach(el => el.classList.remove("drag-over"));
}
kbBoardEl.addEventListener("dragstart", (e) => {
  const card = e.target.closest(".kb-card");
  if (!card) return;
  kbDraggedId = card.dataset.id;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", kbDraggedId);
  setTimeout(() => card.classList.add("dragging"), 0);
});
kbBoardEl.addEventListener("dragend", kbClearDrag);
kbBoardEl.addEventListener("dragover", (e) => {
  if (!kbDraggedId) return;
  const col = e.target.closest(".kb-col");
  if (!col) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  kbBoardEl.querySelectorAll(".kb-col.drag-over").forEach(el => { if (el !== col) el.classList.remove("drag-over"); });
  col.classList.add("drag-over");
  const body = col.querySelector(".kb-col-body");
  const cards = [...body.querySelectorAll(".kb-card:not(.dragging)")];
  const before = cards.find(c => {
    const r = c.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });
  if (before) body.insertBefore(kbPlaceholder, before);
  else body.appendChild(kbPlaceholder);
});
kbBoardEl.addEventListener("drop", (e) => {
  if (!kbDraggedId) return;
  const col = e.target.closest(".kb-col");
  if (!col || !kbPlaceholder.parentElement) return kbClearDrag();
  e.preventDefault();
  const id = kbDraggedId;
  const sibling = (el, dir) => {
    let n = el[dir];
    while (n && !(n.classList.contains("kb-card") && n.dataset.id !== id)) n = n[dir];
    return n;
  };
  const prev = sibling(kbPlaceholder, "previousElementSibling");
  const next = sibling(kbPlaceholder, "nextElementSibling");
  const columnId = col.dataset.col;
  kbClearDrag();
  kbMoveCard(id, columnId, prev ? prev.dataset.id : null, next ? next.dataset.id : null);
});

/* ---------------------------------------------------------
   10c. Notas — post-its em linhas (estilo Obsidian)
   Coleções: users/{uid}/noteRows (título, ordem)
             users/{uid}/notes    (rowId, título, corpo, cor, ordem…)
   O corpo aceita um markdown leve: #tags, [[links]] para outras
   notas, listas, tarefas [ ], **negrito**, *itálico*, ==destaque==,
   ~~riscado~~, `código`, títulos (#) e citações (>).
--------------------------------------------------------- */
const NT_COLORS = ["#F6E27A","#F4A9CB","#9CCBF5","#A9E5B3","#F7B67C","#CDB4F2"];
const NT_GAP = 1024;

let ntRows = [];                 // {id, name, order}
let ntNotes = [];                // {id, rowId, title, body, color, order, updatedAt}
let ntRowsUnsub = null;
let ntNotesUnsub = null;
let ntLoaded = false;
let ntSearch = "";
let ntTagFilter = null;
let ntDraggedId = null;
let ntNoteColor = NT_COLORS[0];
let editingNtRowId = null;
let editingNtNoteId = null;
let ntNoteTargetRow = null;
let ntMode = "edit";

function ntRowsRef(uid){ return db.collection("users").doc(uid).collection("noteRows"); }
function ntNotesRef(uid){ return db.collection("users").doc(uid).collection("notes"); }

function ntError(prefix, err){
  console.error(err);
  if (err && err.code === "permission-denied"){
    showToast("Sem permissão no Firestore: publique as regras novas do README (noteRows e notes).");
  } else {
    showToast(prefix + (err && err.message ? err.message : ""));
  }
}

function subscribeNotes(uid){
  if (ntRowsUnsub) ntRowsUnsub();
  if (ntNotesUnsub) ntNotesUnsub();
  ntLoaded = false;

  ntRowsUnsub = ntRowsRef(uid).onSnapshot((snap) => {
    ntRows = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.name || "Linha",
        order: typeof d.order === "number" ? d.order : 0,
        created: d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0,
      };
    }).sort((a, b) => (a.order - b.order) || (a.created - b.created));
    ntLoaded = true;
    renderNotes();
  }, (err) => ntError("Erro ao carregar linhas: ", err));

  ntNotesUnsub = ntNotesRef(uid).onSnapshot((snap) => {
    ntNotes = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        rowId: d.rowId,
        title: d.title || "Sem título",
        body: d.body || "",
        color: NT_COLORS.includes(d.color) ? d.color : NT_COLORS[0],
        order: typeof d.order === "number" ? d.order : 0,
        updated: d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : 0,
      };
    });
    renderNotes();
  }, (err) => ntError("Erro ao carregar notas: ", err));
}

function ntNotesOf(rowId){
  return ntNotes.filter(n => n.rowId === rowId).sort((a, b) => a.order - b.order);
}
function ntFindByTitle(title){
  const t = title.trim().toLowerCase();
  return ntNotes.find(n => n.title.trim().toLowerCase() === t) || null;
}
function ntTagsOf(body){
  const set = new Set();
  const re = /(^|[\s(])#([\p{L}\p{N}_\-\/]+)/gu;
  let m;
  while ((m = re.exec(body))) set.add(m[2].toLowerCase());
  return [...set];
}
function ntLinksOf(body){
  const out = [];
  const re = /\[\[([^\]\|\n]+)(?:\|[^\]\n]*)?\]\]/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1].trim());
  return out;
}

/* ---- markdown leve (escapa primeiro, depois aplica o estilo) ---- */
function ntInline(raw){
  let t = esc(raw);
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\[\[([^\]\|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_, target, alias) => {
    const found = ntFindByTitle(target.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    const label = alias && alias.trim() ? alias : target;
    return `<a class="nt-link${found ? "" : " missing"}" data-link="${target.replace(/"/g, "&quot;")}" href="#" title="${found ? "Abrir nota" : "Nota ainda não existe — clique para criar"}">${label}</a>`;
  });
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
  t = t.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  t = t.replace(/(^|[\s(])#([\p{L}\p{N}_\-\/]+)/gu,
    (_, pre, tag) => `${pre}<span class="nt-tag" data-tag="${tag.toLowerCase()}">#${tag}</span>`);
  return t;
}
function ntRender(body, opts){
  const interactive = !!(opts && opts.checks);
  const lines = body.split("\n");
  let html = "", inList = false, inCode = false, codeBuf = [];
  const closeList = () => { if (inList){ html += "</ul>"; inList = false; } };
  lines.forEach((line, i) => {
    if (/^```/.test(line)){
      if (inCode){ html += `<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`; codeBuf = []; inCode = false; }
      else { closeList(); inCode = true; }
      return;
    }
    if (inCode){ codeBuf.push(line); return; }
    let m;
    if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))){
      if (!inList){ html += '<ul class="nt-list">'; inList = true; }
      const done = m[1].toLowerCase() === "x";
      html += `<li class="nt-task${done ? " done" : ""}"><input type="checkbox" ${done ? "checked " : ""}${interactive ? `data-ln="${i}"` : "disabled"} tabindex="-1"><span>${ntInline(m[2])}</span></li>`;
      return;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))){
      if (!inList){ html += '<ul class="nt-list">'; inList = true; }
      html += `<li>${ntInline(m[1])}</li>`;
      return;
    }
    closeList();
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))){ html += `<div class="nt-h nt-h${m[1].length}">${ntInline(m[2])}</div>`; return; }
    if ((m = line.match(/^>\s?(.*)$/))){ html += `<blockquote>${ntInline(m[1])}</blockquote>`; return; }
    if (!line.trim()){ html += '<div class="nt-gap"></div>'; return; }
    html += `<p>${ntInline(line)}</p>`;
  });
  if (inCode) html += `<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`;
  closeList();
  return html;
}

/* ---- gravações ---- */
async function ntSaveRow(name, id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    if (id){
      await ntRowsRef(user.uid).doc(id).update({ name });
    } else {
      const last = ntRows.slice(-1)[0];
      await ntRowsRef(user.uid).add({
        name, order: last ? last.order + NT_GAP : NT_GAP,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch(err){ ntError("Erro ao salvar linha: ", err); }
}
async function ntShiftRow(id, dir){
  const user = auth.currentUser;
  const i = ntRows.findIndex(r => r.id === id);
  const j = i + dir;
  if (!user || i < 0 || j < 0 || j >= ntRows.length) return;
  const list = ntRows.slice();
  [list[i], list[j]] = [list[j], list[i]];
  try{
    await commitBatches(list.map((r, k) => (b => b.update(ntRowsRef(user.uid).doc(r.id), { order: (k + 1) * NT_GAP }))));
  } catch(err){ ntError("Erro ao mover linha: ", err); }
}
async function deleteNtRow(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    const ops = ntNotes.filter(n => n.rowId === id).map(n => (b => b.delete(ntNotesRef(user.uid).doc(n.id))));
    ops.push(b => b.delete(ntRowsRef(user.uid).doc(id)));
    await commitBatches(ops);
    showToast("Linha excluída.");
  } catch(err){ ntError("Erro ao excluir linha: ", err); }
}
async function ntSaveNote(data, id){
  const user = auth.currentUser;
  if (!user) return null;
  try{
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    if (id){
      const old = ntNotes.find(n => n.id === id);
      const patch = { title: data.title, body: data.body, color: data.color, rowId: data.rowId, updatedAt: ts };
      if (old && old.rowId !== data.rowId){
        const last = ntNotesOf(data.rowId).slice(-1)[0];
        patch.order = last ? last.order + NT_GAP : NT_GAP;
      }
      await ntNotesRef(user.uid).doc(id).update(patch);
      return id;
    }
    const last = ntNotesOf(data.rowId).slice(-1)[0];
    const ref = await ntNotesRef(user.uid).add({
      ...data, order: last ? last.order + NT_GAP : NT_GAP, createdAt: ts, updatedAt: ts,
    });
    return ref.id;
  } catch(err){ ntError("Erro ao salvar nota: ", err); return null; }
}
async function deleteNtNote(id){
  const user = auth.currentUser;
  if (!user) return;
  try{
    await ntNotesRef(user.uid).doc(id).delete();
    showToast("Post-it excluído.");
  } catch(err){ ntError("Erro ao excluir nota: ", err); }
}
async function ntMoveNote(id, rowId, prevId, nextId){
  const user = auth.currentUser;
  const note = ntNotes.find(n => n.id === id);
  if (!user || !note) return;
  const prev = prevId ? ntNotes.find(n => n.id === prevId) : null;
  const next = nextId ? ntNotes.find(n => n.id === nextId) : null;
  let order;
  if (prev && next) order = (prev.order + next.order) / 2;
  else if (prev) order = prev.order + NT_GAP;
  else if (next) order = next.order - NT_GAP;
  else order = NT_GAP;
  try{
    if (prev && next && Math.abs(next.order - prev.order) < 0.001){
      const list = ntNotesOf(rowId).filter(n => n.id !== id);
      const at = next ? list.findIndex(n => n.id === next.id) : list.length;
      list.splice(at, 0, note);
      await commitBatches(list.map((n, i) => (b => b.update(ntNotesRef(user.uid).doc(n.id), { rowId, order: (i + 1) * NT_GAP }))));
      return;
    }
    await ntNotesRef(user.uid).doc(id).update({ rowId, order });
  } catch(err){ ntError("Erro ao mover nota: ", err); }
}
async function ntToggleCheck(noteId, ln){
  const user = auth.currentUser;
  const note = ntNotes.find(n => n.id === noteId);
  if (!user || !note) return;
  const lines = note.body.split("\n");
  if (!/\[( |x|X)\]/.test(lines[ln] || "")) return;
  lines[ln] = lines[ln].replace(/\[( |x|X)\]/, (_, c) => c === " " ? "[x]" : "[ ]");
  try{
    await ntNotesRef(user.uid).doc(noteId).update({ body: lines.join("\n"), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  } catch(err){ ntError("Erro ao atualizar tarefa: ", err); }
}

/* ---- render ---- */
function ntMatches(n){
  const q = ntSearch.trim().toLowerCase();
  if (ntTagFilter && !ntTagsOf(n.body).includes(ntTagFilter)) return false;
  if (!q) return true;
  if (q.startsWith("#") && q.length > 1) return ntTagsOf(n.body).some(t => t.includes(q.slice(1)));
  return (n.title + " " + n.body).toLowerCase().includes(q);
}
function ntNoteHtml(n){
  const links = ntLinksOf(n.body).length;
  const tags = ntTagsOf(n.body);
  const back = ntNotes.filter(o => o.id !== n.id && ntLinksOf(o.body).some(l => l.toLowerCase() === n.title.trim().toLowerCase())).length;
  const foot = [];
  if (links) foot.push(`<span title="Links para outras notas">🔗 ${links}</span>`);
  if (back) foot.push(`<span title="Notas que apontam para esta">↩ ${back}</span>`);
  return `
    <article class="nt-note" draggable="true" data-id="${esc(n.id)}" style="--nt-color:${n.color}">
      <h4 class="nt-note-title">${esc(n.title)}</h4>
      <div class="nt-note-body">${ntRender(n.body, { checks: true })}</div>
      ${(tags.length || foot.length) ? `<div class="nt-note-foot">${tags.slice(0, 4).map(t => `<span class="nt-chip" data-tag="${esc(t)}">#${esc(t)}</span>`).join("")}${foot.length ? `<span class="nt-foot-meta">${foot.join("")}</span>` : ""}</div>` : ""}
    </article>`;
}
function renderNotes(){
  const rowsEl = byId("ntRows");
  if (!rowsEl) return;
  byId("ntEmpty").hidden = !(ntLoaded && !ntRows.length);

  // tags
  const counts = {};
  ntNotes.forEach(n => ntTagsOf(n.body).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  const tagList = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  if (ntTagFilter && !counts[ntTagFilter]) ntTagFilter = null;
  const tagsEl = byId("ntTags");
  tagsEl.hidden = !tagList.length;
  tagsEl.innerHTML = tagList.map(t =>
    `<button type="button" class="nt-tag-btn${ntTagFilter === t ? " active" : ""}" data-tag="${esc(t)}">#${esc(t)}<small>${counts[t]}</small></button>`).join("");

  byId("ntMeta").textContent = ntRows.length
    ? `${ntNotes.length} ${plural(ntNotes.length, "post-it", "post-its")} em ${ntRows.length} ${plural(ntRows.length, "linha", "linhas")}`
    : "";

  const filtering = !!(ntSearch.trim() || ntTagFilter);
  rowsEl.innerHTML = ntRows.map(row => {
    const all = ntNotesOf(row.id);
    const shown = all.filter(ntMatches);
    if (filtering && !shown.length) return "";
    return `
      <section class="nt-row" data-row="${esc(row.id)}">
        <div class="nt-row-head">
          <h3>${esc(row.name)}</h3>
          <span class="kb-count">${all.length}</span>
          <button type="button" class="kb-col-menu" data-act="row-edit" title="Editar linha" aria-label="Editar linha">&#8943;</button>
        </div>
        <div class="nt-row-body" data-row="${esc(row.id)}">
          ${shown.map(ntNoteHtml).join("")}
          <button type="button" class="nt-add" data-act="note-add" title="Novo post-it" aria-label="Novo post-it nesta linha"><span>+</span>Post-it</button>
        </div>
      </section>`;
  }).join("");
  if (filtering && !rowsEl.innerHTML.trim() && ntRows.length){
    rowsEl.innerHTML = `<div class="kb-col-empty nt-none">Nenhuma nota encontrada.</div>`;
  }
}

/* ---- modal: linha ---- */
function openNtRowModal(rowId){
  editingNtRowId = rowId;
  const r = rowId ? ntRows.find(x => x.id === rowId) : null;
  byId("ntRowForm").reset();
  byId("ntRowModalTitle").textContent = r ? "Editar linha" : "Nova linha";
  byId("ntRowSubmitBtn").textContent = r ? "Salvar alterações" : "Criar linha";
  byId("ntRowOrderRow").hidden = !r || ntRows.length < 2;
  byId("ntRowDeleteBtn").hidden = !r;
  if (r) byId("ntRowNameInput").value = r.name;
  openModal("ntRowModal");
  byId("ntRowNameInput").focus();
}
byId("ntRowForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = byId("ntRowNameInput").value.trim();
  if (!name) return;
  const id = editingNtRowId;
  closeModal("ntRowModal");
  await ntSaveRow(name, id);
});
byId("ntRowUpBtn").addEventListener("click", () => { if (editingNtRowId) ntShiftRow(editingNtRowId, -1); closeModal("ntRowModal"); });
byId("ntRowDownBtn").addEventListener("click", () => { if (editingNtRowId) ntShiftRow(editingNtRowId, 1); closeModal("ntRowModal"); });
byId("ntRowDeleteBtn").addEventListener("click", () => {
  const id = editingNtRowId;
  if (!id) return;
  const n = ntNotesOf(id).length;
  pendingDeleteId = id; pendingDeleteType = "ntrow";
  byId("confirmModalTitle").textContent = "Excluir linha?";
  byId("confirmModalText").textContent = n
    ? `Apaga a linha e os ${n} ${plural(n, "post-it", "post-its")} dentro dela. Para guardá-los, mova antes para outra linha. Não pode ser desfeito.`
    : "Apaga a linha. Não pode ser desfeito.";
  closeModal("ntRowModal");
  openModal("confirmModal");
});

/* ---- modal: nota ---- */
function renderNtSwatches(){
  byId("ntNoteColorPicker").innerHTML = NT_COLORS.map(c =>
    `<button type="button" class="color-swatch${ntNoteColor === c ? " selected" : ""}" data-color="${c}" style="background:${c}" aria-label="Cor ${c}"></button>`).join("");
}
byId("ntNoteColorPicker").addEventListener("click", (e) => {
  const sw = e.target.closest(".color-swatch");
  if (!sw) return;
  ntNoteColor = sw.dataset.color;
  renderNtSwatches();
});
function ntSetMode(mode){
  ntMode = mode;
  document.querySelectorAll(".nt-seg button").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  byId("ntNoteBodyInput").hidden = mode !== "edit";
  const prev = byId("ntNotePreview");
  prev.hidden = mode !== "preview";
  if (mode === "preview"){
    const body = byId("ntNoteBodyInput").value;
    prev.innerHTML = body.trim() ? ntRender(body) : `<p class="nt-empty-prev">Nada para mostrar ainda.</p>`;
  }
}
document.querySelector(".nt-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (b) ntSetMode(b.dataset.mode);
});
function ntRenderBacklinks(noteId, title){
  const el = byId("ntBacklinks");
  if (!noteId){ el.hidden = true; return; }
  const t = title.trim().toLowerCase();
  const refs = ntNotes.filter(o => o.id !== noteId && ntLinksOf(o.body).some(l => l.toLowerCase() === t));
  el.hidden = !refs.length;
  el.innerHTML = refs.length
    ? `<span>Mencionada em</span>` + refs.map(r => `<a class="nt-link" href="#" data-open="${esc(r.id)}">${esc(r.title)}</a>`).join("")
    : "";
}
function openNtNoteModal(noteId, rowId, presetTitle){
  if (!ntRows.length) return openNtRowModal(null);
  editingNtNoteId = noteId;
  const n = noteId ? ntNotes.find(x => x.id === noteId) : null;
  byId("ntNoteForm").reset();
  byId("ntNoteModalTitle").textContent = n ? "Editar post-it" : "Novo post-it";
  byId("ntNoteSubmitBtn").textContent = n ? "Salvar alterações" : "Criar post-it";
  byId("ntNoteDeleteBtn").hidden = !n;
  byId("ntNoteRowSelect").innerHTML = ntRows.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  if (n){
    byId("ntNoteTitleInput").value = n.title;
    byId("ntNoteBodyInput").value = n.body;
    byId("ntNoteRowSelect").value = n.rowId;
    ntNoteColor = n.color;
  } else {
    byId("ntNoteTitleInput").value = presetTitle || "";
    byId("ntNoteRowSelect").value = rowId || ntRows[0].id;
    const used = ntNotes.length;
    ntNoteColor = NT_COLORS[used % NT_COLORS.length];
  }
  renderNtSwatches();
  ntRenderBacklinks(noteId, n ? n.title : "");
  ntSetMode(n && n.body ? "preview" : "edit");
  openModal("ntNoteModal");
  (n && n.body ? byId("ntNoteTitleInput") : (presetTitle ? byId("ntNoteBodyInput") : byId("ntNoteTitleInput"))).focus();
}
function ntReadNoteForm(){
  return {
    title: byId("ntNoteTitleInput").value.trim(),
    body: byId("ntNoteBodyInput").value.replace(/\s+$/, ""),
    rowId: byId("ntNoteRowSelect").value,
    color: ntNoteColor,
  };
}
byId("ntNoteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = ntReadNoteForm();
  if (!data.title) return;
  const id = editingNtNoteId;
  closeModal("ntNoteModal");
  await ntSaveNote(data, id);
});
// Ctrl/Cmd + Enter salva
byId("ntNoteModal").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter"){
    e.preventDefault();
    byId("ntNoteForm").requestSubmit();
  }
});
byId("ntNoteDeleteBtn").addEventListener("click", () => {
  const id = editingNtNoteId;
  if (!id) return;
  pendingDeleteId = id; pendingDeleteType = "ntnote";
  byId("confirmModalTitle").textContent = "Excluir post-it?";
  byId("confirmModalText").textContent = "Essa ação apaga o post-it permanentemente. Não pode ser desfeita.";
  closeModal("ntNoteModal");
  openModal("confirmModal");
});

// seguir [[link]]: abre a nota (ou cria, se ainda não existe)
async function ntFollowLink(title, fromRowId){
  const found = ntFindByTitle(title);
  if (found) return openNtNoteModal(found.id);
  openNtNoteModal(null, fromRowId, title.trim());
}
// links dentro do modal (pré-visualização e "mencionada em")
byId("ntNoteModal").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]");
  const link = e.target.closest("a[data-link]");
  if (!open && !link) return;
  e.preventDefault();
  const data = ntReadNoteForm();
  const id = editingNtNoteId;
  if (data.title && (id || data.body)) await ntSaveNote(data, id);   // não perde o que foi escrito
  if (open) return openNtNoteModal(open.dataset.open);
  ntFollowLink(link.dataset.link.replace(/&amp;/g, "&"), data.rowId);
});

/* ---- eventos da tela ---- */
byId("ntNewRowBtn").addEventListener("click", () => openNtRowModal(null));
byId("ntEmptyCreateBtn").addEventListener("click", () => openNtRowModal(null));
byId("ntSearch").addEventListener("input", (e) => { ntSearch = e.target.value; renderNotes(); });
byId("ntTags").addEventListener("click", (e) => {
  const b = e.target.closest(".nt-tag-btn");
  if (!b) return;
  ntTagFilter = ntTagFilter === b.dataset.tag ? null : b.dataset.tag;
  renderNotes();
});

const ntRowsEl = byId("ntRows");
ntRowsEl.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (act && act.dataset.act === "row-edit") return openNtRowModal(e.target.closest(".nt-row").dataset.row);
  if (act && act.dataset.act === "note-add") return openNtNoteModal(null, e.target.closest(".nt-row").dataset.row);
  const check = e.target.closest('input[type="checkbox"][data-ln]');
  if (check){
    e.preventDefault();
    return ntToggleCheck(e.target.closest(".nt-note").dataset.id, Number(check.dataset.ln));
  }
  const link = e.target.closest("a[data-link]");
  if (link){
    e.preventDefault();
    return ntFollowLink(link.dataset.link.replace(/&amp;/g, "&"), e.target.closest(".nt-row").dataset.row);
  }
  const tag = e.target.closest("[data-tag]");
  if (tag){
    ntTagFilter = tag.dataset.tag;
    return renderNotes();
  }
  const note = e.target.closest(".nt-note");
  if (note) openNtNoteModal(note.dataset.id);
});

/* ---- arrastar e soltar (entre linhas e dentro da linha) ---- */
const ntPlaceholder = document.createElement("div");
ntPlaceholder.className = "nt-drop-line";
function ntClearDrag(){
  ntDraggedId = null;
  ntPlaceholder.remove();
  ntRowsEl.querySelectorAll(".nt-note.dragging").forEach(el => el.classList.remove("dragging"));
  ntRowsEl.querySelectorAll(".nt-row.drag-over").forEach(el => el.classList.remove("drag-over"));
}
ntRowsEl.addEventListener("dragstart", (e) => {
  const note = e.target.closest(".nt-note");
  if (!note) return;
  ntDraggedId = note.dataset.id;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", ntDraggedId);
  setTimeout(() => note.classList.add("dragging"), 0);
});
ntRowsEl.addEventListener("dragend", ntClearDrag);
ntRowsEl.addEventListener("dragover", (e) => {
  if (!ntDraggedId) return;
  const row = e.target.closest(".nt-row");
  if (!row) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  ntRowsEl.querySelectorAll(".nt-row.drag-over").forEach(el => { if (el !== row) el.classList.remove("drag-over"); });
  row.classList.add("drag-over");
  const body = row.querySelector(".nt-row-body");
  const notes = [...body.querySelectorAll(".nt-note:not(.dragging)")];
  const before = notes.find(n => {
    const r = n.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2;
  });
  if (before) body.insertBefore(ntPlaceholder, before);
  else body.insertBefore(ntPlaceholder, body.querySelector(".nt-add"));
});
ntRowsEl.addEventListener("drop", (e) => {
  if (!ntDraggedId) return;
  const row = e.target.closest(".nt-row");
  if (!row || !ntPlaceholder.parentElement) return ntClearDrag();
  e.preventDefault();
  const id = ntDraggedId;
  const sibling = (el, dir) => {
    let n = el[dir];
    while (n && !(n.classList.contains("nt-note") && n.dataset.id !== id)) n = n[dir];
    return n;
  };
  const prev = sibling(ntPlaceholder, "previousElementSibling");
  const next = sibling(ntPlaceholder, "nextElementSibling");
  const rowId = row.dataset.row;
  ntClearDrag();
  ntMoveNote(id, rowId, prev ? prev.dataset.id : null, next ? next.dataset.id : null);
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
