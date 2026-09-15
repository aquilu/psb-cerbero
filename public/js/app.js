(() => {
  'use strict';

  const HISTORY_MAX = 20;
  const AUTO_CLEAR_MS = 12000;
  const DUPLICATE_WINDOW_MS = 2000;
  const REQUEST_TIMEOUT_MS = 25000;
  const STATUS_POLL_MS = 60000;

  const svg = (body, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;

  const ICONS = {
    ok: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    stop: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    warn: svg('<path d="M12 5v9"/><circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none"/>'),
    unknown: svg('<path d="M9 9a3 3 0 1 1 4.2 2.75c-.75.33-1.2 1.07-1.2 1.9V15"/><circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none"/>'),
    soundOn: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>', ' stroke-width="2"'),
    soundOff: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 10l5 5M21 10l-5 5"/>', ' stroke-width="2"'),
  };

  const VIEWS = {
    LOADING: { kind: 'loading', title: 'Consultando…' },
    PRESTADO: { kind: 'ok', icon: 'ok', title: 'Puede salir', label: 'Puede salir' },
    PRESTADO_VENCIDO: { kind: 'warn', icon: 'warn', title: 'Puede salir', label: 'Puede salir (vencido)' },
    NO_PRESTADO: { kind: 'stop', icon: 'stop', title: 'No puede salir', label: 'No prestado' },
    EN_PROCESO: { kind: 'stop', icon: 'stop', title: 'No puede salir', label: 'En proceso' },
    NO_ENCONTRADO: { kind: 'stop', icon: 'unknown', title: 'Código no encontrado', label: 'No encontrado' },
    CODIGO_INVALIDO: { kind: 'stop', icon: 'unknown', title: 'Código inválido', label: 'Código inválido' },
    ERROR_ALMA: {
      kind: 'unknown',
      icon: 'warn',
      title: 'Verificación manual',
      label: 'Verificación manual',
      message: 'No fue posible consultar Alma. Verifique el préstamo manualmente.',
    },
    SIN_CONEXION: {
      kind: 'unknown',
      icon: 'warn',
      title: 'Sin conexión',
      label: 'Sin conexión',
      message: 'No hay conexión con el servidor. Verifique el préstamo manualmente.',
    },
  };

  const CONN_LABELS = { unknown: 'Conectando…', online: 'En línea', degraded: 'Alma con fallas', offline: 'Sin conexión' };

  const $ = (id) => document.getElementById(id);
  const els = {
    conn: $('conn'), connLabel: $('connLabel'), clock: $('clock'), muteBtn: $('muteBtn'),
    form: $('scanForm'), input: $('barcode'),
    result: $('result'), idle: $('idle'), verdict: $('verdict'),
    vIcon: $('vIcon'), vTitle: $('vTitle'), vMessage: $('vMessage'), vBody: $('vBody'),
    patron: $('patron'), pName: $('pName'), pId: $('pId'), pDue: $('pDue'),
    book: $('book'), cover: $('cover'), bTitle: $('bTitle'), bAuthor: $('bAuthor'), bFacts: $('bFacts'),
    vCode: $('vCode'), vTime: $('vTime'), newScan: $('newScan'),
    autoclear: $('autoclear'), autoclearBar: $('autoclearBar'),
    historyList: $('historyList'), historyEmpty: $('historyEmpty'), clearHistory: $('clearHistory'),
    version: $('version'),
    pinDialog: $('pinDialog'), pinForm: $('pinForm'), pin: $('pin'), pinError: $('pinError'), pinSubmit: $('pinSubmit'),
  };

  const storage = {
    get(key) {
      try { return window.localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value); } catch { /* sin almacenamiento */ }
    },
  };

  const state = {
    muted: storage.get('cerbero.muted') === '1',
    history: [],
    seq: 0,
    coverSeq: 0,
    lastCode: '',
    lastAt: 0,
    pendingCode: null,
    clearTimer: null,
    audio: null,
  };

  const timeFormat = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const clockFormat = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function formatTime(iso) {
    const date = iso ? new Date(iso) : null;
    return date && !Number.isNaN(date.getTime()) ? timeFormat.format(date) : '';
  }

  function timeoutSignal(ms) {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  }

  function focusInput() {
    if (!els.pinDialog.open) els.input.focus({ preventScroll: true });
  }

  function setConn(value) {
    els.conn.dataset.state = value;
    els.connLabel.textContent = CONN_LABELS[value];
  }

  // ---------- Consulta ----------

  function onSubmit(event) {
    event.preventDefault();
    const code = els.input.value.trim();
    els.input.value = '';
    if (!code) return focusInput();

    // Evita la doble lectura accidental del mismo código
    const now = Date.now();
    if (code === state.lastCode && now - state.lastAt < DUPLICATE_WINDOW_MS) return focusInput();
    state.lastCode = code;
    state.lastAt = now;
    check(code);
  }

  async function check(code) {
    const seq = ++state.seq;
    showLoading(code);

    let response;
    let data = null;
    try {
      response = await fetch(`api/items/${encodeURIComponent(code)}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: timeoutSignal(REQUEST_TIMEOUT_MS),
      });
      data = await response.json().catch(() => null);
    } catch {
      setConn('offline');
      return show({ verdict: 'SIN_CONEXION', barcode: code, checkedAt: new Date().toISOString() }, seq);
    }

    if (response.status === 401 && data && data.accessRequired) {
      state.pendingCode = code;
      if (seq === state.seq) resetToIdle();
      return openPin();
    }

    if (!data || !data.verdict) {
      setConn('online');
      return show(
        { verdict: 'ERROR_ALMA', barcode: code, message: data && data.error, checkedAt: new Date().toISOString() },
        seq,
      );
    }

    setConn(data.verdict === 'ERROR_ALMA' ? 'degraded' : 'online');
    show(data, seq);
  }

  function show(data, seq) {
    addHistory(data);
    // Si mientras tanto se escaneó otro libro, solo se muestra el más reciente
    if (seq !== state.seq) return;
    render(data);
    playSound((VIEWS[data.verdict] || VIEWS.ERROR_ALMA).kind);
  }

  // ---------- Pantalla ----------

  function showLoading(code) {
    stopAutoClear();
    els.result.classList.remove('alert');
    els.result.dataset.kind = 'loading';
    els.idle.hidden = true;
    els.verdict.hidden = false;
    els.vIcon.replaceChildren(el('span', 'spinner'));
    els.vTitle.textContent = VIEWS.LOADING.title;
    els.vMessage.textContent = 'Verificando el préstamo en Alma';
    els.vBody.hidden = true;
    els.vCode.textContent = code;
    els.vTime.textContent = '';
  }

  function render(data) {
    const view = VIEWS[data.verdict] || VIEWS.ERROR_ALMA;
    stopAutoClear();
    els.result.dataset.kind = view.kind;
    els.idle.hidden = true;
    els.verdict.hidden = false;
    els.vIcon.innerHTML = ICONS[view.icon];
    els.vTitle.textContent = view.title;
    els.vMessage.textContent = data.message || view.message || '';
    els.vCode.textContent = data.barcode || '—';
    els.vTime.textContent = formatTime(data.checkedAt);

    const { loan, item } = data;

    els.patron.hidden = !loan;
    if (loan) {
      els.pName.textContent = loan.userName || 'Nombre no disponible: compare la identificación';
      els.pName.classList.toggle('is-missing', !loan.userName);
      els.pId.textContent = loan.userId || '—';
      renderDue(loan.dueDate);
    }

    els.book.hidden = !item;
    if (item) {
      els.bTitle.textContent = item.title || 'Sin título';
      els.bAuthor.textContent = item.author || '';
      els.bAuthor.hidden = !item.author;
      els.bFacts.replaceChildren(...facts(item, loan));
      loadCover(item.isbn);
    }

    els.vBody.hidden = !loan && !item;
    els.vBody.classList.toggle('single', !loan || !item);

    if (view.kind === 'stop') {
      els.result.classList.remove('alert');
      void els.result.offsetWidth; // reinicia la animación
      els.result.classList.add('alert');
    } else {
      els.result.classList.remove('alert');
    }

    if (view.kind === 'ok' || view.kind === 'warn') startAutoClear();
    focusInput();
  }

  function renderDue(due) {
    els.pDue.replaceChildren();
    if (!due) {
      els.pDue.textContent = 'Sin fecha de vencimiento';
      return;
    }
    els.pDue.append(el('strong', null, due.text));
    if (due.overdue) {
      const days = due.daysOverdue;
      const suffix = days > 0 ? ` · vencido hace ${days} ${days === 1 ? 'día' : 'días'}` : ' · vencido';
      els.pDue.append(el('span', 'overdue', suffix));
    }
  }

  function facts(item, loan) {
    const rows = [
      ['Signatura', item.callNumber, 'mono'],
      ['Ejemplar', item.description],
      ['Biblioteca', item.library],
      ['Ubicación', item.location],
      ['Edición', [item.publisher, item.year].filter(Boolean).join(', ')],
      ['Estado en Alma', item.process ? item.process.desc : item.status],
      ['Mostrador', loan && loan.circDesk],
    ];
    return rows
      .filter(([, value]) => value)
      .flatMap(([label, value, className]) => [el('dt', null, label), el('dd', className, value)]);
  }

  function loadCover(isbn) {
    const seq = ++state.coverSeq;
    els.cover.hidden = true;
    els.cover.removeAttribute('src');
    if (!isbn) return;

    const sources = [
      `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-M.jpg?default=false`,
      `https://books.google.com/books/content?vid=ISBN${encodeURIComponent(isbn)}&printsec=frontcover&img=1&zoom=1`,
    ];
    const attempt = (index) => {
      if (index >= sources.length || seq !== state.coverSeq) return;
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        if (seq !== state.coverSeq) return;
        if (img.naturalWidth > 40) {
          els.cover.src = img.src;
          els.cover.hidden = false;
        } else {
          attempt(index + 1);
        }
      };
      img.onerror = () => attempt(index + 1);
      img.src = sources[index];
    };
    attempt(0);
  }

  function startAutoClear() {
    const bar = els.autoclearBar;
    els.autoclear.hidden = false;
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    void bar.offsetWidth;
    bar.style.transition = `transform ${AUTO_CLEAR_MS}ms linear`;
    bar.style.transform = 'scaleX(0)';
    state.clearTimer = setTimeout(resetToIdle, AUTO_CLEAR_MS);
  }

  function stopAutoClear() {
    clearTimeout(state.clearTimer);
    state.clearTimer = null;
    els.autoclear.hidden = true;
  }

  function resetToIdle() {
    stopAutoClear();
    state.coverSeq++;
    els.result.classList.remove('alert');
    els.result.dataset.kind = 'idle';
    els.verdict.hidden = true;
    els.idle.hidden = false;
    focusInput();
  }

  // ---------- Historial ----------

  function addHistory(data) {
    state.history.unshift(data);
    if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
    renderHistory();
  }

  function renderHistory() {
    const items = state.history.map((data) => {
      const view = VIEWS[data.verdict] || VIEWS.ERROR_ALMA;
      const li = el('li');
      li.dataset.kind = view.kind;
      const button = el('button');
      button.type = 'button';
      button.append(
        el('span', 'h-dot'),
        el('span', 'h-title', (data.item && data.item.title) || data.barcode),
        el('time', 'h-time', formatTime(data.checkedAt)),
        el('span', 'h-sub', [view.label, data.loan && data.loan.userId, data.barcode].filter(Boolean).join(' · ')),
      );
      button.addEventListener('click', () => {
        state.seq++;
        render(data);
      });
      li.append(button);
      return li;
    });
    els.historyList.replaceChildren(...items);
    els.historyEmpty.hidden = items.length > 0;
    els.clearHistory.hidden = items.length === 0;
  }

  // ---------- Sonido ----------

  const SOUND_PATTERNS = {
    ok: [[880, 0, 0.12], [1318.5, 0.13, 0.2]],
    warn: [[740, 0, 0.15], [740, 0.22, 0.15]],
    stop: [[196, 0, 0.22, 'square'], [196, 0.3, 0.22, 'square'], [196, 0.6, 0.4, 'square']],
    unknown: [[523, 0, 0.18, 'triangle'], [392, 0.22, 0.3, 'triangle']],
  };

  function playSound(kind) {
    const pattern = SOUND_PATTERNS[kind];
    if (state.muted || !pattern) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      state.audio = state.audio || new AudioCtx();
      if (state.audio.state === 'suspended') state.audio.resume();
      const ctx = state.audio;
      const t0 = ctx.currentTime + 0.02;
      for (const [freq, start, duration, type = 'sine'] of pattern) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + start);
        gain.gain.exponentialRampToValueAtTime(type === 'square' ? 0.12 : 0.3, t0 + start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + start);
        osc.stop(t0 + start + duration + 0.02);
      }
    } catch {
      // sin audio disponible
    }
  }

  function renderMute() {
    const label = state.muted ? 'Activar sonidos' : 'Silenciar sonidos';
    els.muteBtn.innerHTML = state.muted ? ICONS.soundOff : ICONS.soundOn;
    els.muteBtn.setAttribute('aria-pressed', String(state.muted));
    els.muteBtn.setAttribute('aria-label', label);
    els.muteBtn.title = label;
  }

  // ---------- Acceso por PIN ----------

  function openPin() {
    if (els.pinDialog.open) return;
    els.pinError.hidden = true;
    els.pin.value = '';
    els.pinDialog.showModal();
    els.pin.focus();
  }

  async function onPinSubmit(event) {
    event.preventDefault();
    const pin = els.pin.value.trim();
    if (!pin) return;
    els.pinSubmit.disabled = true;
    try {
      const response = await fetch('api/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pin }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        els.pinError.textContent = data.error || 'No fue posible validar el PIN.';
        els.pinError.hidden = false;
        els.pin.select();
        return;
      }
      els.pinDialog.close();
      const pending = state.pendingCode;
      state.pendingCode = null;
      if (pending) check(pending);
      else focusInput();
    } catch {
      els.pinError.textContent = 'Sin conexión con el servidor.';
      els.pinError.hidden = false;
    } finally {
      els.pinSubmit.disabled = false;
    }
  }

  // ---------- Estado del servidor ----------

  async function refreshStatus() {
    try {
      const response = await fetch('api/status', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: timeoutSignal(10000),
      });
      const data = await response.json();
      els.version.textContent = `v${data.version}`;
      if (els.conn.dataset.state !== 'degraded') setConn('online');
      if (data.accessRequired && !data.authorized) openPin();
    } catch {
      setConn('offline');
    }
  }

  function tickClock() {
    const now = new Date();
    els.clock.textContent = clockFormat.format(now);
    els.clock.dateTime = now.toISOString();
  }

  // ---------- Eventos ----------

  els.form.addEventListener('submit', onSubmit);
  els.newScan.addEventListener('click', resetToIdle);
  els.clearHistory.addEventListener('click', () => {
    state.history = [];
    renderHistory();
    focusInput();
  });
  els.muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    storage.set('cerbero.muted', state.muted ? '1' : '0');
    renderMute();
    if (!state.muted) playSound('ok');
    focusInput();
  });
  els.pinForm.addEventListener('submit', onPinSubmit);
  els.pinDialog.addEventListener('cancel', (event) => event.preventDefault());
  els.pinDialog.addEventListener('close', focusInput);

  // El campo del lector mantiene el foco: el lector de código de barras "teclea" en él
  document.addEventListener('keydown', (event) => {
    if (els.pinDialog.open) return;
    if (event.key === 'Escape') {
      resetToIdle();
      return;
    }
    const printable = event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (printable && document.activeElement !== els.input) focusInput();
  });
  document.addEventListener('pointerup', (event) => {
    if (!event.target.closest('button, a, input, dialog')) focusInput();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) focusInput();
  });
  setInterval(() => {
    if (document.activeElement === document.body) focusInput();
  }, 1000);

  renderMute();
  renderHistory();
  tickClock();
  setInterval(tickClock, 15000);
  refreshStatus();
  setInterval(refreshStatus, STATUS_POLL_MS);
  focusInput();
})();
