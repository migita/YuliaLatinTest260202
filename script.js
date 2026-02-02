// script.js

(() => {
  "use strict";

  const STORAGE_KEY = "latinQuizProgress_v1";

  // ----- Utilities -----
  const $ = (id) => document.getElementById(id);

  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

  function shuffle(arr){
    for(let i = arr.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function normalize(s){
    return (s || "")
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function uniqueBy(arr, keyFn){
    const seen = new Set();
    const out = [];
    for(const x of arr){
      const k = keyFn(x);
      if(seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  }

  // ----- Progress (localStorage) -----
  function loadProgress(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return { items: {} };
      const obj = JSON.parse(raw);
      if(!obj || typeof obj !== "object") return { items: {} };
      if(!obj.items || typeof obj.items !== "object") obj.items = {};
      return obj;
    }catch{
      return { items: {} };
    }
  }

  function saveProgress(p){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  }

  function getItemProgress(progress, id){
    const p = progress.items[id];
    if(p && typeof p === "object") return p;
    return { box: 1, correct: 0, wrong: 0, lastSeen: 0 };
  }

  function updateItemProgress(progress, id, isCorrect){
    const p = getItemProgress(progress, id);
    if(isCorrect){
      p.correct = (p.correct || 0) + 1;
      p.box = clamp((p.box || 1) + 1, 1, 5);
    }else{
      p.wrong = (p.wrong || 0) + 1;
      p.box = 1;
    }
    p.lastSeen = Date.now();
    progress.items[id] = p;
    saveProgress(progress);
  }

  function progressSummaryText(progress){
    const items = Object.values(progress.items || {});
    const totalTracked = items.length;
    const mastered = items.filter(x => (x.box || 1) >= 4).length;
    if(totalTracked === 0) return "No saved progress yet.";
    return `Saved progress: ${mastered} mastered / ${totalTracked} seen (this browser)`;
  }

  // ----- Data -----
  function buildPools(){
    const vocab = (window.VOCAB_ITEMS || []).map(x => ({...x, deck: "vocab"}));
    const grammar = (window.GRAMMAR_ITEMS || []).map(x => ({...x, deck: "grammar"}));
    return { vocab, grammar, mixed: [...vocab, ...grammar] };
  }

  // ----- Sampling -----
  function itemWeight(progress, item){
    // Leitner-ish weighting: lower boxes show up more often.
    const p = getItemProgress(progress, item.id);
    const box = clamp(p.box || 1, 1, 5);
    const base = [0, 6, 3.5, 2.2, 1.2, 0.7][box] || 6;

    const wrong = p.wrong || 0;
    const correct = p.correct || 0;
    const ratio = wrong / Math.max(1, correct);
    const penalty = 1 + Math.min(2.5, ratio);

    // small recency penalty: if seen very recently, slightly down-weight
    const ageMin = (Date.now() - (p.lastSeen || 0)) / 60000;
    const recency = ageMin < 10 ? 0.6 : 1.0;

    return base * penalty * recency;
  }

  function weightedSampleWithoutReplacement(items, k, weightFn){
    if(k >= items.length) return [...items];
    const pool = [...items];
    const out = [];
    for(let n = 0; n < k; n++){
      let total = 0;
      const weights = pool.map(it => {
        const w = Math.max(0.0001, weightFn(it));
        total += w;
        return w;
      });
      let r = Math.random() * total;
      let idx = 0;
      for(; idx < pool.length; idx++){
        r -= weights[idx];
        if(r <= 0) break;
      }
      idx = clamp(idx, 0, pool.length - 1);
      out.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return out;
  }

  // ----- Answer handling -----
  function acceptableAnswers(gloss){
    const out = [];
    const g = (gloss || "").trim();
    if(!g) return out;

    out.push(g);

    // Split on commas and slashes (but keep multi-word phrases).
    const parts = g.split(/\s*,\s*/g).flatMap(p => p.split(/\s*\/\s*/g));
    for(const p of parts){
      const t = p.trim();
      if(t) out.push(t);
    }

    // If starts with "he/she/it " allow dropping it
    const lower = g.toLowerCase();
    if(lower.startsWith("he/she/it ")){
      out.push(g.slice("he/she/it ".length));
    }

    // For "Oh no! Oh dear!" style: split on "!" and "?".
    if(/[!?]/.test(g)){
      g.split(/[!?]+/).forEach(x => {
        const t = x.trim();
        if(t) out.push(t);
      });
    }

    return uniqueBy(out, x => normalize(x));
  }

  function isTypedCorrect(item, userInput){
    const u = normalize(userInput);
    if(!u) return false;
    const acc = acceptableAnswers(item.gloss).map(normalize);
    return acc.includes(u);
  }

  // ----- Multiple choice options -----
  function buildChoices(item, pool, count){
    const correct = item.gloss;
    const distinctPool = pool.filter(x => x.id !== item.id);

    // Build distractors with unique glosses and not equal to correct
    const distractors = [];
    const seenGloss = new Set([normalize(correct)]);

    const shuffled = shuffle([...distinctPool]);
    for(const cand of shuffled){
      const ng = normalize(cand.gloss);
      if(seenGloss.has(ng)) continue;
      seenGloss.add(ng);
      distractors.push(cand.gloss);
      if(distractors.length >= count - 1) break;
    }

    const choices = [correct, ...distractors];
    return shuffle(choices);
  }

  // ----- App State -----
  const state = {
    screen: "start",
    deck: "vocab",
    mode: "mc",
    total: 20,
    spaced: true,
    shuffle: true,

    pool: [],
    questions: [],
    idx: 0,
    correct: 0,
    streak: 0,
    answered: false,
    missed: [],
    currentChoices: [],
  };

  let progress = loadProgress();
  const pools = buildPools();

  // ----- DOM refs -----
  const screenStart = $("screenStart");
  const screenQuiz = $("screenQuiz");
  const screenEnd = $("screenEnd");

  const deckSelect = $("deckSelect");
  const modeSelect = $("modeSelect");
  const countSelect = $("countSelect");
  const spacedToggle = $("spacedToggle");
  const shuffleToggle = $("shuffleToggle");

  const startBtn = $("startBtn");
  const resetBtn = $("resetBtn");
  const exportBtn = $("exportBtn");

  const statDeck = $("statDeck");
  const statMode = $("statMode");
  const statQ = $("statQ");
  const statTotal = $("statTotal");
  const statCorrect = $("statCorrect");
  const statStreak = $("statStreak");
  const barFill = $("barFill");

  const latinPrompt = $("latinPrompt");
  const latinHint = $("latinHint");
  const optionsWrap = $("options");
  const typeRow = $("typeRow");
  const typeInput = $("typeInput");
  const submitTypeBtn = $("submitTypeBtn");
  const feedbackBox = $("feedbackBox");
  const feedbackTitle = $("feedbackTitle");
  const feedbackBody = $("feedbackBody");
  const nextBtn = $("nextBtn");
  const quitBtn = $("quitBtn");

  const endScore = $("endScore");
  const endAcc = $("endAcc");
  const missedWrap = $("missedWrap");
  const missedList = $("missedList");
  const backBtn = $("backBtn");
  const restartBtn = $("restartBtn");
  const retryMissedBtn = $("retryMissedBtn");

  const progressSummary = $("progressSummary");

  // ----- Rendering helpers -----
  function showScreen(name){
    state.screen = name;
    screenStart.classList.toggle("hidden", name !== "start");
    screenQuiz.classList.toggle("hidden", name !== "quiz");
    screenEnd.classList.toggle("hidden", name !== "end");
  }

  function updateSummary(){
    progressSummary.textContent = progressSummaryText(progress);
  }

  function deckLabel(deck){
    if(deck === "vocab") return "Vocabulary";
    if(deck === "grammar") return "Grammar";
    return "Mixed";
  }

  function modeLabel(mode){
    if(mode === "mc") return "Multiple choice";
    return "Type answer";
  }

  function questionModeForItem(item){
    // Typing is great for vocab; grammar items are usually better as multiple-choice.
    if(state.mode === "type" && item.deck !== "vocab") return "mc";
    return state.mode;
  }

  function renderQuestion(){
    const item = state.questions[state.idx];
    state.answered = false;
    nextBtn.disabled = true;
    feedbackBox.classList.add("hidden");
    optionsWrap.innerHTML = "";
    typeInput.value = "";

    const qMode = questionModeForItem(item);

    // Header stats
    statDeck.textContent = deckLabel(state.deck);
    statMode.textContent = modeLabel(state.mode) + (qMode !== state.mode ? " (grammar shown as multiple-choice)" : "");
    statQ.textContent = String(state.idx + 1);
    statTotal.textContent = String(state.questions.length);
    statCorrect.textContent = String(state.correct);
    statStreak.textContent = String(state.streak);

    const pct = ((state.idx) / Math.max(1, state.questions.length)) * 100;
    barFill.style.width = `${pct.toFixed(1)}%`;

    // Prompt
    latinPrompt.textContent = item.latin;
    latinHint.textContent = item.deck === "grammar" ? "Grammar form" : "Vocabulary";

    if(qMode === "type"){
      typeRow.classList.remove("hidden");
      optionsWrap.classList.add("hidden");
      typeInput.focus();
    }else{
      typeRow.classList.add("hidden");
      optionsWrap.classList.remove("hidden");

      const choices = buildChoices(item, state.pool, 4);
      state.currentChoices = choices;

      choices.forEach((c, idx) => {
        const btn = document.createElement("button");
        btn.className = "choice";
        btn.type = "button";
        btn.textContent = `${idx + 1}. ${c}`;
        btn.addEventListener("click", () => submitChoice(idx));
        optionsWrap.appendChild(btn);
      });
    }
  }

  function renderEnd(){
    const total = state.questions.length;
    const correct = state.correct;
    const acc = total ? Math.round((correct / total) * 100) : 0;

    endScore.textContent = `${correct} / ${total}`;
    endAcc.textContent = `${acc}%`;

    // Missed list
    missedList.innerHTML = "";
    const missed = state.missed;

    if(missed.length === 0){
      missedWrap.classList.add("hidden");
      retryMissedBtn.disabled = true;
    }else{
      missedWrap.classList.remove("hidden");
      retryMissedBtn.disabled = false;

      missed.forEach(it => {
        const li = document.createElement("li");
        li.className = "missedItem";
        li.innerHTML = `<code>${escapeHtml(it.latin)}</code> → ${escapeHtml(it.gloss)}`;
        missedList.appendChild(li);
      });
    }

    barFill.style.width = "100%";
  }

  function escapeHtml(str){
    return (str || "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll(""","&quot;")
      .replaceAll("'","&#039;");
  }

  // ----- Quiz control -----
  function startQuiz(withItems){
    // read settings
    state.deck = deckSelect.value;
    state.mode = modeSelect.value;
    const countVal = countSelect.value;
    state.total = countVal === "all" ? "all" : parseInt(countVal, 10);
    state.spaced = spacedToggle.checked;
    state.shuffle = shuffleToggle.checked;

    // base pool
    let pool = withItems ? [...withItems] : [...(pools[state.deck] || [])];

    // ensure unique by id
    pool = uniqueBy(pool, x => x.id);

    state.pool = pool;

    // build questions list
    let questions;
    if(state.total === "all"){
      questions = [...pool];
    }else{
      const k = clamp(state.total, 1, pool.length);
      if(state.spaced){
        questions = weightedSampleWithoutReplacement(pool, k, (it) => itemWeight(progress, it));
      }else{
        questions = shuffle([...pool]).slice(0, k);
      }
    }

    if(state.shuffle) shuffle(questions);

    state.questions = questions;
    state.idx = 0;
    state.correct = 0;
    state.streak = 0;
    state.answered = false;
    state.missed = [];
    state.currentChoices = [];

    showScreen("quiz");
    renderQuestion();
  }

  function finishQuiz(){
    showScreen("end");
    renderEnd();
    updateSummary();
  }

  function quitQuiz(){
    showScreen("start");
    updateSummary();
  }

  // ----- Submitting answers -----
  function markAnswered(item, isCorrect){
    state.answered = true;
    nextBtn.disabled = false;

    if(isCorrect){
      state.correct += 1;
      state.streak += 1;
      feedbackBox.className = "feedback good";
      feedbackTitle.textContent = "Correct";
      feedbackBody.textContent = item.gloss;
    }else{
      state.streak = 0;
      state.missed.push(item);
      feedbackBox.className = "feedback bad";
      feedbackTitle.textContent = "Incorrect";
      feedbackBody.innerHTML = `Correct: <b>${escapeHtml(item.gloss)}</b>`;
    }

    feedbackBox.classList.remove("hidden");
    updateItemProgress(progress, item.id, isCorrect);

    // Update header stats immediately
    statCorrect.textContent = String(state.correct);
    statStreak.textContent = String(state.streak);
  }

  function submitChoice(choiceIdx){
    if(state.answered) return;
    const item = state.questions[state.idx];
    const chosen = state.currentChoices[choiceIdx];
    const isCorrect = normalize(chosen) === normalize(item.gloss);

    // highlight buttons
    const buttons = Array.from(optionsWrap.querySelectorAll("button.choice"));
    buttons.forEach((b, idx) => {
      const text = state.currentChoices[idx];
      const match = normalize(text) === normalize(item.gloss);
      if(match) b.classList.add("correct");
      if(idx === choiceIdx && !match) b.classList.add("wrong");
      b.disabled = true;
    });

    markAnswered(item, isCorrect);
  }

  function submitTyped(){
    if(state.answered) return;
    const item = state.questions[state.idx];
    const val = typeInput.value;
    const ok = isTypedCorrect(item, val);

    markAnswered(item, ok);
  }

  function nextQuestion(){
    if(!state.answered) return;
    state.idx += 1;
    if(state.idx >= state.questions.length){
      finishQuiz();
      return;
    }
    renderQuestion();
  }

  // ----- Buttons -----
  startBtn.addEventListener("click", () => startQuiz(null));

  nextBtn.addEventListener("click", nextQuestion);

  quitBtn.addEventListener("click", () => {
    if(confirm("Quit the quiz? Your progress is saved.")){
      quitQuiz();
    }
  });

  submitTypeBtn.addEventListener("click", submitTyped);

  typeInput.addEventListener("keydown", (e) => {
    if(e.key === "Enter"){
      e.preventDefault();
      submitTyped();
    }
  });

  // keyboard for MC: 1-4
  window.addEventListener("keydown", (e) => {
    if(state.screen !== "quiz") return;
    if(state.answered){
      if(e.key === "Enter") nextQuestion();
      return;
    }
    const item = state.questions[state.idx];
    const qMode = questionModeForItem(item);
    if(qMode !== "mc") return;

    const n = parseInt(e.key, 10);
    if(n >= 1 && n <= 4){
      submitChoice(n - 1);
    }
  });

  resetBtn.addEventListener("click", () => {
    if(confirm("Reset saved progress in this browser?")){
      localStorage.removeItem(STORAGE_KEY);
      progress = loadProgress();
      updateSummary();
      alert("Progress reset.");
    }
  });

  exportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(progress, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "latin-quiz-progress.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  backBtn.addEventListener("click", () => {
    showScreen("start");
    updateSummary();
  });

  restartBtn.addEventListener("click", () => startQuiz(null));

  retryMissedBtn.addEventListener("click", () => {
    if(state.missed.length === 0){
      startQuiz(null);
      return;
    }
    // retry only missed items
    const missedItems = uniqueBy(state.missed, x => x.id);
    showScreen("start");
    // keep current settings, but start immediately with missed
    startQuiz(missedItems);
  });

  // Initial render
  updateSummary();
  showScreen("start");
})();
