/**
 * =========================================================================
 * PRESENSI DIGITAL PANITIA KIP 2026 - CONTROLLER & CLIENT LOGIC
 * =========================================================================
 * Bekerja fleksibel di 3 lingkungan:
 * 1. Di Subdomain (presenkip26.sikancuyy.my.id / Vercel / VPS): Terhubung live ke Google Sheets
 * 2. Di Google Apps Script Web App: Terhubung via google.script.run
 * 3. Di browser lokal (Laragon / file://): Mode simulasi interaktif dari ANGGOTA KIP 2026 (1).xlsx
 * =========================================================================
 */

// State Management
let isGasEnvironment = (typeof google !== 'undefined' && google.script && google.script.run);
let currentPanitiaData = null;
let currentAdminPin = sessionStorage.getItem('kip_admin_pin') || null;
let dashboardCache = null;
let qrcodeInstance = null;

const PERMANENT_GAS_URL = "https://script.google.com/macros/s/AKfycbwVAw5bmI1WgjQYQAyU93onjSi2TwvUfPPd5J28Dvp1zzA5w-cWWR7eumr40NcIE-MX/exec";

function getGasApiUrl() {
  const customUrl = localStorage.getItem('kip_gas_url');
  if (customUrl && customUrl.trim()) {
    return customUrl.trim();
  }
  if (window.APP_CONFIG && window.APP_CONFIG.GAS_API_URL) {
    return window.APP_CONFIG.GAS_API_URL.trim();
  }
  return PERMANENT_GAS_URL;
}

// Initial Local Storage Data for Simulation (if empty)
function initLocalStorageDatabase() {
  if (!localStorage.getItem('kip_active_agenda')) {
    const initialAgenda = {
      id: "KIP-20261110-001",
      title: "Rapat Koordinasi Kasie",
      date: "10 November 2026",
      time: "14:00 WIB",
      location: "Ruang Rapat Panitia / Gedung PKM",
      hasSessionCode: false,
      sessionCode: "",
      status: "AKTIF",
      createdAt: new Date().toISOString()
    };
    localStorage.setItem('kip_active_agenda', JSON.stringify(initialAgenda));
  }

  if (!localStorage.getItem('kip_raw_presensi')) {
    localStorage.setItem('kip_raw_presensi', JSON.stringify([]));
  }

  if (!localStorage.getItem('kip_admin_pin')) {
    localStorage.setItem('kip_admin_pin', 'KIP2026');
  }
}

// Lifecycle Initialization
document.addEventListener('DOMContentLoaded', () => {
  initLocalStorageDatabase();

  // Update Status Badge (GSheet Connected vs Local)
  updateConnectionBadge();

  // Load Active Agenda Banner
  fetchActiveAgenda();

  // Check URL query parameters (e.g. ?nim=2024203020008 or ?page=admin)
  handleUrlParameters();

  // Set default dates on modals
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const hh = String(today.getHours()).padStart(2, '0');
  const min = String(today.getMinutes()).padStart(2, '0');

  const dateInput = document.getElementById('agendaInputDate');
  const timeInput = document.getElementById('agendaInputTime');
  if (dateInput) dateInput.value = `${yyyy}-${mm}-${dd}`;
  if (timeInput) timeInput.value = `${hh}:${min}`;

  // Restore Admin Session if logged in
  if (currentAdminPin) {
    const gate = document.getElementById('adminLoginGate');
    const panel = document.getElementById('adminPanel');
    if (gate) gate.classList.add('hidden');
    if (panel) panel.classList.remove('hidden');
    if (panel) refreshDashboard();
  }
});

