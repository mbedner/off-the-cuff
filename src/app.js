import { badgeRules, lessons, modes, prompts, reflectionQuestions } from "./content.js";

const storageKey = "off-the-cuff-state-v1";
const todayKey = () => new Date().toISOString().slice(0, 10);
const dayName = () => new Date().toLocaleDateString(undefined, { weekday: "long" });
const $ = (selector) => document.querySelector(selector);
const randomItem = (items, seed = Date.now()) => items[Math.abs(seed) % items.length];

const defaultState = {
  tab: "today",
  activeSession: null,
  activeModeId: null,
  step: "idle",
  exerciseIndex: 0,
  timerLeft: 60,
  timerRunning: false,
  ratingsDraft: { clarity: 3, confidence: 3, flow: 3, fun: 3 },
  progress: { completions: [], reflections: [], ratings: [], modeCounts: {}, minutes: 0 },
  settings: { sessionLength: 6, workweekOnly: true, sound: true, silly: true, work: true, life: true }
};

let state = loadState();
let timerId = null;
let recorder = null;
let audioChunks = [];

function loadState() {
  try {
    return { ...defaultState, ...JSON.parse(localStorage.getItem(storageKey) || "{}") };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  const durable = {
    progress: state.progress,
    settings: state.settings,
    tab: state.tab
  };
  localStorage.setItem(storageKey, JSON.stringify(durable));
}

function stats() {
  const completions = state.progress.completions;
  const sorted = [...new Set(completions.map((item) => item.date))].sort().reverse();
  let streak = 0;
  const cursor = new Date(todayKey());
  for (let i = 0; i < 365; i += 1) {
    const key = cursor.toISOString().slice(0, 10);
    if (sorted.includes(key)) streak += 1;
    else if (i === 0) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    } else break;
    cursor.setDate(cursor.getDate() - 1);
  }
  const allRatings = state.progress.ratings;
  const ratingTotals = { clarity: 0, confidence: 0, flow: 0, fun: 0 };
  allRatings.forEach((rating) => Object.keys(ratingTotals).forEach((key) => ratingTotals[key] += rating[key] || 0));
  const ratingCount = Math.max(allRatings.length, 1);
  const ratings = Object.fromEntries(Object.entries(ratingTotals).map(([key, value]) => [key, +(value / ratingCount).toFixed(1)]));
  const average = +((ratings.clarity + ratings.confidence + ratings.flow + ratings.fun) / 4).toFixed(1);
  const modeCounts = { story: 0, yes: 0, bad: 0, gibberish: 0, ...state.progress.modeCounts };
  const favoriteMode = Object.entries(state.progress.modeCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  return { streak, sessions: completions.length, minutes: state.progress.minutes, ratings, average, modeCounts, favoriteMode };
}

function todayWorkout() {
  const weekday = new Date().getDay();
  const map = {
    1: { title: "Structure Sprint", modeIds: ["prep", "table"], lesson: 3, line: "A clear first sentence gives your brain a runway." },
    2: { title: "Yes, And Playground", modeIds: ["yes", "random"], lesson: 0, line: "Accept the prompt, then make it yours." },
    3: { title: "Story + Object Combo", modeIds: ["story", "object"], lesson: 9, line: "Details turn ordinary answers into scenes." },
    4: { title: "Flip the Argument", modeIds: ["defend", "what"], lesson: 5, line: "Commit first. Polish later." },
    5: { title: "Character Pitch Day", modeIds: ["character", "bad"], lesson: 21, line: "A little play makes practice easier to start." }
  };
  const fallback = { title: "Weekend Wildcard", modeIds: ["word", "gibberish"], lesson: 20, line: "Bridge the weird prompt to something familiar." };
  const plan = map[weekday] || fallback;
  return {
    ...plan,
    lesson: lessons[plan.lesson],
    exercises: plan.modeIds.map((id, index) => buildExercise(modes.find((mode) => mode.id === id), index))
  };
}

function promptFor(mode, seed) {
  const pool = {
    random: [...prompts.tableTopics, ...enabledPrompts()],
    table: prompts.tableTopics,
    story: prompts.story,
    yes: ["Yes, and our team just discovered a hidden advantage.", "Yes, and the simplest version is probably the strongest.", "Yes, and that changes the way I would explain it."],
    object: prompts.object,
    defend: prompts.defend,
    prep: [...prompts.tableTopics, ...prompts.work],
    what: [...prompts.work, ...prompts.tableTopics],
    gibberish: ["Explain the Flimble Stack.", "Define strategic noodle velocity.", "Explain why the wobble index matters.", "Translate the phrase reverse banana architecture."],
    bad: prompts.badIdea,
    character: prompts.tableTopics,
    word: prompts.words
  }[mode.id];
  const base = randomItem(pool, seed);
  if (mode.id === "character") return `${base} Answer as a ${randomItem(prompts.characters, seed + 3)}.`;
  if (mode.id === "defend") return `${base} First defend it. Then argue against it.`;
  if (mode.id === "word") return `${base}: connect this word to work, leadership, parenting, design, or life.`;
  return base;
}

function enabledPrompts() {
  return [
    ...(state.settings.work ? prompts.work : []),
    ...(state.settings.silly ? prompts.silly : []),
    ...(state.settings.life ? prompts.story : [])
  ];
}

function buildExercise(mode, index = 0) {
  const seed = Number(todayKey().replaceAll("-", "")) + index + mode.id.length;
  return { ...mode, prompt: promptFor(mode, seed) };
}

function startSession(source = "today", modeId = null) {
  const workout = todayWorkout();
  const exercises = source === "today"
    ? workout.exercises
    : [buildExercise(modes.find((mode) => mode.id === modeId))];
  const targetSeconds = state.settings.sessionLength * 60;
  const lesson = source === "today" ? workout.lesson : randomItem(lessons, Date.now());
  state.activeSession = { source, title: source === "today" ? workout.title : modes.find((mode) => mode.id === modeId).title, lesson, exercises, targetSeconds, startedAt: Date.now(), ratings: [], skipped: 0, recordings: [] };
  state.step = "lesson";
  state.exerciseIndex = 0;
  state.timerLeft = exercises[0].time;
  state.timerRunning = false;
  render();
}

function startTimer() {
  state.timerRunning = true;
  stopTimer();
  timerId = setInterval(() => {
    state.timerLeft = Math.max(0, state.timerLeft - 1);
    if (state.timerLeft === 0) stopTimer();
    render();
  }, 1000);
  render();
}

function stopTimer() {
  state.timerRunning = false;
  if (timerId) clearInterval(timerId);
  timerId = null;
}

async function toggleRecording() {
  const button = $("#recordButton");
  if (recorder?.state === "recording") {
    recorder.stop();
    button.textContent = "Record";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Audio recording is not available in this browser. The timer still works.");
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioChunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => audioChunks.push(event.data);
  recorder.onstop = () => {
    const url = URL.createObjectURL(new Blob(audioChunks, { type: "audio/webm" }));
    state.activeSession.recordings[state.exerciseIndex] = url;
    stream.getTracks().forEach((track) => track.stop());
    render();
  };
  recorder.start();
  button.textContent = "Stop";
}

function finishExercise(status = "done") {
  stopTimer();
  if (status === "skip") state.activeSession.skipped += 1;
  state.step = status === "retry" ? "exercise" : "rate";
  if (status === "retry") state.timerLeft = state.activeSession.exercises[state.exerciseIndex].time;
  render();
}

function saveRating() {
  state.activeSession.ratings.push({ ...state.ratingsDraft });
  state.ratingsDraft = { clarity: 3, confidence: 3, flow: 3, fun: 3 };
  if (state.exerciseIndex < state.activeSession.exercises.length - 1) {
    state.exerciseIndex += 1;
    state.timerLeft = state.activeSession.exercises[state.exerciseIndex].time;
    state.step = "exercise";
  } else {
    state.step = "reflection";
  }
  render();
}

function completeSession() {
  const session = state.activeSession;
  const date = todayKey();
  const minutes = Math.round((session.exercises.reduce((sum, item) => sum + item.time, 0) / 60) * 10) / 10;
  state.progress.completions.push({ date, title: session.title, source: session.source, minutes });
  state.progress.minutes = Math.round((state.progress.minutes + minutes) * 10) / 10;
  session.exercises.forEach((exercise) => {
    state.progress.modeCounts[exercise.id] = (state.progress.modeCounts[exercise.id] || 0) + 1;
  });
  state.progress.ratings.push(...session.ratings);
  const reflection = $("#reflectionText")?.value?.trim();
  if (reflection) state.progress.reflections.push({ date, text: reflection });
  state.step = "done";
  saveState();
  render();
}

function resetProgress() {
  if (!confirm("Clear all local progress and reflections?")) return;
  state.progress = structuredClone(defaultState.progress);
  saveState();
  render();
}

function setTab(tab) {
  stopTimer();
  state.tab = tab;
  state.step = "idle";
  state.activeSession = null;
  saveState();
  render();
}

function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

const ui = {
  button: "min-h-12 rounded-2xl px-4 font-extrabold transition active:translate-y-px",
  primary: "min-h-12 rounded-2xl bg-ink px-4 font-extrabold text-white shadow-[0_10px_24px_rgba(30,27,24,0.16)] transition active:translate-y-px",
  secondary: "min-h-12 rounded-2xl bg-white px-4 font-extrabold text-ink ring-1 ring-black/10 transition active:translate-y-px",
  ghost: "min-h-12 rounded-2xl bg-[#f6f1e8] px-4 font-extrabold text-ink transition active:translate-y-px",
  panel: "mt-4 rounded-3xl border border-black/5 bg-white p-5 shadow-[0_14px_34px_rgba(42,31,20,0.08)]",
  h1: "mb-3 text-[clamp(2.35rem,10vw,4.4rem)] font-black leading-[0.95] tracking-normal",
  sectionH1: "mb-2 text-[2.35rem] font-black leading-none tracking-normal",
  eyebrow: "mb-2 text-xs font-black uppercase tracking-[0.12em] text-cuffDark",
  muted: "text-muted leading-relaxed"
};

function appShell(content) {
  return `
    <main class="mx-auto min-h-screen w-full max-w-[680px] px-4 pb-28 pt-3 sm:px-5">
      <header class="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-3 bg-[#f8f5ef]/85 px-4 py-3 backdrop-blur-xl sm:-mx-5 sm:px-5">
        <button class="flex min-h-12 items-center gap-3 rounded-2xl bg-transparent p-0 text-left transition active:translate-y-px" data-action="tab" data-tab="today" aria-label="Go to today">
          <span class="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-lg font-black tracking-normal text-paper shadow-[0_10px_22px_rgba(30,27,24,0.18)]">OC</span>
          <span><strong class="block text-[1.05rem] leading-tight">Off the Cuff</strong><small class="block text-sm text-muted">${dayName()} practice</small></span>
        </button>
        <button class="${ui.button} flex items-center gap-2 bg-white text-ink ring-1 ring-black/10" data-action="panic"><i class="ri-flashlight-line text-xl"></i><span>Panic</span></button>
      </header>
      ${content}
      <nav class="fixed bottom-4 left-1/2 z-20 grid w-[min(calc(100%_-_24px),620px)] -translate-x-1/2 grid-cols-5 gap-1 rounded-[28px] border border-black/10 bg-white/[0.92] p-2 shadow-[0_20px_50px_rgba(30,27,24,0.18)] backdrop-blur-xl" aria-label="Main navigation">
        ${navButton("today", "Today", "ri-home-5-line", "ri-home-5-fill")}
        ${navButton("practice", "Practice", "ri-mic-line", "ri-mic-fill")}
        ${navButton("progress", "Progress", "ri-bar-chart-box-line", "ri-bar-chart-box-fill")}
        ${navButton("lessons", "Lessons", "ri-book-open-line", "ri-book-open-fill")}
        ${navButton("settings", "Settings", "ri-settings-3-line", "ri-settings-3-fill")}
      </nav>
      <dialog id="panicDialog" class="w-[min(92vw,430px)] rounded-3xl border-0 bg-white p-6 text-ink shadow-soft backdrop:bg-black/40">
        <form method="dialog">
          <div class="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-sunshine text-2xl"><i class="ri-flashlight-fill"></i></div>
          <h2 class="mb-2 text-3xl font-black">Pause. Breathe.</h2>
          <p class="${ui.muted}">Pick one line and keep moving.</p>
          <ol class="my-5 list-decimal pl-5 font-extrabold">
            <li class="my-3">My take is...</li>
            <li class="my-3">The reason is...</li>
            <li class="my-3">For example...</li>
            <li class="my-3">So the takeaway is...</li>
          </ol>
          <button class="${ui.primary} w-full">Back to it</button>
        </form>
      </dialog>
    </main>
  `;
}

function navButton(tab, label, icon, activeIcon) {
  const active = state.tab === tab;
  const classes = active ? "bg-ink text-white shadow-[0_10px_20px_rgba(30,27,24,0.18)]" : "bg-transparent text-muted";
  return `<button class="grid min-h-[58px] place-items-center rounded-3xl px-1 text-[0.68rem] font-extrabold ${classes}" data-action="tab" data-tab="${tab}" aria-label="${label}"><i class="${active ? activeIcon : icon} text-[1.35rem] leading-none"></i><span>${label}</span></button>`;
}

function todayView() {
  if (state.activeSession) return sessionView();
  const workout = todayWorkout();
  const stat = stats();
  const complete = state.progress.completions.some((item) => item.date === todayKey());
  return appShell(`
    <section class="relative grid min-h-[245px] grid-cols-[1fr_auto] items-end gap-4 overflow-hidden rounded-[32px] bg-ink p-6 text-white shadow-[0_22px_54px_rgba(30,27,24,0.22)] sm:min-h-[280px]">
      <div class="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-sunshine/90"></div>
      <div class="absolute -bottom-14 left-10 h-44 w-44 rounded-full bg-mint/70"></div>
      <div>
        <p class="mb-2 text-xs font-black uppercase tracking-[0.12em] text-sunshine">${stat.streak} day streak</p>
        <h1 class="${ui.h1}">${workout.title}</h1>
        <p class="relative max-w-[22rem] text-white/75 leading-relaxed">${workout.line}</p>
      </div>
      <div class="relative grid h-20 w-20 place-items-center rounded-3xl bg-white/95 text-4xl font-black text-ink shadow-inner">${state.settings.sessionLength}<span class="-mt-7 block text-xs font-black uppercase text-muted">min</span></div>
    </section>
    <section class="${ui.panel}">
      <div>
        <span class="text-sm text-muted">Today's principle</span>
        <strong class="my-1 block text-2xl">${workout.lesson.title}</strong>
        <p class="${ui.muted}">${workout.lesson.exercise}</p>
      </div>
      <div class="my-5 grid gap-3">
        ${workout.exercises.map((exercise, index) => `
          <div class="flex items-center gap-3 rounded-2xl bg-[#f8f5ef] p-3">
            <span class="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white font-black text-ink ring-1 ring-black/10">${index + 1}</span>
            <div><strong class="block">${exercise.title}</strong><small class="block text-sm text-muted">${Math.round(exercise.time / 60)} min</small></div>
          </div>
        `).join("")}
      </div>
      <button class="${ui.primary} w-full" data-action="start-today">${complete ? "Replay Today" : "Start Today's Workout"}</button>
      <p class="mt-3 text-sm text-muted">${complete ? "Already banked. A replay still counts as extra reps." : "Fits neatly into a work break."}</p>
    </section>
  `);
}

function sessionView() {
  const session = state.activeSession;
  if (state.step === "lesson") {
    return appShell(`
      <section class="${ui.panel} flex min-h-[calc(100vh-140px)] flex-col justify-center gap-3 bg-white">
        <p class="${ui.eyebrow}">Quick lesson</p>
        <h1 class="${ui.h1}">${session.lesson.title}</h1>
        <p class="${ui.muted}">${session.lesson.principle}</p>
        <div class="rounded-2xl bg-[#eaf8f5] p-4 font-bold text-[#123d34]">${session.lesson.exercise}</div>
        <button class="${ui.primary} w-full" data-action="begin-exercises">Start drills</button>
      </section>
    `);
  }
  if (state.step === "exercise") {
    const exercise = session.exercises[state.exerciseIndex];
    const audio = session.recordings[state.exerciseIndex] ? `<audio controls src="${session.recordings[state.exerciseIndex]}"></audio>` : "";
    return appShell(`
      <section class="${ui.panel} flex min-h-[calc(100vh-140px)] flex-col justify-center gap-3">
        <div class="flex justify-between gap-3 text-xs font-black uppercase tracking-[0.06em] text-muted"><span>${state.exerciseIndex + 1} of ${session.exercises.length}</span><span>${exercise.type}</span></div>
        <h1 class="mb-2 text-[clamp(1.9rem,8vw,3.4rem)] font-black leading-tight tracking-normal">${exercise.prompt}</h1>
        <p class="${ui.muted}">${exercise.description}</p>
        <div class="mx-auto my-3 grid aspect-square w-[min(72vw,300px)] place-items-center rounded-[42px] border-[10px] border-[#f8f5ef] ${state.timerLeft <= 10 ? "bg-[#ffd1c6] text-cuffDark" : "bg-mint text-ink"} text-[clamp(4.1rem,20vw,6.6rem)] font-black shadow-soft">${fmt(state.timerLeft)}</div>
        <div class="grid grid-cols-2 gap-3">
          <button class="${ui.secondary} flex items-center justify-center gap-2" data-action="${state.timerRunning ? "pause-timer" : "start-timer"}"><i class="${state.timerRunning ? "ri-pause-circle-line" : "ri-play-circle-line"} text-xl"></i>${state.timerRunning ? "Pause" : "Start timer"}</button>
          <button class="${ui.secondary} flex items-center justify-center gap-2" id="recordButton" data-action="record"><i class="ri-record-circle-line text-xl"></i>Record</button>
        </div>
        ${audio}
        <div class="grid grid-cols-3 gap-3">
          <button class="${ui.primary}" data-action="finish">I did it</button>
          <button class="${ui.ghost}" data-action="retry">Retry</button>
          <button class="${ui.ghost}" data-action="skip">Skip</button>
        </div>
      </section>
    `);
  }
  if (state.step === "rate") {
    return appShell(`
      <section class="${ui.panel} flex min-h-[calc(100vh-140px)] flex-col justify-center gap-3">
        <p class="${ui.eyebrow}">Self check</p>
        <h1 class="${ui.h1}">How did that rep feel?</h1>
        ${["clarity", "confidence", "flow", "fun"].map((key) => ratingControl(key)).join("")}
        <button class="${ui.primary} w-full" data-action="save-rating">Continue</button>
      </section>
    `);
  }
  if (state.step === "reflection") {
    return appShell(`
      <section class="${ui.panel} flex min-h-[calc(100vh-140px)] flex-col justify-center gap-3">
        <p class="${ui.eyebrow}">Reflection</p>
        <h1 class="${ui.h1}">${randomItem(reflectionQuestions, Date.now())}</h1>
        <textarea class="w-full resize-y rounded-2xl border border-black/10 bg-[#fffefa] p-4 outline-none focus:ring-2 focus:ring-sunshine" id="reflectionText" rows="5" placeholder="A sentence is enough."></textarea>
        <button class="${ui.primary} w-full" data-action="complete-session">Complete session</button>
      </section>
    `);
  }
  return appShell(`
    <section class="${ui.panel} flex min-h-[calc(100vh-140px)] flex-col justify-center gap-3 bg-white text-center">
      <div class="mx-auto mb-2 grid h-16 w-16 place-items-center rounded-3xl bg-mint text-3xl"><i class="ri-checkbox-circle-fill"></i></div>
      <p class="${ui.eyebrow}">Day complete</p>
      <h1 class="${ui.h1}">Rep banked.</h1>
      <p class="${ui.muted}">Your streak and speaking minutes are updated locally on this device.</p>
      <button class="${ui.primary} w-full" data-action="tab" data-tab="progress">See progress</button>
    </section>
  `);
}

function ratingControl(key) {
  return `
    <label class="grid gap-2 py-3">
      <span class="flex justify-between font-extrabold capitalize">${key[0].toUpperCase() + key.slice(1)} <strong>${state.ratingsDraft[key]}</strong></span>
      <input class="w-full accent-cuff" type="range" min="1" max="5" value="${state.ratingsDraft[key]}" data-action="rating" data-rating="${key}" />
    </label>
  `;
}

function practiceView() {
  if (state.activeSession) return sessionView();
  return appShell(`
    <section class="px-1 pb-1 pt-3">
      <h1 class="${ui.sectionH1}">Practice</h1>
      <p class="${ui.muted}">Pick a mode and get one focused rep.</p>
    </section>
    <section class="grid gap-3 sm:grid-cols-2">
      ${modes.map((mode) => `
        <article class="${ui.panel} grid grid-cols-[1fr_auto] items-center gap-3">
          <div><h2 class="mb-1 text-lg font-black">${mode.title}</h2><p class="${ui.muted}">${mode.description}</p></div>
          <button class="${ui.secondary} flex min-w-[82px] items-center justify-center gap-1" data-action="start-mode" data-mode="${mode.id}"><i class="ri-play-fill"></i>Start</button>
        </article>
      `).join("")}
    </section>
  `);
}

function progressView() {
  const stat = stats();
  const earned = badgeRules.filter((badge) => badge.test(stat)).map((badge) => badge.label);
  const favorite = modes.find((mode) => mode.id === stat.favoriteMode)?.title || "None yet";
  return appShell(`
    <section class="px-1 pb-1 pt-3">
      <h1 class="${ui.sectionH1}">Progress</h1>
      <p class="${ui.muted}">All progress is stored locally on this device.</p>
    </section>
    <section class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="min-h-28 rounded-3xl bg-ink p-4 text-white"><i class="ri-fire-fill text-sunshine"></i><strong class="mt-2 block text-3xl font-black leading-none">${stat.streak}</strong><span class="mt-2 block text-white/70">Streak</span></div>
      <div class="min-h-28 rounded-3xl bg-white p-4 text-ink ring-1 ring-black/5"><i class="ri-checkbox-circle-fill text-cuff"></i><strong class="mt-2 block text-3xl font-black leading-none">${stat.sessions}</strong><span class="mt-2 block text-muted">Sessions</span></div>
      <div class="min-h-28 rounded-3xl bg-white p-4 text-ink ring-1 ring-black/5"><i class="ri-time-fill text-[#1f8a62]"></i><strong class="mt-2 block text-3xl font-black leading-none">${stat.minutes}</strong><span class="mt-2 block text-muted">Minutes</span></div>
      <div class="min-h-28 rounded-3xl bg-white p-4 text-ink ring-1 ring-black/5"><i class="ri-star-smile-fill text-sunshine"></i><strong class="mt-2 block text-xl font-black leading-tight">${favorite}</strong><span class="mt-2 block text-muted">Favorite</span></div>
    </section>
    <section class="${ui.panel}">
      <h2 class="mb-3 text-lg font-black">Average ratings</h2>
      ${Object.entries(stat.ratings).map(([key, value]) => `<div class="my-3 grid grid-cols-[86px_1fr_36px] items-center gap-2 capitalize"><span>${key}</span><meter class="h-3 w-full" min="1" max="5" value="${value}"></meter><strong>${value}</strong></div>`).join("")}
    </section>
    <section class="${ui.panel}">
      <h2 class="mb-3 text-lg font-black">Badges</h2>
      <div class="flex flex-wrap gap-2">
        ${badgeRules.map((badge) => `<span class="rounded-full px-3 py-2 text-sm font-extrabold ${earned.includes(badge.label) ? "bg-sunshine text-ink" : "bg-[#f1ece4] text-muted"}"><i class="${earned.includes(badge.label) ? "ri-medal-fill" : "ri-medal-line"} mr-1"></i>${badge.label}</span>`).join("")}
      </div>
    </section>
    <section class="${ui.panel}">
      <h2 class="mb-3 text-lg font-black">Recent reflections</h2>
      ${state.progress.reflections.slice(-3).reverse().map((item) => `<p class="rounded-lg bg-[#fff8ea] p-3 text-muted"><strong class="block text-ink">${item.date}</strong>${item.text}</p>`).join("") || `<p class="${ui.muted}">Complete a session to save reflections.</p>`}
    </section>
  `);
}

function lessonsView() {
  return appShell(`
    <section class="px-1 pb-1 pt-3">
      <h1 class="${ui.sectionH1}">Lesson Bank</h1>
      <p class="${ui.muted}">Small principles for speaking without overthinking.</p>
    </section>
    <section class="grid gap-3">
      ${lessons.map((lesson, index) => `
        <details class="${ui.panel} p-0" ${index === 0 ? "open" : ""}>
          <summary class="flex cursor-pointer items-center gap-3 p-4 font-black"><span class="grid h-8 w-8 shrink-0 place-items-center rounded-2xl bg-sky">${index + 1}</span>${lesson.title}</summary>
          <p class="px-4 pb-3 text-muted">${lesson.principle}</p>
          <div class="px-4 pb-4 font-extrabold text-cuffDark">${lesson.exercise}</div>
        </details>
      `).join("")}
    </section>
  `);
}

function settingsView() {
  return appShell(`
    <section class="px-1 pb-1 pt-3">
      <h1 class="${ui.sectionH1}">Settings</h1>
      <p class="${ui.muted}">Shape the short daily workout.</p>
    </section>
    <section class="${ui.panel} grid gap-2">
      <label class="flex min-h-14 items-center justify-between gap-3 border-b border-black/5"><span>Session length</span><select class="rounded-2xl border border-black/10 bg-white p-2" data-action="setting" data-setting="sessionLength">${[5, 6, 7].map((n) => `<option value="${n}" ${state.settings.sessionLength === n ? "selected" : ""}>${n} minutes</option>`).join("")}</select></label>
      ${toggle("workweekOnly", "Workweek only")}
      ${toggle("sound", "Sound on")}
      ${toggle("silly", "Include silly prompts")}
      ${toggle("work", "Include work prompts")}
      ${toggle("life", "Include parenting/life prompts")}
      <button class="${ui.button} mt-3 bg-[#fff0eb] text-[#9a2414]" data-action="reset-progress">Reset local progress</button>
    </section>
  `);
}

function toggle(key, label) {
  return `<label class="flex min-h-14 items-center justify-between gap-3 border-b border-black/5"><span>${label}</span><input class="h-7 w-12 accent-[#1f8a62]" type="checkbox" data-action="setting" data-setting="${key}" ${state.settings[key] ? "checked" : ""} /></label>`;
}

function render() {
  const views = { today: todayView, practice: practiceView, progress: progressView, lessons: lessonsView, settings: settingsView };
  $("#app").innerHTML = views[state.tab]();
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "tab") setTab(target.dataset.tab);
  if (action === "panic") $("#panicDialog").showModal();
  if (action === "start-today") startSession("today");
  if (action === "start-mode") startSession("practice", target.dataset.mode);
  if (action === "begin-exercises") { state.step = "exercise"; state.timerLeft = state.activeSession.exercises[0].time; render(); }
  if (action === "start-timer") startTimer();
  if (action === "pause-timer") { stopTimer(); render(); }
  if (action === "record") toggleRecording();
  if (action === "finish") finishExercise("done");
  if (action === "retry") finishExercise("retry");
  if (action === "skip") finishExercise("skip");
  if (action === "save-rating") saveRating();
  if (action === "complete-session") completeSession();
  if (action === "reset-progress") resetProgress();
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.dataset.action === "rating") {
    state.ratingsDraft[target.dataset.rating] = Number(target.value);
    render();
  }
  if (target.dataset.action === "setting") {
    const key = target.dataset.setting;
    state.settings[key] = target.type === "checkbox" ? target.checked : Number(target.value);
    saveState();
  }
});

render();