function updateConnectionBadge() {
  const badge = document.getElementById('envBadge');
  if (!badge) return;

  const gasUrl = getGasApiUrl();
  if (gasUrl) {
    badge.className = "text-[10px] font-semibold uppercase tracking-wider bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full flex items-center gap-1";
    badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> GSheet Live`;
  } else {
    badge.className = "text-[10px] font-semibold uppercase tracking-wider bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full";
    badge.textContent = "Data 46 Panitia Ready";
  }
}

function handleUrlParameters() {
  const params = new URLSearchParams(window.location.search);
  const nimParam = params.get('nim');
  const pageParam = params.get('page');
  const hash = window.location.hash;
  const isIndexPage = !document.getElementById('adminPanel') && !document.getElementById('adminLoginGate');
  const isAdminPage = !document.getElementById('viewPresensi');

  if (isIndexPage && (pageParam === 'admin' || hash === '#admin')) {
    window.location.href = 'admin.html';
    return;
  }

  if (isAdminPage && (pageParam === 'presensi' || hash === '#presensi')) {
    window.location.href = 'index.html';
    return;
  }

  if (hash === '#formSection') {
    const formElem = document.getElementById('formSection');
    if (formElem) {
      setTimeout(() => formElem.scrollIntoView({ behavior: 'smooth' }), 200);
    }
  }

  if (nimParam) {
    const input = document.getElementById('inputNim');
    if (input) {
      input.value = nimParam;
      setTimeout(() => searchNIM(), 300);
    }
  }
}

window.addEventListener('hashchange', handleUrlParameters);

/**
 * Audio Chime Synthesizer (Web Audio API - No external file needed)
 */
function playChime(isSuccess) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();

    if (isSuccess) {
      // Pleasant two-tone chime (C5 -> G5)
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(523.25, now); // C5
      osc1.frequency.setValueAtTime(783.99, now + 0.12); // G5

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

      osc1.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc1.stop(now + 0.45);
    }
  } catch (e) {
    // Ignore audio failures if browser blocks autoplay
  }
}

/**
 * Mengambil Agenda Rapat yang sedang aktif
 */
function fetchActiveAgenda() {
  if (isGasEnvironment) {
    google.script.run
      .withSuccessHandler(handleActiveAgendaResponse)
      .withFailureHandler((err) => {
        showToast('error', 'Gagal Memuat Agenda', err.message);
        renderNoAgendaState();
      })
      .getActiveAgenda();
    return;
  }

  const gasUrl = getGasApiUrl();
  if (gasUrl) {
    fetch(`${gasUrl}?action=getActiveAgenda`)
      .then(res => res.json())
      .then(res => {
        handleActiveAgendaResponse(res);
      })
      .catch(err => {
        console.warn("GAS fetch error, fallback local:", err);
        fallbackLocalActiveAgenda();
      });
    return;
  }

  fallbackLocalActiveAgenda();
}

function fallbackLocalActiveAgenda() {
  const raw = localStorage.getItem('kip_active_agenda');
  if (raw) {
    const agenda = JSON.parse(raw);
    if (agenda && agenda.status === 'AKTIF') {
      handleActiveAgendaResponse({ success: true, agenda: agenda });
      return;
    }
  }
  renderNoAgendaState();
}

function handleActiveAgendaResponse(res) {
  if (res && res.success && res.agenda) {
    window.activeAgendaState = res.agenda;
    const bannerId = document.getElementById('bannerAgendaId');
    const bannerTitle = document.getElementById('bannerAgendaTitle');
    const bannerDate = document.getElementById('bannerAgendaDate');
    const bannerTime = document.getElementById('bannerAgendaTime');
    const bannerLoc = document.getElementById('bannerAgendaLocation');

    if (bannerId) bannerId.textContent = window.activeAgendaState.id;
    if (bannerTitle) bannerTitle.textContent = window.activeAgendaState.title;
    if (bannerDate) bannerDate.textContent = window.activeAgendaState.date;
    if (bannerTime) bannerTime.textContent = window.activeAgendaState.time;
    if (bannerLoc) bannerLoc.textContent = window.activeAgendaState.location;

    const sessionField = document.getElementById('sessionCodeField');
    if (sessionField) {
      if (window.activeAgendaState.hasSessionCode) {
        sessionField.classList.remove('hidden');
      } else {
        sessionField.classList.add('hidden');
      }
    }
  } else {
    renderNoAgendaState();
  }
}

function renderNoAgendaState() {
  window.activeAgendaState = null;
  const bannerId = document.getElementById('bannerAgendaId');
  const bannerTitle = document.getElementById('bannerAgendaTitle');
  const bannerDate = document.getElementById('bannerAgendaDate');
  const bannerTime = document.getElementById('bannerAgendaTime');
  const bannerLoc = document.getElementById('bannerAgendaLocation');

  if (bannerId) bannerId.textContent = 'OFFLINE';
  if (bannerTitle) bannerTitle.textContent = 'Tidak Ada Agenda Aktif';
  if (bannerDate) bannerDate.textContent = 'Belum ada rapat dibuka';
  if (bannerTime) bannerTime.textContent = 'Menunggu Sekretaris / Admin';
  if (bannerLoc) bannerLoc.textContent = 'Silakan hubungi pimpinan rapat';
}

/**
 * =========================================================================
 * FITUR ANGGOTA: PENCARIAN NIM & SUBMIT PRESENSI
 * =========================================================================
 */
function quickFillNIM(nim) {
  document.getElementById('inputNim').value = nim;
  searchNIM();
}

function searchNIM() {
  const input = document.getElementById('inputNim');
  const rawNim = input.value.trim();
  const cleanNim = rawNim.replace(/\D/g, '');

  if (!cleanNim) {
    showToast('warning', 'NIM Kosong', 'Silakan masukkan NIM Anda terlebih dahulu.');
    input.focus();
    return;
  }

  if (!window.activeAgendaState) {
    showToast('error', 'Agenda Belum Aktif', 'Saat ini belum ada agenda rapat yang dibuka untuk presensi.');
    return;
  }

  const btnText = document.getElementById('btnCariText');
  const btnSpinner = document.getElementById('btnCariSpinner');
  const btn = document.getElementById('btnCariNIM');
  btnText.textContent = 'MENCARI...';
  btnSpinner.classList.remove('hidden');
  btn.disabled = true;

  hideAlert();

  if (isGasEnvironment) {
    google.script.run
      .withSuccessHandler((res) => {
        btnText.textContent = 'CARI DATA';
        btnSpinner.classList.add('hidden');
        btn.disabled = false;

        if (res.success && res.data) {
          renderPanitiaBiodata(res.data);
          showToast('success', 'Biodata Ditemukan', `Halo, ${res.data.nama}`);
        } else {
          document.getElementById('biodataContainer').classList.add('hidden');
          showAlert('error', res.message || 'NIM tidak ditemukan dalam database Panitia KIP 2026.');
        }
      })
      .withFailureHandler((err) => {
        btnText.textContent = 'CARI DATA';
        btnSpinner.classList.add('hidden');
        btn.disabled = false;
        showAlert('error', 'Terjadi kesalahan sistem: ' + err.message);
      })
      .searchPanitiaByNIM(cleanNim);
    return;
  }

  const gasUrl = getGasApiUrl();
  if (gasUrl) {
    fetch(`${gasUrl}?action=searchNIM&nim=${encodeURIComponent(cleanNim)}`)
      .then(res => res.json())
      .then(res => {
        btnText.textContent = 'CARI DATA';
        btnSpinner.classList.add('hidden');
        btn.disabled = false;

        if (res.success && res.data) {
          renderPanitiaBiodata(res.data);
          showToast('success', 'Biodata Ditemukan', `Halo, ${res.data.nama}`);
        } else {
          document.getElementById('biodataContainer').classList.add('hidden');
          showAlert('error', res.message || 'NIM tidak terdaftar di Google Sheet.');
        }
      })
      .catch(err => {
        console.warn("GAS fetch error, falling back to local master:", err);
        fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn);
      });
    return;
  }

  fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn);
}

function fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn) {
  setTimeout(() => {
    btnText.textContent = 'CARI DATA';
    btnSpinner.classList.add('hidden');
    btn.disabled = false;

    const masterList = window.MASTER_PANITIA || [];
    const found = masterList.find(item => {
      if (!item.nim || !item.nama) return false;
      const itemNim = String(item.nim).replace(/\D/g, '');
      return itemNim === cleanNim;
    });

    if (found) {
      renderPanitiaBiodata({
        no: found.no,
        nama: found.nama,
        nim: String(found.nim).replace(/\D/g, ''),
        jabatan: found.jabatan || '-',
        sie: found.sie || '-',
        noHp: found.no_hp || '-',
        delegasi: found.delegasi || '-'
      });
      showToast('success', 'Biodata Ditemukan', `Halo, ${found.nama}`);
    } else {
      document.getElementById('biodataContainer').classList.add('hidden');
      showAlert('error', `NIM (${cleanNim}) tidak ditemukan dalam database Panitia KIP 2026. Pastikan nomor yang dimasukkan benar.`);
    }
  }, 200);
}

function renderPanitiaBiodata(panitia) {
  currentPanitiaData = panitia;

  // Inisial Avatar
  const names = panitia.nama.split(' ').filter(Boolean);
  let initials = names[0] ? names[0][0] : 'K';
  if (names.length > 1) initials += names[names.length - 1][0];
  document.getElementById('avatarInitials').textContent = initials.toUpperCase();

  document.getElementById('bioNama').textContent = panitia.nama;
  document.getElementById('bioNim').textContent = panitia.nim;
  document.getElementById('bioJabatan').textContent = panitia.jabatan || '-';
  document.getElementById('bioSie').textContent = panitia.sie || '-';
  document.getElementById('bioDelegasi').textContent = panitia.delegasi || '-';

  const sessionField = document.getElementById('sessionCodeField');
  if (window.activeAgendaState && window.activeAgendaState.hasSessionCode) {
    sessionField.classList.remove('hidden');
  } else {
    sessionField.classList.add('hidden');
  }

  document.getElementById('biodataContainer').classList.remove('hidden');
}

/**
 * Submit Kehadiran Anggota ke Server / Local Storage
 */
function submitKehadiran() {
  if (!currentPanitiaData) {
    showToast('warning', 'Peringatan', 'Silakan cari NIM Anda terlebih dahulu.');
    return;
  }

  if (!window.activeAgendaState) {
    showToast('error', 'Gagal', 'Agenda rapat tidak aktif.');
    return;
  }

  let sessionCode = '';
  if (window.activeAgendaState.hasSessionCode) {
    const codeInput = document.getElementById('inputSessionCode');
    sessionCode = codeInput ? codeInput.value.trim() : '';
    if (!sessionCode) {
      showToast('warning', 'Kode Sesi Diperlukan', 'Masukkan kode sesi rapat yang diberikan panitia di ruangan.');
      if (codeInput) codeInput.focus();
      return;
    }
  }

  const btn = document.getElementById('btnHadir');
  const btnText = document.getElementById('btnHadirText');
  const btnSpinner = document.getElementById('btnHadirSpinner');
  btnText.textContent = 'MEMPROSES...';
  btnSpinner.classList.remove('hidden');
  btn.disabled = true;

  const payload = {
    nim: currentPanitiaData.nim,
    agendaId: window.activeAgendaState.id,
    sessionCode: sessionCode,
    deviceInfo: navigator.userAgent.substring(0, 100)
  };

  if (isGasEnvironment) {
    google.script.run
      .withSuccessHandler((res) => {
        btnText.textContent = 'KONFIRMASI HADIR';
        btnSpinner.classList.add('hidden');
        btn.disabled = false;

        if (res.success) {
          playChime(true);
          showReceiptModal(res.data);
          resetPresensiForm();
        } else {
          if (res.duplicate) {
            showAlert('warning', res.message);
            showToast('warning', 'Sudah Presensi', res.message);
          } else {
            showAlert('error', res.message);
            showToast('error', 'Presensi Gagal', res.message);
          }
        }
      })
      .withFailureHandler((err) => {
        btnText.textContent = 'KONFIRMASI HADIR';
        btnSpinner.classList.add('hidden');
        btn.disabled = false;
        showAlert('error', 'Gagal memproses presensi: ' + err.message);
      })
      .submitPresensi(payload);
    return;
  }

  const gasUrl = getGasApiUrl();
  if (gasUrl) {
    // Kirim menggunakan simple text/plain untuk bypass CORS preflight di GAS
    fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'submitPresensi', payload: payload })
    })
    .then(res => res.json())
    .then(res => {
      btnText.textContent = 'KONFIRMASI HADIR';
      btnSpinner.classList.add('hidden');
      btn.disabled = false;

      if (res.success) {
        playChime(true);
        showReceiptModal(res.data);
        resetPresensiForm();
      } else {
        if (res.duplicate) {
          showAlert('warning', res.message);
          showToast('warning', 'Sudah Presensi', res.message);
        } else {
          showAlert('error', res.message);
          showToast('error', 'Presensi Gagal', res.message);
        }
      }
    })
    .catch(err => {
      console.warn("GAS POST error, falling back to local:", err);
      fallbackLocalSubmit(payload, btnText, btnSpinner, btn);
    });
    return;
  }

  fallbackLocalSubmit(payload, btnText, btnSpinner, btn);
}

function fallbackLocalSubmit(payload, btnText, btnSpinner, btn) {
  setTimeout(() => {
    btnText.textContent = 'KONFIRMASI HADIR';
    btnSpinner.classList.add('hidden');
    btn.disabled = false;

    // Check Session Code if required
    if (window.activeAgendaState.sessionCode && window.activeAgendaState.sessionCode !== '') {
      if (payload.sessionCode.toUpperCase() !== window.activeAgendaState.sessionCode.toUpperCase()) {
        showAlert('error', 'Kode sesi rapat salah! Silakan minta kode verifikasi kepada sekretaris di ruangan.');
        showToast('error', 'Kode Salah', 'Kode sesi rapat tidak sesuai.');
        return;
      }
    }

    // Check Anti-Duplication (NIM + AgendaId)
    const rawRecords = JSON.parse(localStorage.getItem('kip_raw_presensi') || '[]');
    const alreadySubmitted = rawRecords.find(r => r.agendaId === payload.agendaId && r.nim === payload.nim);

    if (alreadySubmitted) {
      const msg = `Anda (${currentPanitiaData.nama}) SUDAH melakukan presensi untuk agenda '${window.activeAgendaState.title}' pada pukul ${alreadySubmitted.waktu} WIB.`;
      showAlert('warning', msg);
      showToast('warning', 'Duplikasi Terdeteksi', msg);
      return;
    }

    // Record transaction
    const now = new Date();
    const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
    const dateStr = now.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) + `, ${timeStr} WIB`;

    const newRecord = {
      timestamp: now.toISOString(),
      agendaId: window.activeAgendaState.id,
      agendaTitle: window.activeAgendaState.title,
      nim: currentPanitiaData.nim,
      nama: currentPanitiaData.nama,
      jabatan: currentPanitiaData.jabatan,
      sie: currentPanitiaData.sie,
      delegasi: currentPanitiaData.delegasi,
      status: 'HADIR',
      waktu: timeStr,
      device: navigator.userAgent.substring(0, 50)
    };

    rawRecords.push(newRecord);
    localStorage.setItem('kip_raw_presensi', JSON.stringify(rawRecords));

    playChime(true);

    showReceiptModal({
      nama: currentPanitiaData.nama,
      nim: currentPanitiaData.nim,
      sie: currentPanitiaData.sie,
      agendaTitle: window.activeAgendaState.title,
      waktuPresensi: dateStr
    });

    showToast('success', 'Presensi Berhasil', 'Kehadiran Anda telah dicatat ke database.');
    resetPresensiForm();
  }, 250);
}

function resetPresensiForm() {
  document.getElementById('inputNim').value = '';
  const codeInput = document.getElementById('inputSessionCode');
  if (codeInput) codeInput.value = '';
  document.getElementById('biodataContainer').classList.add('hidden');
  currentPanitiaData = null;
  hideAlert();
}

function showReceiptModal(data) {
  document.getElementById('receiptNama').textContent = data.nama;
  document.getElementById('receiptNim').textContent = data.nim;
  document.getElementById('receiptSie').textContent = data.sie;
  document.getElementById('receiptAgenda').textContent = data.agendaTitle;
  document.getElementById('receiptWaktu').textContent = data.waktuPresensi;
  document.getElementById('modalReceipt').classList.remove('hidden');
  document.getElementById('modalReceipt').classList.add('flex');
}

function closeReceiptModal() {
  document.getElementById('modalReceipt').classList.add('hidden');
  document.getElementById('modalReceipt').classList.remove('flex');
}

/**
 * =========================================================================
 * FITUR ADMIN: LOGIN, AGENDA MANAGEMENT & REAL-TIME DASHBOARD
 * =========================================================================
 */
function switchView(viewName) {
  const isIndexPage = !document.getElementById('adminPanel') && !document.getElementById('adminLoginGate');
  const isAdminPage = !document.getElementById('viewPresensi');

  if (viewName === 'admin') {
    if (isIndexPage) {
      window.location.href = 'admin.html';
      return;
    }
  } else {
    if (isAdminPage) {
      window.location.href = 'index.html';
      return;
    }
  }

  const viewPresensi = document.getElementById('viewPresensi');
  const viewAdmin = document.getElementById('viewAdmin');
  const navPresensi = document.getElementById('navPresensiBtn');
  const navAdmin = document.getElementById('navAdminBtn');
  const sidebarDock = document.getElementById('sidebarDock');
  const sidePresensi = document.getElementById('sidebarBtnPresensi');
  const sideAdmin = document.getElementById('sidebarBtnAdmin');

  if (viewName === 'admin') {
    if (viewPresensi) viewPresensi.classList.add('hidden');
    if (viewAdmin) viewAdmin.classList.remove('hidden');
    if (navAdmin) navAdmin.className = "pnl-nav-item-active flex items-center gap-1.5 px-4 py-2 text-xs sm:text-sm transition-all";
    if (navPresensi) navPresensi.className = "pnl-nav-item-idle flex items-center gap-1.5 px-4 py-2 text-xs sm:text-sm transition-all";
    
    if (sidebarDock) {
      sidebarDock.classList.remove('hidden');
      sidebarDock.classList.add('lg:flex');
    }
    if (sideAdmin) sideAdmin.classList.add('active');
    if (sidePresensi) sidePresensi.classList.remove('active');

    if (currentAdminPin) {
      refreshDashboard();
    }
  } else {
    if (viewAdmin) viewAdmin.classList.add('hidden');
    if (viewPresensi) viewPresensi.classList.remove('hidden');
    if (navPresensi) navPresensi.className = "pnl-nav-item-active flex items-center gap-1.5 px-4 py-2 text-xs sm:text-sm transition-all";
    if (navAdmin) navAdmin.className = "pnl-nav-item-idle flex items-center gap-1.5 px-4 py-2 text-xs sm:text-sm transition-all";
    
    if (sidebarDock) {
      sidebarDock.classList.add('hidden');
      sidebarDock.classList.remove('lg:flex');
    }
    if (sidePresensi) sidePresensi.classList.add('active');
    if (sideAdmin) sideAdmin.classList.remove('active');
    fetchActiveAgenda();
  }
}

function doAdminLogin() {
  const pinInput = document.getElementById('adminPinInput');
  const pin = pinInput.value.trim();

  if (!pin) {
    showToast('warning', 'PIN Diperlukan', 'Silakan masukkan PIN admin.');
    pinInput.focus();
    return;
  }

  const btnText = document.getElementById('btnAdminLoginText');
  const btnSpinner = document.getElementById('btnAdminLoginSpinner');
  btnText.textContent = 'Memverifikasi...';
  btnSpinner.classList.remove('hidden');

  if (isGasEnvironment) {
    google.script.run
      .withSuccessHandler((res) => {
        btnText.textContent = 'Masuk Dashboard';
        btnSpinner.classList.add('hidden');

        if (res.success) {
          currentAdminPin = pin;
          sessionStorage.setItem('kip_admin_pin', pin);
          document.getElementById('adminLoginGate').classList.add('hidden');
          document.getElementById('adminPanel').classList.remove('hidden');
          showToast('success', 'Login Berhasil', 'Selamat datang di panel admin.');
          refreshDashboard();
        } else {
          showToast('error', 'Login Gagal', res.message || 'PIN Admin tidak valid.');
          pinInput.focus();
        }
      })
      .withFailureHandler((err) => {
        btnText.textContent = 'Masuk Dashboard';
        btnSpinner.classList.add('hidden');
        showToast('error', 'Kesalahan Server', err.message);
      })
      .adminLogin(pin);
    return;
  }

  const gasUrl = getGasApiUrl();
  if (gasUrl) {
    fetch(`${gasUrl}?action=adminLogin&pin=${encodeURIComponent(pin)}`)
      .then(res => res.json())
      .then(res => {
        btnText.textContent = 'Masuk Dashboard';
        btnSpinner.classList.add('hidden');

        if (res.success) {
          currentAdminPin = pin;
          sessionStorage.setItem('kip_admin_pin', pin);
          document.getElementById('adminLoginGate').classList.add('hidden');
          document.getElementById('adminPanel').classList.remove('hidden');
          showToast('success', 'Login Berhasil', 'Selamat datang di panel admin.');
          refreshDashboard();
        } else {
          showToast('error', 'Login Gagal', res.message || 'PIN Admin salah.');
          pinInput.focus();
        }
      })
      .catch(err => {
        fallbackLocalLogin(pin, btnText, btnSpinner, pinInput);
      });
    return;
  }

  fallbackLocalLogin(pin, btnText, btnSpinner, pinInput);
}

function fallbackLocalLogin(pin, btnText, btnSpinner, pinInput) {
  setTimeout(() => {
    btnText.textContent = 'Masuk Dashboard';
    btnSpinner.classList.add('hidden');

    const validPin = localStorage.getItem('kip_admin_pin') || 'KIP2026';
    if (pin === validPin) {
      currentAdminPin = pin;
      sessionStorage.setItem('kip_admin_pin', pin);
      document.getElementById('adminLoginGate').classList.add('hidden');
      document.getElementById('adminPanel').classList.remove('hidden');
      showToast('success', 'Login Berhasil', 'Selamat datang di Dashboard Admin KIP 2026.');
      refreshDashboard();
    } else {
      showToast('error', 'Login Gagal', 'PIN Admin salah! Gunakan PIN default: KIP2026');
      pinInput.focus();
    }
  }, 200);
}

function logoutAdmin() {
  currentAdminPin = null;
  sessionStorage.removeItem('kip_admin_pin');
  document.getElementById('adminPanel').classList.add('hidden');
  document.getElementById('adminLoginGate').classList.remove('hidden');
  document.getElementById('adminPinInput').value = '';
  showToast('info', 'Logout', 'Anda telah keluar dari mode admin.');
}

function refreshDashboard() {
  if (!currentAdminPin) return;

  if (isGasEnvironment) {
    google.script.run
      .withSuccessHandler((res) => {
        if (res.success) {
          dashboardCache = res;
          renderDashboard(res);
        } else {
          showToast('error', 'Gagal Memuat Dashboard', res.message);
        }
      })
      .withFailureHandler((err) => {
        showToast('error', 'Gagal Refresh', err.message);
      })
      .getDashboardStats(currentAdminPin);
    return;
  }

  const gasUrl = getGasApiUrl();
  if (gasUrl) {
    fetch(`${gasUrl}?action=getDashboard&pin=${encodeURIComponent(currentAdminPin)}`)
      .then(res => res.json())
      .then(res => {
        if (res.success) {
          dashboardCache = res;
          renderDashboard(res);
        } else {
          showToast('error', 'Gagal', res.message);
        }
      })
      .catch(err => {
        console.warn("GAS fetch error, falling back to local dashboard:", err);
        fallbackLocalDashboard();
      });
    return;
  }

  fallbackLocalDashboard();
}

function fallbackLocalDashboard() {
  const masterList = window.MASTER_PANITIA || [];
  const filledMembers = masterList.filter(m => m.nama && m.nama.trim() !== '');
  const rawAgenda = localStorage.getItem('kip_active_agenda');
  const activeAgenda = rawAgenda ? JSON.parse(rawAgenda) : null;
  const rawRecords = JSON.parse(localStorage.getItem('kip_raw_presensi') || '[]');

  const sieSet = new Set();
  const panitiaList = filledMembers.map((m, idx) => {
    const nimStr = String(m.nim || '').replace(/\D/g, '');
    const sieStr = m.sie || '-';
    if (sieStr && sieStr !== '-') sieSet.add(sieStr);

    const attend = (activeAgenda && activeAgenda.status === 'AKTIF')
      ? rawRecords.find(r => r.agendaId === activeAgenda.id && r.nim === nimStr)
      : null;

    return {
      no: m.no || (idx + 1),
      nama: m.nama,
      nim: nimStr,
      jabatan: m.jabatan || '-',
      sie: sieStr,
      delegasi: m.delegasi || '-',
      status: attend ? 'HADIR' : 'BELUM HADIR',
      waktuPresensi: attend ? attend.waktu : '-'
    };
  });

  const totalPanitia = panitiaList.length;
  const totalHadir = panitiaList.filter(p => p.status === 'HADIR').length;
  const belumHadir = Math.max(0, totalPanitia - totalHadir);
  const persentase = totalPanitia > 0 ? ((totalHadir / totalPanitia) * 100).toFixed(1) : '0.0';

  const mockDashboardData = {
    success: true,
    activeAgenda: activeAgenda,
    stats: {
      totalPanitia: totalPanitia,
      sudahHadir: totalHadir,
      belumHadir: belumHadir,
      persentase: persentase
    },
    panitia: panitiaList,
    sieList: Array.from(sieSet)
  };

  dashboardCache = mockDashboardData;
  renderDashboard(mockDashboardData);
}

function renderDashboard(data) {
  // 1. Stats Counter
  document.getElementById('statTotalPanitia').textContent = data.stats.totalPanitia;
  document.getElementById('statSudahHadir').textContent = data.stats.sudahHadir;
  document.getElementById('statBelumHadir').textContent = data.stats.belumHadir;
  document.getElementById('statPersentase').textContent = data.stats.persentase;
  document.getElementById('statProgressBar').style.width = `${Math.min(100, parseFloat(data.stats.persentase))}%`;

  // 2. Active Agenda Meta
  if (data.activeAgenda && data.activeAgenda.status === 'AKTIF') {
    document.getElementById('adminAgendaTitle').textContent = data.activeAgenda.title;
    document.getElementById('adminAgendaMeta').innerHTML = `ID: <span class="font-mono">${data.activeAgenda.id}</span> • ${data.activeAgenda.date}, ${data.activeAgenda.time}`;
  } else {
    document.getElementById('adminAgendaTitle').textContent = 'Tidak Ada Agenda Aktif';
    document.getElementById('adminAgendaMeta').textContent = 'Klik "Generate Agenda" untuk membuka agenda rapat baru.';
  }

  // 3. Populate Filter Sie Dropdown
  const filterSie = document.getElementById('filterSie');
  const curSieVal = filterSie.value;
  filterSie.innerHTML = '<option value="">Semua Sie</option>';
  if (data.sieList) {
    data.sieList.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === curSieVal) opt.selected = true;
      filterSie.appendChild(opt);
    });
  }

  // 4. Update Visual Sie Chart (Quixotic Engagement Style)
  updateSieChart(data.panitia);

  // 5. Render Table
  applyFilters();
}

function updateSieChart(panitiaList) {
  const chartContainer = document.getElementById('sieChartGrid');
  if (!chartContainer || !panitiaList) return;

  const sieStats = {};
  const sies = ['Pejabat Acara', 'Acara', 'Konsumsi', 'Pubdok', 'Perdek', 'Keamanan'];
  sies.forEach(s => sieStats[s] = { total: 0, hadir: 0 });

  panitiaList.forEach(p => {
    if (sieStats[p.sie]) {
      sieStats[p.sie].total++;
      if (p.status === 'HADIR') sieStats[p.sie].hadir++;
    }
  });

  chartContainer.innerHTML = '';
  sies.forEach(s => {
    const stat = sieStats[s];
    const pct = stat.total > 0 ? Math.round((stat.hadir / stat.total) * 100) : 0;
    const barHeight = Math.max(10, Math.round(pct * 0.9));

    const col = document.createElement('div');
    col.className = "flex flex-col items-center justify-between p-3.5 rounded-2xl bg-slate-50/80 border border-slate-200 hover:bg-white hover:shadow-sm transition-all";
    col.innerHTML = `
      <div class="text-center w-full">
        <span class="text-[11px] font-extrabold text-slate-800 block truncate" title="${s}">${s}</span>
        <span class="text-[10px] font-semibold text-slate-500">${stat.hadir}/${stat.total} Hadir</span>
      </div>
      <div class="h-20 w-7 bg-slate-200/80 rounded-full flex flex-col justify-end p-1 my-2 overflow-hidden">
        <div class="w-full bg-gradient-to-t from-red-600 to-amber-500 rounded-full transition-all duration-500" style="height: ${barHeight}%"></div>
      </div>
      <span class="badge-pnl-red px-2 py-0.5 text-[10px] font-bold">${pct}%</span>
    `;
    chartContainer.appendChild(col);
  });
}

function applyFilters() {
  if (!dashboardCache || !dashboardCache.panitia) return;

  const filterSie = document.getElementById('filterSie').value;
  const filterStatus = document.getElementById('filterStatus').value;
  const searchVal = document.getElementById('searchPanitiaInput').value.toLowerCase().trim();

  const filtered = dashboardCache.panitia.filter(item => {
    if (filterSie && item.sie !== filterSie) return false;
    if (filterStatus && item.status !== filterStatus) return false;
    if (searchVal) {
      const matchNama = item.nama.toLowerCase().includes(searchVal);
      const matchNim = item.nim.toLowerCase().includes(searchVal);
      if (!matchNama && !matchNim) return false;
    }
    return true;
  });

  renderPanitiaTable(filtered);
}

function renderPanitiaTable(list) {
  const tbody = document.getElementById('panitiaTableBody');
  tbody.innerHTML = '';

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="p-6 text-center text-slate-400">
          Tidak ada data panitia yang cocok dengan filter.
        </td>
      </tr>`;
    document.getElementById('tableSummary').textContent = `Menampilkan 0 dari ${dashboardCache.panitia.length} panitia`;
    return;
  }

  list.forEach((p, idx) => {
    const tr = document.createElement('tr');
    tr.className = "hover:bg-slate-50/80 transition-colors";

    const isHadir = (p.status === 'HADIR');
    const badgeStatus = isHadir 
      ? `<span class="badge-pnl-emerald inline-flex items-center gap-1.5 px-3 py-1 text-[11px]">
           <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> HADIR
         </span>`
      : `<span class="badge-pnl-slate inline-flex items-center gap-1 px-3 py-1 text-[11px]">
           BELUM
         </span>`;

    const namaDisplay = p.nama || '<span class="italic text-slate-400 font-normal">(Belum Terisi)</span>';
    const nimDisplay = p.nim ? `<span class="font-mono text-slate-800 font-bold">${p.nim}</span>` : '<span class="italic text-slate-400 font-mono">-</span>';

    tr.innerHTML = `
      <td class="p-3.5 text-center text-slate-400 font-mono">${idx + 1}</td>
      <td class="p-3.5 font-bold text-slate-900">${namaDisplay}</td>
      <td class="p-3.5">${nimDisplay}</td>
      <td class="p-3.5"><span class="badge-pnl-gold px-2.5 py-0.5 text-[11px]">${p.sie}</span></td>
      <td class="p-3.5 font-semibold text-slate-700">${p.jabatan}</td>
      <td class="p-3.5 truncate max-w-xs text-slate-600">${p.delegasi || '-'}</td>
      <td class="p-3.5 text-center">${badgeStatus}</td>
      <td class="p-3.5 text-center font-mono text-slate-600 font-semibold">${p.waktuPresensi || '-'}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('tableSummary').textContent = `Menampilkan ${list.length} dari ${dashboardCache.panitia.length} panitia`;
}

/**
 * Export CSV Helper with UTF-8 BOM
 */
function exportTableToCSV() {
  if (!dashboardCache || !dashboardCache.panitia) {
    showToast('warning', 'Data Kosong', 'Tidak ada data untuk diunduh.');
    return;
  }

  const title = (window.activeAgendaState ? window.activeAgendaState.title : 'Rekap Kehadiran Panitia KIP 2026');
  let csv = '\uFEFF'; // UTF-8 BOM for Excel compatibility
  csv += `"No","Nama Lengkap","NIM","Sie","Jabatan","Delegasi","Status Kehadiran","Waktu Presensi"\n`;

  dashboardCache.panitia.forEach((p, i) => {
    csv += `"${i + 1}","${p.nama}","'${p.nim}","${p.sie}","${p.jabatan}","${p.delegasi}","${p.status}","${p.waktuPresensi || '-'}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Presensi_${title.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('success', 'CSV Berhasil Diunduh', 'File rekap kehadiran telah diunduh.');
}

/**
 * Print Attendance Sheet for LPJ
 */
function printAttendanceSheet() {
  window.print();
}

/**
 * Modal Google Sheets Config (Web App URL)
 */
function openModalGsheetConfig() {
  const modal = document.getElementById('modalGsheetConfig');
  const input = document.getElementById('gasUrlInput');
  const curUrl = getGasApiUrl();
  if (input) input.value = curUrl;

  const statusLabel = document.getElementById('gsheetStatusLabel');
  if (statusLabel) {
    if (curUrl) {
      statusLabel.className = "font-bold text-emerald-600";
      statusLabel.textContent = "URL Tersimpan: Siap Terhubung";
    } else {
      statusLabel.className = "font-bold text-amber-600";
      statusLabel.textContent = "Mode Lokal (Belum Terhubung ke GSheet)";
    }
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeModalGsheetConfig() {
  const modal = document.getElementById('modalGsheetConfig');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function saveGsheetConfig() {
  const input = document.getElementById('gasUrlInput');
  const url = input.value.trim();

  if (!url) {
    localStorage.removeItem('kip_gas_url');
    showToast('info', 'Webhook Default Aktif', 'Menggunakan webhook default permanen Google Apps Script.');
  } else {
    localStorage.setItem('kip_gas_url', url);
    showToast('success', 'URL Disimpan', 'Website sekarang membaca dan menulis langsung ke Google Sheet!');
  }

  updateConnectionBadge();
  closeModalGsheetConfig();
  fetchActiveAgenda();
  if (currentAdminPin) refreshDashboard();
}

function resetGsheetConfigDefault() {
  localStorage.removeItem('kip_gas_url');
  const input = document.getElementById('gasUrlInput');
  if (input) input.value = PERMANENT_GAS_URL;
  showToast('info', 'Webhook Default Aktif', 'URL dikembalikan ke Webhook default permanen Google Apps Script.');
  updateConnectionBadge();
}

function testGsheetConnection() {
  const input = document.getElementById('gasUrlInput');
  const url = input.value.trim();
  const statusLabel = document.getElementById('gsheetStatusLabel');

  if (!url) {
    showToast('warning', 'URL Kosong', 'Masukkan URL Web App terlebih dahulu.');
    return;
  }

  statusLabel.className = "font-bold text-blue-600";
  statusLabel.textContent = "Sedang menguji koneksi ke Google Sheet...";

  fetch(`${url}?action=getActiveAgenda`)
    .then(res => res.json())
    .then(data => {
      if (data.success !== undefined) {
        statusLabel.className = "font-bold text-emerald-600";
        statusLabel.textContent = "🟢 Koneksi Berhasil! Google Sheet Terhubung Sempurna.";
        showToast('success', 'Koneksi Sukses', 'Google Spreadsheet Panitia KIP 2026 terhubung.');
      } else {
        statusLabel.className = "font-bold text-amber-600";
        statusLabel.textContent = "⚠️ Menerima respon, namun format tidak sesuai.";
      }
    })
    .catch(err => {
      statusLabel.className = "font-bold text-rose-600";
      statusLabel.textContent = "❌ Gagal terhubung: " + err.message + ". Pastikan Deploy 'Anyone'!";
      showToast('error', 'Koneksi Gagal', 'Periksa kembali URL dan izin akses Web App.');
    });
}

/**
 * Modal Generate Agenda
 */
function openModalGenerateAgenda() {
  document.getElementById('modalGenerateAgenda').classList.remove('hidden');
  document.getElementById('modalGenerateAgenda').classList.add('flex');
  document.getElementById('agendaInputTitle').focus();
}

function closeModalGenerateAgenda() {
  document.getElementById('modalGenerateAgenda').classList.add('hidden');
  document.getElementById('modalGenerateAgenda').classList.remove('flex');
}

function submitGenerateAgenda() {
  const title = document.getElementById('agendaInputTitle').value.trim();
  const date = document.getElementById('agendaInputDate').value;
  const time = document.getElementById('agendaInputTime').value;
  const location = document.getElementById('agendaInputLocation').value.trim();
  const sessionCode = document.getElementById('agendaInputCode').value.trim();

  if (!title) {
    showToast('warning', 'Judul Wajib', 'Silakan masukkan judul agenda rapat.');
    return;
  }

  const btn = document.getElementById('btnSubmitAgenda');
  const spinner = document.getElementById('btnSubmitAgendaSpinner');
  spinner.classList.remove('hidden');
  btn.disabled = true;

  const payload = {
    title: title,
    date: date,
    time: time,
    location: location,
    sessionCode: sessionCode
  };

  if (isGasEnvironment) {
    google.script.run
      .withSuccessHandler((res) => {
        spinner.classList.add('hidden');
        btn.disabled = false;

        if (res.success) {
          closeModalGenerateAgenda();
          showToast('success', 'Agenda Berhasil Dibuat', res.message);
          refreshDashboard();
          fetchActiveAgenda();
        } else {
          showToast('error', 'Gagal Membuat Agenda', res.message);
        }
      })
      .withFailureHandler((err) => {
        spinner.classList.add('hidden');
        btn.disabled = false;
        showToast('error', 'Kesalahan', err.message);
      })
      .createAgenda(payload, currentAdminPin);
    return;
  }

  const gasUrl = getGasApiUrl();
  if (gasUrl) {
    fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'createAgenda', payload: payload, pin: currentAdminPin })
    })
    .then(res => res.json())
    .then(res => {
      spinner.classList.add('hidden');
      btn.disabled = false;
      if (res.success) {
        closeModalGenerateAgenda();
        showToast('success', 'Agenda Diaktifkan di GSheet', res.message);
        fetchActiveAgenda();
        refreshDashboard();
      } else {
        showToast('error', 'Gagal', res.message);
      }
    })
    .catch(err => {
      fallbackLocalCreateAgenda(payload, spinner, btn);
    });
    return;
  }

  fallbackLocalCreateAgenda(payload, spinner, btn);
}

function fallbackLocalCreateAgenda(payload, spinner, btn) {
  setTimeout(() => {
    spinner.classList.add('hidden');
    btn.disabled = false;

    const today = new Date();
    const ymd = today.toISOString().slice(0, 10).replace(/-/g, '');
    const newAgendaId = `KIP-${ymd}-${String(Math.floor(Math.random() * 900) + 100)}`;

    const newAgenda = {
      id: newAgendaId,
      title: payload.title,
      date: payload.date || '10 November 2026',
      time: payload.time ? (payload.time + ' WIB') : '14:00 WIB',
      location: payload.location || 'Ruang Rapat Panitia',
      hasSessionCode: (payload.sessionCode !== ''),
      sessionCode: payload.sessionCode,
      status: 'AKTIF',
      createdAt: new Date().toISOString()
    };

    localStorage.setItem('kip_active_agenda', JSON.stringify(newAgenda));
    closeModalGenerateAgenda();
    showToast('success', 'Agenda Diaktifkan', `Agenda '${payload.title}' siap digunakan presensi.`);
    fetchActiveAgenda();
    refreshDashboard();
  }, 250);
}

/**
 * Tutup Agenda
 */
function confirmCloseAgenda() {
  if (!window.activeAgendaState && (!dashboardCache || !dashboardCache.activeAgenda)) {
    showToast('info', 'Info', 'Tidak ada agenda yang aktif saat ini.');
    return;
  }

  const agenda = window.activeAgendaState || dashboardCache.activeAgenda;
  if (confirm(`Yakin ingin menutup agenda '${agenda.title}'? Form presensi untuk rapat ini akan otomatis ditutup.`)) {
    if (isGasEnvironment) {
      google.script.run
        .withSuccessHandler((res) => {
          if (res.success) {
            showToast('success', 'Agenda Ditutup', res.message);
            refreshDashboard();
            fetchActiveAgenda();
          } else {
            showToast('error', 'Gagal', res.message);
          }
        })
        .withFailureHandler((err) => {
          showToast('error', 'Kesalahan', err.message);
        })
        .closeAgenda(agenda.id, currentAdminPin);
      return;
    }

    const gasUrl = getGasApiUrl();
    if (gasUrl) {
      fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'closeAgenda', agendaId: agenda.id, pin: currentAdminPin })
      })
      .then(res => res.json())
      .then(res => {
        if (res.success) {
          showToast('success', 'Agenda Ditutup di GSheet', res.message);
          fetchActiveAgenda();
          refreshDashboard();
        } else {
          showToast('error', 'Gagal', res.message);
        }
      })
      .catch(err => {
        fallbackLocalCloseAgenda(agenda);
      });
      return;
    }

    fallbackLocalCloseAgenda(agenda);
  }
}

function fallbackLocalCloseAgenda(agenda) {
  agenda.status = 'SELESAI';
  localStorage.setItem('kip_active_agenda', JSON.stringify(agenda));
  showToast('success', 'Agenda Ditutup', `Agenda '${agenda.title}' telah ditutup.`);
  fetchActiveAgenda();
  refreshDashboard();
}

/**
 * QR Code Presensi Modal
 */
function showQRCodeModal() {
  let targetUrl = window.location.href;
  if (targetUrl.includes('admin.html')) {
    targetUrl = targetUrl.replace('admin.html', 'index.html');
  }
  const wrapper = document.getElementById('qrcodeWrapper');
  if (!wrapper) return;
  wrapper.innerHTML = '';

  qrcodeInstance = new QRCode(wrapper, {
    text: targetUrl,
    width: 200,
    height: 200,
    colorDark: "#1e3a8a",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });

  const title = window.activeAgendaState ? window.activeAgendaState.title : 'Presensi KIP 2026';
  const label = document.getElementById('qrAgendaLabel');
  if (label) label.textContent = title;

  const modal = document.getElementById('modalQRCode');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function closeQRCodeModal() {
  document.getElementById('modalQRCode').classList.add('hidden');
  document.getElementById('modalQRCode').classList.remove('flex');
}

function copyPresensiLink() {
  const curUrl = window.location.href;
  navigator.clipboard.writeText(curUrl).then(() => {
    showToast('success', 'Link Tersalin', 'Tautan web presensi telah disalin ke clipboard.');
  }).catch(() => {
    showToast('info', 'Link Presensi', curUrl);
  });
}

/**
 * Alert & Toast Helpers
 */
function showAlert(type, message) {
  const alertBox = document.getElementById('presensiAlert');
  alertBox.classList.remove('hidden', 'bg-red-50', 'text-red-700', 'border-red-200', 'bg-amber-50', 'text-amber-700', 'border-amber-200');

  if (type === 'error') {
    alertBox.classList.add('bg-red-50', 'text-red-700', 'border-red-200');
  } else if (type === 'warning') {
    alertBox.classList.add('bg-amber-50', 'text-amber-700', 'border-amber-200');
  }
  alertBox.textContent = message;
}

function hideAlert() {
  const alertBox = document.getElementById('presensiAlert');
  alertBox.classList.add('hidden');
}

function showToast(type, title, message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `p-4 dash-card bg-white border border-slate-200 text-xs font-medium transition-all transform pointer-events-auto flex items-start gap-3 shadow-xl animate-fadeIn`;

  let icon = '';
  if (type === 'success') {
    icon = `<div class="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center flex-shrink-0 border border-emerald-100"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg></div>`;
  } else if (type === 'error') {
    icon = `<div class="w-8 h-8 rounded-xl bg-red-50 text-red-600 flex items-center justify-center flex-shrink-0 border border-red-100"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg></div>`;
  } else if (type === 'warning') {
    icon = `<div class="w-8 h-8 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center flex-shrink-0 border border-amber-100"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg></div>`;
  } else {
    icon = `<div class="w-8 h-8 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center flex-shrink-0 border border-slate-200"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg></div>`;
  }

  toast.innerHTML = `
    ${icon}
    <div class="flex-1">
      <strong class="block font-bold text-slate-900 text-sm leading-tight">${title}</strong>
      <p class="text-slate-600 mt-0.5 text-xs">${message}</p>
    </div>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('opacity-0', 'scale-95');
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}
