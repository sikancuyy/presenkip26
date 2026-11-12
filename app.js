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
let currentAdminPin = sessionStorage.getItem('kip_admin_pin') || localStorage.getItem('kip_admin_session') || null;
let dashboardCache = null;
let qrcodeInstance = null;
let autoSyncIntervalTimer = null;
let isSyncing = false;
let latestSyncState = null;

const PHP_API_BASE = 'api/index.php';
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

/**
 * Helper client-side untuk memformat string waktu presensi menjadi "HH:mm:ss"
 * Membersihkan format bug Google Sheets (Sat Dec 30 1899 ... / ISO date string).
 */
function formatPresensiTime(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return pad(val.getHours()) + ':' + pad(val.getMinutes()) + ':' + pad(val.getSeconds());
  }

  const str = String(val).trim();
  if (!str || str === '-') return '-';

  // Format murni HH:mm:ss atau HH:mm
  const pureMatch = str.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (pureMatch) {
    const hh = pureMatch[1].padStart(2, '0');
    const mm = pureMatch[2];
    const ss = pureMatch[3] ? pureMatch[3] : '00';
    return hh + ':' + mm + ':' + ss;
  }

  // Pola terbenam dalam string (misal: "HADIR (Sat Dec 30 1899 18:07:32 GMT...)" atau "18:07:32 WIB")
  const embeddedMatch = str.match(/\b([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)\b/);
  if (embeddedMatch) {
    const hh = embeddedMatch[1].padStart(2, '0');
    const mm = embeddedMatch[2];
    const ss = embeddedMatch[3];
    return hh + ':' + mm + ':' + ss;
  }

  if (str.includes('1899') || str.includes('T') || str.includes('GMT')) {
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      const pad = n => String(n).padStart(2, '0');
      return pad(parsed.getHours()) + ':' + pad(parsed.getMinutes()) + ':' + pad(parsed.getSeconds());
    }
  }

  return str;
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

  // Update Struktur Sie Kepanitiaan Display
  updateStrukturSieCards();

  // Load Active Agenda Banner
  fetchActiveAgenda();

  // Start 10-Second Bidirectional Auto-Sync Loop
  startAutoSyncLoop();

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
  const loginGate = document.getElementById('adminLoginGate');
  const adminPanel = document.getElementById('adminPanel');
  if (currentAdminPin && loginGate && adminPanel) {
    loginGate.classList.add('hidden');
    adminPanel.classList.remove('hidden');
    refreshDashboard();
  }
});

/**
 * Pembaruan Indikator Status Sistem
 * HANYA MENAMPILKAN INDIKATOR LINGKARAN BERKEDIP (NO TEXT BADGE)
 */
function updateConnectionBadge(syncInfo) {
  const badges = document.querySelectorAll('#envBadge, #envBadgeMobile');
  if (!badges || !badges.length) return;

  const info = syncInfo || latestSyncState || {};
  const lastSyncStr = info.lastSync || 'Tersinkron';
  const pendingCount = info.pendingCount || 0;

  badges.forEach(badge => {
    badge.setAttribute('aria-label', `Status Sistem: Terhubung Google Sheets (${lastSyncStr})`);

    if (isSyncing) {
      badge.title = `Sedang sinkronisasi data dengan Google Sheets...`;
      badge.className = "relative flex h-2.5 w-2.5 items-center justify-center flex-shrink-0";
      badge.innerHTML = `<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>`;
    } else if (pendingCount > 0) {
      badge.title = `Terdapat ${pendingCount} presensi dalam antrean pengiriman ke Google Sheets`;
      badge.className = "relative flex h-2.5 w-2.5 items-center justify-center flex-shrink-0";
      badge.innerHTML = `<span class="animate-pulse absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>`;
    } else {
      badge.title = `Google Sheets Live (${lastSyncStr}) • Auto-Sync 10s Aktif`;
      badge.className = "relative flex h-2.5 w-2.5 items-center justify-center flex-shrink-0";
      badge.innerHTML = `<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>`;
    }
  });
}

/**
 * Pembaruan Struktur Sie Kepanitiaan (Sesuai Sheet PANITIA KIP)
 */
function updateStrukturSieCards(customList) {
  const titleElem = document.getElementById('strukturKepanitiaanTitle');
  if (titleElem) titleElem.textContent = 'STRUKTUR KEPANITIAAN (46 ANGGOTA)';

  const elPejabat = document.getElementById('sieCountPejabat');
  if (elPejabat) elPejabat.textContent = 'BPH (Ketua, Sek, Ben)';

  const elAcara = document.getElementById('sieCountAcara');
  if (elAcara) elAcara.textContent = 'Sie Acara & Sidang';

  const elPerdek = document.getElementById('sieCountPerdek');
  if (elPerdek) elPerdek.textContent = 'Sie Perlengkapan';

  const elPubdok = document.getElementById('sieCountPubdok');
  if (elPubdok) elPubdok.textContent = 'Sie Humas & Media';

  const elKonsumsi = document.getElementById('sieCountKonsumsi');
  if (elKonsumsi) elKonsumsi.textContent = 'Sie Konsumsi';

  const elKeamanan = document.getElementById('sieCountKeamanan');
  if (elKeamanan) elKeamanan.textContent = 'Sie Ketertiban / PAM';
}

/**
 * Loop Sinkronisasi Dua Arah Otomatis Setiap 10 Detik
 */
function startAutoSyncLoop() {
  if (isGasEnvironment) return;
  if (autoSyncIntervalTimer) clearInterval(autoSyncIntervalTimer);

  // Trigger auto-sync setiap 10 detik
  autoSyncIntervalTimer = setInterval(async () => {
    if (isSyncing) return;
    try {
      const res = await fetch(`${PHP_API_BASE}?action=autoSync`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.success) {
        latestSyncState = data;
        updateConnectionBadge(data);

        const statusBadge = document.getElementById('syncStatusBadge');
        if (statusBadge && data.lastSync) {
          statusBadge.textContent = `Tersinkron: ${data.lastSync}`;
        }

        // Jika ada perubahan dari GSheet dan panel admin aktif, perbarui dashboard perlahan
        if (data.pulled && currentAdminPin) {
          const panel = document.getElementById('adminPanel');
          if (panel && !panel.classList.contains('hidden')) {
            refreshDashboard(true);
          }
        }
      }
    } catch (err) {
      // Abaikan gangguan polling sementara
    }
  }, 10000);
}

/**
 * Pemicu Sinkronisasi Manual (Tombol Sinkronisasi)
 */
async function triggerManualSync() {
  if (isSyncing) return;
  isSyncing = true;

  const syncIcon = document.getElementById('syncIconSpin');
  const headerSyncIcons = document.querySelectorAll('#syncHeaderIcon, #syncHeaderIconMobile');
  const syncLabel = document.getElementById('syncBtnLabel');

  if (syncIcon) syncIcon.classList.add('animate-spin');
  headerSyncIcons.forEach(icon => icon.classList.add('animate-spin'));
  if (syncLabel) syncLabel.textContent = 'Menyinkronkan...';
  updateConnectionBadge();

  try {
    const res = await fetch(`${PHP_API_BASE}?action=manualSync`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      latestSyncState = data;
      showToast('success', 'Sinkronisasi Berhasil', `Data diperbarui dari Google Sheets (${data.lastSync}).`);
      updateConnectionBadge(data);

      const statusBadge = document.getElementById('syncStatusBadge');
      if (statusBadge && data.lastSync) {
        statusBadge.textContent = `Tersinkron: ${data.lastSync}`;
      }

      // Refresh banner agenda dan dashboard
      fetchActiveAgenda();
      if (currentAdminPin) {
        const panel = document.getElementById('adminPanel');
        if (panel && !panel.classList.contains('hidden')) {
          refreshDashboard();
        }
      }
    } else {
      showToast('warning', 'Pemberitahuan Sinkronisasi', data.message || 'Sinkronisasi selesai dengan catatan.');
    }
  } catch (err) {
    console.warn('Manual sync error:', err);
    showToast('error', 'Gagal Sinkronisasi', 'Tidak dapat terhubung ke backend PHP.');
  } finally {
    isSyncing = false;
    if (syncIcon) syncIcon.classList.remove('animate-spin');
    headerSyncIcons.forEach(icon => icon.classList.remove('animate-spin'));
    if (syncLabel) syncLabel.textContent = 'Sinkronisasi';
    updateConnectionBadge();
  }
}

function copyTextToClipboard(text, successMessage) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('success', 'Tersalin', successMessage || 'Teks berhasil disalin ke clipboard.');
    }).catch(() => {
      fallbackCopyText(text, successMessage);
    });
  } else {
    fallbackCopyText(text, successMessage);
  }
}

function fallbackCopyText(text, successMessage) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('success', 'Tersalin', successMessage || 'Teks berhasil disalin ke clipboard.');
  } catch (err) {
    showToast('info', 'Salin Manual', text);
  }
  document.body.removeChild(ta);
}

function handleUrlParameters() {
  const params = new URLSearchParams(window.location.search);
  const nimParam = params.get('nim');
  const pageParam = params.get('page');
  const hash = window.location.hash;

  const isGasEnvironment = (typeof google !== 'undefined' && google.script && google.script.run);
  const currentPath = window.location.pathname;

  const isDedicatedAdmin = currentPath.includes('admin.html');
  const isAdminView = isDedicatedAdmin || pageParam === 'admin' || hash === '#admin';

  if (!isGasEnvironment) {
    if (isAdminView && !isDedicatedAdmin) {
      window.location.href = 'admin.html';
      return;
    }
  }

  if (isAdminView) {
    switchView('admin');
  } else {
    switchView('presensi');
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

  // 1. Coba ambil dari PHP Cache (Sangat cepat <10ms)
  fetch(`${PHP_API_BASE}?action=getActiveAgenda`)
    .then(res => res.json())
    .then(res => {
      handleActiveAgendaResponse(res);
    })
    .catch(err => {
      // Fallback ke GAS langsung jika backend PHP tidak merespons
      const gasUrl = getGasApiUrl();
      if (gasUrl) {
        fetch(`${gasUrl}?action=getActiveAgenda`)
          .then(res => res.json())
          .then(res => handleActiveAgendaResponse(res))
          .catch(() => fallbackLocalActiveAgenda());
      } else {
        fallbackLocalActiveAgenda();
      }
    });
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

    // Presensi view banner (index.html)
    const bId = document.getElementById('bannerAgendaId');
    const bTitle = document.getElementById('bannerAgendaTitle');
    const bSubtitle = document.getElementById('bannerAgendaSubtitle');
    const bStatus = document.getElementById('bannerStatusBadge');
    const bDate = document.getElementById('bannerAgendaDate');
    const bTime = document.getElementById('bannerAgendaTime');
    const bLoc = document.getElementById('bannerAgendaLocation');
    if (bId) bId.textContent = window.activeAgendaState.id;
    if (bTitle) bTitle.textContent = window.activeAgendaState.title;
    if (bSubtitle) bSubtitle.textContent = 'Rapat sedang berlangsung. Silakan konfirmasi presensi.';
    if (bStatus) {
      bStatus.classList.remove('hidden');
      bStatus.className = 'badge-pnl-emerald';
      bStatus.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-600 indicator-pulse"></span><span>Aktif</span>';
    }
    const bMeta = document.getElementById('bannerAgendaMeta');
    if (bMeta) {
      bMeta.classList.remove('hidden');
    }
    if (bDate) bDate.textContent = window.activeAgendaState.date;
    if (bTime) bTime.textContent = window.activeAgendaState.time;
    if (bLoc) bLoc.textContent = window.activeAgendaState.location;

    // Admin view banner (admin.html)
    const aId = document.getElementById('adminAgendaId');
    const aTitle = document.getElementById('adminAgendaTitle');
    const aMeta = document.getElementById('adminAgendaMeta');
    const aDate = document.getElementById('adminAgendaDate');
    const aTime = document.getElementById('adminAgendaTime');
    if (aId) aId.textContent = window.activeAgendaState.id;
    if (aTitle) aTitle.textContent = window.activeAgendaState.title;
    if (aDate) aDate.textContent = window.activeAgendaState.date || '-';
    if (aTime) aTime.textContent = window.activeAgendaState.time || '-';
    if (aMeta) {
      const codeBadge = window.activeAgendaState.sessionCode 
        ? `<span class="badge-pnl-gold font-mono font-bold px-2 py-0.5 text-[11px] ml-2">KODE: ${window.activeAgendaState.sessionCode}</span>` 
        : '';
      aMeta.innerHTML = `<span class="font-medium text-slate-600">${window.activeAgendaState.date} &bull; ${window.activeAgendaState.time} &bull; ${window.activeAgendaState.location}</span>${codeBadge}`;
    }

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
  const bId = document.getElementById('bannerAgendaId');
  const bTitle = document.getElementById('bannerAgendaTitle');
  const bSubtitle = document.getElementById('bannerAgendaSubtitle');
  const bStatus = document.getElementById('bannerStatusBadge');
  const bDate = document.getElementById('bannerAgendaDate');
  const bTime = document.getElementById('bannerAgendaTime');
  const bLoc = document.getElementById('bannerAgendaLocation');
  if (bId) bId.textContent = 'OFFLINE';
  if (bTitle) bTitle.textContent = 'Tidak Ada Agenda Aktif';
  if (bSubtitle) bSubtitle.textContent = 'Belum ada rapat yang dibuka saat ini.';
  if (bStatus) {
    bStatus.classList.add('hidden');
    bStatus.className = 'hidden badge-pnl-offline';
    bStatus.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span><span>Offline</span>';
  }
  const bMeta = document.getElementById('bannerAgendaMeta');
  if (bMeta) {
    bMeta.classList.add('hidden');
  }
  if (bDate) bDate.textContent = '-';
  if (bTime) bTime.textContent = '-';
  if (bLoc) bLoc.textContent = '-';

  const aId = document.getElementById('adminAgendaId');
  const aTitle = document.getElementById('adminAgendaTitle');
  const aMeta = document.getElementById('adminAgendaMeta');
  const aDate = document.getElementById('adminAgendaDate');
  const aTime = document.getElementById('adminAgendaTime');
  if (aId) aId.textContent = 'OFFLINE';
  if (aTitle) aTitle.textContent = 'Tidak Ada Agenda Aktif';
  if (aDate) aDate.textContent = '-';
  if (aTime) aTime.textContent = '-';
  if (aMeta) aMeta.textContent = 'Klik "Generate Agenda" untuk membuka agenda rapat baru.';
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
          showToast('success', 'Biodata Ditemukan', res.data.nama);
        } else {
          fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn);
        }
      })
      .withFailureHandler((err) => {
        btnText.textContent = 'CARI DATA';
        btnSpinner.classList.add('hidden');
        btn.disabled = false;
        fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn);
      })
      .searchPanitiaByNIM(cleanNim);
    return;
  }

  // 1. Coba cari di PHP Cache
  fetch(`${PHP_API_BASE}?action=searchNIM&nim=${encodeURIComponent(cleanNim)}`)
    .then(res => res.json())
    .then(res => {
      btnText.textContent = 'CARI DATA';
      btnSpinner.classList.add('hidden');
      btn.disabled = false;

      if (res.success && res.data) {
        const bio = res.data;
        bio.alreadyAttended = !!res.alreadyAttended;
        if (res.attendance && res.attendance.timestamp) {
          bio.waktuPresensi = formatPresensiTime(res.attendance.timestamp);
        } else if (bio.alreadyAttended && !bio.waktuPresensi) {
          bio.waktuPresensi = 'Terdata';
        }
        renderPanitiaBiodata(bio);
        showToast('success', 'Biodata Ditemukan', bio.nama);
      } else {
        const gasUrl = getGasApiUrl();
        if (gasUrl) {
          fetch(`${gasUrl}?action=searchNIM&nim=${encodeURIComponent(cleanNim)}`)
            .then(r => r.json())
            .then(r => {
              if (r.success && r.data) {
                renderPanitiaBiodata(r.data);
                showToast('success', 'Biodata Ditemukan', r.data.nama);
              } else {
                fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn);
              }
            })
            .catch(() => fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn));
        } else {
          fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn);
        }
      }
    })
    .catch(err => {
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
              showToast('success', 'Biodata Ditemukan', res.data.nama);
            } else {
              fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn);
            }
          })
          .catch(() => fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn));
      } else {
        fallbackLocalSearch(cleanNim, btnText, btnSpinner, btn);
      }
    });
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
      const panitiaData = {
        no: found.no,
        nama: found.nama,
        nim: String(found.nim).replace(/\D/g, ''),
        jabatan: found.jabatan || '-',
        sie: found.sie || '-',
        noHp: found.no_hp || '-',
        delegasi: found.delegasi || '-',
        alreadyAttended: false,
        waktuPresensi: null,
        hasActiveAgenda: !!window.activeAgendaState,
        activeAgendaTitle: window.activeAgendaState ? window.activeAgendaState.title : null,
        activeAgendaId: window.activeAgendaState ? window.activeAgendaState.id : null
      };

      // Cek apakah sudah absen di local storage raw_presensi
      if (window.activeAgendaState) {
        try {
          const rawLocal = JSON.parse(localStorage.getItem('kip_raw_presensi') || '[]');
          const attendedRecord = rawLocal.find(r => 
            String(r.agendaId) === String(window.activeAgendaState.id) && 
            String(r.nim).replace(/\D/g, '') === cleanNim
          );
          if (attendedRecord) {
            panitiaData.alreadyAttended = true;
            panitiaData.waktuPresensi = formatPresensiTime(attendedRecord.waktuPresensi || attendedRecord.waktu) || 'Terdata';
          }
        } catch (e) {}
      }

      renderPanitiaBiodata(panitiaData);
      showToast('success', 'Biodata Ditemukan', found.nama);
    } else {
      const bioContainer = document.getElementById('biodataContainer');
      if (bioContainer) bioContainer.classList.add('hidden');
      showAlert('error', `NIM (${cleanNim}) tidak ditemukan dalam database Panitia KIP 2026. Pastikan nomor yang dimasukkan benar.`);
    }
  }, 150);
}

function renderPanitiaBiodata(panitia) {
  currentPanitiaData = panitia;

  // Inisial Avatar
  const names = (panitia.nama || '').split(' ').filter(Boolean);
  let initials = names[0] ? names[0][0] : 'K';
  if (names.length > 1) initials += names[names.length - 1][0];
  const avatarElem = document.getElementById('avatarInitials');
  if (avatarElem) avatarElem.textContent = initials.toUpperCase();

  const bioNama = document.getElementById('bioNama');
  const bioNim = document.getElementById('bioNim');
  const bioJabatan = document.getElementById('bioJabatan');
  const bioSie = document.getElementById('bioSie');
  const bioDelegasi = document.getElementById('bioDelegasi');
  const bioStatusBadge = document.getElementById('bioStatusBadge');
  const noticeElem = document.getElementById('bioAttendanceNotice');

  if (bioNama) bioNama.textContent = panitia.nama;
  if (bioNim) bioNim.textContent = panitia.nim;
  if (bioJabatan) bioJabatan.textContent = panitia.jabatan || '-';
  if (bioSie) bioSie.textContent = panitia.sie || '-';
  if (bioDelegasi) bioDelegasi.textContent = panitia.delegasi || '-';

  const sessionField = document.getElementById('sessionCodeField');
  const btnHadir = document.getElementById('btnHadir');
  const btnHadirText = document.getElementById('btnHadirText');
  const btnHadirIcon = document.getElementById('btnHadirIcon');

  hideAlert();

  // Kondisi 1: SUDAH ABSEN PADA SESI / AGENDA INI
  if (panitia.alreadyAttended) {
    const waktuFormatted = panitia.waktuPresensi ? formatPresensiTime(panitia.waktuPresensi) : '';
    const waktuText = waktuFormatted ? `${waktuFormatted} WIB` : 'Tercatat';
    const agendaTitle = (window.activeAgendaState ? window.activeAgendaState.title : (panitia.activeAgendaTitle || 'Agenda Rapat Aktif'));

    if (bioStatusBadge) {
      bioStatusBadge.className = "badge-pnl-emerald px-2.5 py-0.5 text-[11px] font-bold inline-flex items-center gap-1";
      bioStatusBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> SUDAH ABSEN (${waktuText})`;
    }

    if (noticeElem) {
      noticeElem.className = "rounded-xl p-4 bg-emerald-50 border border-emerald-200 text-emerald-900 animate-fadeIn";
      noticeElem.innerHTML = `
        <div class="flex items-start gap-3">
          <div class="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center flex-shrink-0">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h4 class="font-extrabold text-sm text-emerald-950">SUDAH MELAKUKAN PRESENSI</h4>
              <span class="bg-emerald-200 text-emerald-900 font-mono font-bold text-[11px] px-2 py-0.5 rounded-md">${waktuText}</span>
            </div>
            <p class="text-xs text-emerald-700 mt-1 leading-relaxed">
              Halo <strong>${panitia.nama}</strong>, bukti kehadiran Anda untuk agenda <strong>${agendaTitle}</strong> telah tercatat pada pukul <strong>${waktuText}</strong>. Anda tidak perlu mengirim presensi ulang.
            </p>
          </div>
        </div>
      `;
      noticeElem.classList.remove('hidden');
    }

    if (sessionField) sessionField.classList.add('hidden');

    if (btnHadir) {
      btnHadir.disabled = true;
      btnHadir.className = "btn-pnl-emerald w-full min-h-[50px] py-3 px-6 text-sm sm:text-base font-extrabold tracking-wider flex items-center justify-center gap-2.5 cursor-default opacity-95 shadow-sm";
    }
    if (btnHadirText) btnHadirText.textContent = `SUDAH ABSEN (${waktuText})`;
    if (btnHadirIcon) {
      btnHadirIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>`;
    }
  } 
  // Kondisi 2: BELUM ABSEN & AGENDA SEDANG AKTIF
  else if (window.activeAgendaState && window.activeAgendaState.status === 'AKTIF') {
    if (bioStatusBadge) {
      bioStatusBadge.className = "badge-pnl-emerald px-2.5 py-0.5 text-[11px]";
      bioStatusBadge.textContent = "Terdaftar di SK Panitia";
    }

    if (noticeElem) {
      noticeElem.classList.add('hidden');
      noticeElem.innerHTML = '';
    }

    if (sessionField) {
      if (window.activeAgendaState.hasSessionCode) {
        sessionField.classList.remove('hidden');
      } else {
        sessionField.classList.add('hidden');
      }
    }

    if (btnHadir) {
      btnHadir.disabled = false;
      btnHadir.className = "btn-pnl-red w-full min-h-[50px] py-3 px-6 text-sm sm:text-base font-extrabold tracking-wider flex items-center justify-center gap-2.5 transition-all shadow-sm active:scale-[0.99]";
    }
    if (btnHadirText) btnHadirText.textContent = 'KONFIRMASI HADIR';
    if (btnHadirIcon) {
      btnHadirIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path>`;
    }
  } 
  // Kondisi 3: TIDAK ADA SESI / AGENDA AKTIF (OFFLINE)
  else {
    if (bioStatusBadge) {
      bioStatusBadge.className = "badge-pnl-gold px-2.5 py-0.5 text-[11px] font-bold";
      bioStatusBadge.textContent = "Terdaftar di SK Panitia";
    }

    if (noticeElem) {
      noticeElem.className = "rounded-xl p-4 bg-amber-50 border border-amber-200 text-amber-900 animate-fadeIn";
      noticeElem.innerHTML = `
        <div class="flex items-start gap-3">
          <div class="w-8 h-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center flex-shrink-0">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <h4 class="font-extrabold text-sm text-amber-950">Biodata Terverifikasi (Belum Ada Sesi Aktif)</h4>
            <p class="text-xs text-amber-800 mt-1 leading-relaxed">
              Halo <strong>${panitia.nama}</strong>, biodata Anda terdaftar resmi pada SK Panitia KIP 2026.
            </p>
          </div>
        </div>
      `;
      noticeElem.classList.remove('hidden');
    }

    if (sessionField) sessionField.classList.add('hidden');

    if (btnHadir) {
      btnHadir.disabled = true;
      btnHadir.className = "w-full min-h-[50px] py-3 px-6 rounded-lg bg-slate-200 text-slate-500 font-extrabold text-sm sm:text-base flex items-center justify-center gap-2.5 cursor-not-allowed shadow-none";
    }
    if (btnHadirText) btnHadirText.textContent = 'AGENDA RAPAT BELUM DIBUKA';
    if (btnHadirIcon) {
      btnHadirIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>`;
    }
  }

  const bioContainer = document.getElementById('biodataContainer');
  if (bioContainer) bioContainer.classList.remove('hidden');
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
            if (currentPanitiaData) {
              currentPanitiaData.alreadyAttended = true;
              currentPanitiaData.waktuPresensi = formatPresensiTime(res.waktuPresensi || new Date());
              renderPanitiaBiodata(currentPanitiaData);
            }
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

  // 1. Kirim langsung ke backend PHP (Cache & Antrean Otomatis Cepat)
  fetch(`${PHP_API_BASE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'submitPresensi', payload: payload })
  })
  .then(res => res.json())
  .then(res => {
    btnText.textContent = 'KONFIRMASI HADIR';
    btnSpinner.classList.add('hidden');
    btn.disabled = false;

    if (res.success) {
      playChime(true);
      showReceiptModal(res.receipt || res.data);
      resetPresensiForm();
      showToast('success', 'Presensi Berhasil', res.message);
    } else {
      if (res.alreadyAttended || res.duplicate) {
        showAlert('warning', res.message);
        showToast('warning', 'Sudah Presensi', res.message);
        if (currentPanitiaData) {
          currentPanitiaData.alreadyAttended = true;
          currentPanitiaData.waktuPresensi = formatPresensiTime(res.receipt ? res.receipt.timestamp : new Date());
          renderPanitiaBiodata(currentPanitiaData);
        }
        if (res.receipt) {
          showReceiptModal(res.receipt);
        }
      } else {
        showAlert('error', res.message);
        showToast('error', 'Presensi Gagal', res.message);
      }
    }
  })
  .catch(err => {
    console.warn("PHP POST error, mencoba fallback ke GAS langsung:", err);
    const gasUrl = getGasApiUrl();
    if (gasUrl) {
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
          showAlert('error', res.message);
          showToast('error', 'Presensi Gagal', res.message);
        }
      })
      .catch(() => fallbackLocalSubmit(payload, btnText, btnSpinner, btn));
    } else {
      fallbackLocalSubmit(payload, btnText, btnSpinner, btn);
    }
  });
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
      if (currentPanitiaData) {
        currentPanitiaData.alreadyAttended = true;
        currentPanitiaData.waktuPresensi = formatPresensiTime(alreadySubmitted.waktu);
        renderPanitiaBiodata(currentPanitiaData);
      }
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
  const inputNim = document.getElementById('inputNim');
  if (inputNim) inputNim.value = '';
  const codeInput = document.getElementById('inputSessionCode');
  if (codeInput) codeInput.value = '';
  const bioContainer = document.getElementById('biodataContainer');
  if (bioContainer) bioContainer.classList.add('hidden');
  currentPanitiaData = null;

  const btnHadir = document.getElementById('btnHadir');
  const btnHadirText = document.getElementById('btnHadirText');
  if (btnHadir) {
    btnHadir.disabled = false;
    btnHadir.classList.add('btn-pnl-red');
    btnHadir.classList.remove('bg-slate-300', 'text-slate-600', 'cursor-not-allowed');
  }
  if (btnHadirText) btnHadirText.textContent = 'KONFIRMASI HADIR';

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
  const viewPresensi = document.getElementById('viewPresensi');
  const viewAdmin = document.getElementById('viewAdmin');
  const navPresensi = document.getElementById('navPresensiBtn');
  const navAdmin = document.getElementById('navAdminBtn');
  const sidebarDock = document.getElementById('sidebarDock');
  const sidePresensi = document.getElementById('sidebarBtnPresensi');
  const sideAdmin = document.getElementById('sidebarBtnAdmin');

  const isDedicatedAdmin = window.location.pathname.includes('admin.html');

  if (viewName === 'admin' || isDedicatedAdmin) {
    if (viewPresensi) viewPresensi.classList.add('hidden');
    if (viewAdmin) viewAdmin.classList.remove('hidden');
    if (navAdmin) navAdmin.className = "pnl-nav-item-active flex items-center gap-1.5 px-4 py-2 text-xs sm:text-sm transition-all";
    if (navPresensi) navPresensi.className = "pnl-nav-item-idle flex items-center gap-1.5 px-4 py-2 text-xs sm:text-sm transition-all";
    
    // Tampilkan sidebar HANYA pada panel admin
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
    
    // Sembunyikan sidebar di halaman presensi / formSection
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
          const gate = document.getElementById('adminLoginGate');
          const panel = document.getElementById('adminPanel');
          if (gate) gate.classList.add('hidden');
          if (panel) panel.classList.remove('hidden');
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

  // 1. Coba login ke backend PHP
  fetch(`${PHP_API_BASE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'adminLogin', pin: pin })
  })
  .then(res => res.json())
  .then(res => {
    btnText.textContent = 'Masuk Dashboard';
    btnSpinner.classList.add('hidden');

    if (res.success) {
      currentAdminPin = pin;
      sessionStorage.setItem('kip_admin_pin', pin);
      const gate = document.getElementById('adminLoginGate');
      const panel = document.getElementById('adminPanel');
      if (gate) gate.classList.add('hidden');
      if (panel) panel.classList.remove('hidden');
      showToast('success', 'Login Berhasil', 'Selamat datang di panel admin.');
      refreshDashboard();
    } else {
      showToast('error', 'Login Gagal', res.message || 'PIN Admin salah.');
      pinInput.focus();
    }
  })
  .catch(err => {
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
            const gate = document.getElementById('adminLoginGate');
            const panel = document.getElementById('adminPanel');
            if (gate) gate.classList.add('hidden');
            if (panel) panel.classList.remove('hidden');
            showToast('success', 'Login Berhasil', 'Selamat datang di panel admin.');
            refreshDashboard();
          } else {
            showToast('error', 'Login Gagal', res.message || 'PIN Admin salah.');
            pinInput.focus();
          }
        })
        .catch(() => fallbackLocalLogin(pin, btnText, btnSpinner, pinInput));
    } else {
      fallbackLocalLogin(pin, btnText, btnSpinner, pinInput);
    }
  });
}

function fallbackLocalLogin(pin, btnText, btnSpinner, pinInput) {
  setTimeout(() => {
    btnText.textContent = 'Masuk Dashboard';
    btnSpinner.classList.add('hidden');

    const validPin = localStorage.getItem('kip_admin_pin') || 'KIP2026';
    if (pin === validPin) {
      currentAdminPin = pin;
      sessionStorage.setItem('kip_admin_pin', pin);
      const gate = document.getElementById('adminLoginGate');
      const panel = document.getElementById('adminPanel');
      if (gate) gate.classList.add('hidden');
      if (panel) panel.classList.remove('hidden');
      showToast('success', 'Login Berhasil', 'Selamat datang di Dashboard Admin KIP 2026.');
      refreshDashboard();
    } else {
      showToast('error', 'Login Gagal', 'PIN Admin salah! Gunakan PIN default: KIP2026');
      pinInput.focus();
    }
  }, 200);
}

function logoutAdmin() {
  if (confirm('Keluar dari Dashboard Administrator KIP 2026?')) {
    currentAdminPin = null;
    sessionStorage.removeItem('kip_admin_pin');
    localStorage.removeItem('kip_admin_session');
    window.location.href = 'login.html';
  }
}

function refreshDashboard(quiet = false) {
  if (!currentAdminPin) return;

  if (isGasEnvironment) {
    google.script.run
      .withSuccessHandler((res) => {
        if (res.success) {
          dashboardCache = res;
          renderDashboard(res);
        } else if (!quiet) {
          showToast('error', 'Gagal Memuat Dashboard', res.message);
        }
      })
      .withFailureHandler((err) => {
        if (!quiet) showToast('error', 'Gagal Refresh', err.message);
      })
      .getDashboardStats(currentAdminPin);
    return;
  }

  // 1. Coba ambil dari PHP Cache (Sangat cepat <15ms)
  fetch(`${PHP_API_BASE}?action=getDashboard&pin=${encodeURIComponent(currentAdminPin)}`)
    .then(res => res.json())
    .then(res => {
      if (res.success) {
        dashboardCache = res;
        renderDashboard(res);
        if (res.sync && res.sync.last_sync_formatted) {
          const statusBadge = document.getElementById('syncStatusBadge');
          if (statusBadge) statusBadge.textContent = `Tersinkron: ${res.sync.last_sync_formatted}`;
        }
      } else {
        if (!quiet) showToast('error', 'Gagal', res.message);
      }
    })
    .catch(err => {
      const gasUrl = getGasApiUrl();
      if (gasUrl) {
        fetch(`${gasUrl}?action=getDashboard&pin=${encodeURIComponent(currentAdminPin)}`)
          .then(res => res.json())
          .then(res => {
            if (res.success) {
              dashboardCache = res;
              renderDashboard(res);
            } else if (!quiet) {
              showToast('error', 'Gagal', res.message);
            }
          })
          .catch(() => fallbackLocalDashboard());
      } else {
        fallbackLocalDashboard();
      }
    });
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
  // 1. Stats Counter with safe element lookups
  const totalElem = document.getElementById('statTotalPanitia');
  const hadirElem = document.getElementById('statSudahHadir') || document.getElementById('statHadir');
  const belumHadirElem = document.getElementById('statBelumHadir');
  const persentaseElem = document.getElementById('statPersentase');
  const progressElem = document.getElementById('statProgressBar');

  if (totalElem) totalElem.textContent = data.stats.totalPanitia;
  if (hadirElem) hadirElem.textContent = data.stats.sudahHadir;
  if (belumHadirElem) belumHadirElem.textContent = data.stats.belumHadir;
  if (persentaseElem) {
    const rawPct = String(data.stats.persentase || '0');
    persentaseElem.textContent = rawPct.endsWith('%') ? rawPct : `${rawPct}%`;
  }
  if (progressElem) {
    progressElem.style.width = `${Math.min(100, parseFloat(data.stats.persentase || 0))}%`;
  }

  // 2. Active Agenda Meta & Session Code
  const agendaIdElem = document.getElementById('adminAgendaId');
  const agendaTitleElem = document.getElementById('adminAgendaTitle');
  const agendaMetaElem = document.getElementById('adminAgendaMeta');

  if (data.activeAgenda && data.activeAgenda.status === 'AKTIF') {
    if (agendaIdElem) agendaIdElem.textContent = data.activeAgenda.id;
    if (agendaTitleElem) agendaTitleElem.textContent = data.activeAgenda.title;
    if (agendaMetaElem) {
      // Dapatkan kode sesi rapat aktif dari agenda atau state
      let codeVal = (data.activeAgenda.sessionCode || '').trim();
      if (!codeVal && window.activeAgendaState && window.activeAgendaState.sessionCode) {
        codeVal = window.activeAgendaState.sessionCode.trim();
      }
      if (!codeVal) {
        try {
          const stored = JSON.parse(localStorage.getItem('kip_active_agenda') || '{}');
          if (stored && stored.id === data.activeAgenda.id && stored.sessionCode) {
            codeVal = stored.sessionCode.trim();
          }
        } catch (e) {}
      }

      const hasCode = Boolean(codeVal !== '');

      const codeBadgeHtml = hasCode
        ? `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-amber-50 text-amber-900 text-xs font-bold border border-amber-200 shadow-xs">
             <svg class="w-3.5 h-3.5 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
             </svg>
             <span>Kode Sesi:</span>
             <code class="font-mono text-xs sm:text-sm font-extrabold text-red-600 bg-white px-2 py-0.5 rounded border border-amber-200 tracking-wider select-all">${codeVal}</code>
             <button type="button" onclick="copyTextToClipboard('${codeVal}', 'Kode sesi rapat berhasil disalin!')" title="Salin Kode Sesi" class="p-0.5 text-amber-700 hover:text-red-600 transition-colors">
               <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
             </button>
           </span>`
        : `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-100 text-slate-600 text-xs font-medium border border-slate-200">
             <svg class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
             </svg>
             <span>Kode Sesi: Bebas (Tanpa Kode)</span>
           </span>`;

      agendaMetaElem.innerHTML = `
        <div class="flex items-center gap-2 flex-wrap text-xs pt-1">
          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-50 text-slate-700 font-semibold border border-slate-200 shadow-xs">
            <svg class="w-3.5 h-3.5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
            </svg>
            <span>Tanggal: <strong class="text-slate-800">${data.activeAgenda.date}</strong></span>
          </span>
          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-50 text-slate-700 font-semibold border border-slate-200 shadow-xs">
            <svg class="w-3.5 h-3.5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            <span>Waktu: <strong class="text-slate-800">${data.activeAgenda.time}</strong></span>
          </span>
          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-50 text-slate-700 font-semibold border border-slate-200 shadow-xs">
            <svg class="w-3.5 h-3.5 text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path>
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path>
            </svg>
            <span>Lokasi: <strong class="text-slate-800">${data.activeAgenda.location || '-'}</strong></span>
          </span>
          ${codeBadgeHtml}
        </div>
      `;
    }
  } else {
    if (agendaIdElem) agendaIdElem.textContent = 'OFFLINE';
    if (agendaTitleElem) agendaTitleElem.textContent = 'Tidak Ada Agenda Aktif';
    if (agendaMetaElem) {
      agendaMetaElem.innerHTML = '<span class="text-xs text-slate-500">Klik <strong>Generate Agenda</strong> untuk membuka agenda rapat baru.</span>';
    }
  }

  // 3. Populate Filter Sie Dropdown
  const filterSie = document.getElementById('filterSie');
  if (filterSie) {
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

  const filterSieElem = document.getElementById('filterSie');
  const filterStatusElem = document.getElementById('filterStatus');
  const searchInputElem = document.getElementById('searchPanitiaInput');

  const filterSie = filterSieElem ? filterSieElem.value : '';
  const filterStatus = filterStatusElem ? filterStatusElem.value : '';
  const searchVal = searchInputElem ? searchInputElem.value.toLowerCase().trim() : '';

  const filtered = dashboardCache.panitia.filter(item => {
    if (filterSie && item.sie !== filterSie) return false;
    if (filterStatus && item.status !== filterStatus) return false;
    if (searchVal) {
      const matchNama = (item.nama || '').toLowerCase().includes(searchVal);
      const matchNim = (item.nim || '').toLowerCase().includes(searchVal);
      if (!matchNama && !matchNim) return false;
    }
    return true;
  });

  renderPanitiaTable(filtered);
}

function renderPanitiaTable(list) {
  const tbody = document.getElementById('panitiaTableBody') || document.getElementById('tableBodyPanitia');
  if (!tbody) return;
  tbody.innerHTML = '';

  const summaryElem = document.getElementById('tableSummary') || document.getElementById('tableSummaryLabel');

  if (!list || list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="p-6 text-center text-slate-400">
          Tidak ada data panitia yang cocok dengan filter pencarian.
        </td>
      </tr>`;
    if (summaryElem) {
      const total = dashboardCache && dashboardCache.panitia ? dashboardCache.panitia.length : 0;
      summaryElem.textContent = `Menampilkan 0 dari ${total} data panitia`;
    }
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

    const rawHp = String(p.no_hp || p.noHp || '').trim();
    const cleanHp = rawHp.replace(/\D/g, '');
    let noHpDisplay = '<span class="italic text-slate-400 font-mono">-</span>';
    if (cleanHp) {
      const waNum = cleanHp.startsWith('62') ? cleanHp : ('62' + cleanHp.replace(/^0/, ''));
      noHpDisplay = `<a href="https://wa.me/${waNum}" target="_blank" rel="noopener noreferrer" class="font-mono text-emerald-600 hover:text-emerald-700 hover:underline font-semibold" title="Hubungi via WhatsApp">${rawHp}</a>`;
    }

    const waktuFormatted = p.waktuPresensi ? formatPresensiTime(p.waktuPresensi) : '-';

    tr.innerHTML = `
      <td class="p-3.5 text-center text-slate-400 font-mono">${p.no || (idx + 1)}</td>
      <td class="p-3.5 font-bold text-slate-900">${namaDisplay}</td>
      <td class="p-3.5">${nimDisplay}</td>
      <td class="p-3.5 font-semibold text-slate-700">${p.jabatan || '-'}</td>
      <td class="p-3.5"><span class="badge-pnl-gold px-2.5 py-0.5 text-[11px] font-bold">${p.sie || '-'}</span></td>
      <td class="p-3.5 whitespace-nowrap">${noHpDisplay}</td>
      <td class="p-3.5 truncate max-w-xs text-slate-600">${p.delegasi || '-'}</td>
      <td class="p-3.5 text-center">${badgeStatus}</td>
      <td class="p-3.5 text-center font-mono text-slate-600 font-semibold">${waktuFormatted}</td>
    `;
    tbody.appendChild(tr);
  });

  if (summaryElem) {
    const total = dashboardCache && dashboardCache.panitia ? dashboardCache.panitia.length : list.length;
    summaryElem.textContent = `Menampilkan ${list.length} dari ${total} data panitia`;
  }
}

/**
 * Export CSV Helper with UTF-8 BOM
 */
function exportTableToCSV() {
  let listToExport = [];
  if (dashboardCache && dashboardCache.panitia && dashboardCache.panitia.length > 0) {
    listToExport = dashboardCache.panitia;
  } else if (window.MASTER_PANITIA && window.MASTER_PANITIA.length > 0) {
    listToExport = window.MASTER_PANITIA.filter(m => m.nama).map((m, i) => ({
      no: m.no || (i + 1),
      nama: m.nama,
      nim: String(m.nim || '').replace(/\D/g, ''),
      jabatan: m.jabatan || '-',
      sie: m.sie || '-',
      no_hp: m.no_hp || m.noHp || '-',
      delegasi: m.delegasi || '-',
      status: 'BELUM HADIR',
      waktuPresensi: '-'
    }));
  }

  if (listToExport.length === 0) {
    showToast('warning', 'Data Kosong', 'Tidak ada data panitia untuk diekspor.');
    return;
  }

  const title = (window.activeAgendaState ? window.activeAgendaState.title : 'Rekap Kehadiran Panitia KIP 2026');
  let csv = '\uFEFF'; // UTF-8 BOM for Excel compatibility
  csv += `"No","Nama","NIM","Jabatan","Sie","No. HP","Delegasi","Status Kehadiran","Waktu Presensi"\n`;

  listToExport.forEach((p, i) => {
    const no = p.no || (i + 1);
    const nama = (p.nama || '').replace(/"/g, '""');
    const nim = p.nim ? `'${p.nim}` : '-';
    const jabatan = (p.jabatan || '-').replace(/"/g, '""');
    const sie = (p.sie || '-').replace(/"/g, '""');
    const hp = (p.no_hp || p.noHp || '-').replace(/"/g, '""');
    const delegasi = (p.delegasi || '-').replace(/"/g, '""');
    const status = p.status || 'BELUM HADIR';
    const waktu = p.waktuPresensi ? formatPresensiTime(p.waktuPresensi) : '-';
    csv += `"${no}","${nama}","${nim}","${jabatan}","${sie}","${hp}","${delegasi}","${status}","${waktu}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const cleanTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_');
  a.download = `Presensi_${cleanTitle}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('success', 'CSV Berhasil Diunduh', `File CSV (${listToExport.length} data panitia) berhasil disimpan.`);
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
  statusLabel.innerHTML = '<span class="inline-flex items-center gap-1.5"><svg class="w-4 h-4 text-blue-500 animate-spin inline flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Sedang menguji koneksi ke Google Sheet...</span>';

  fetch(`${url}?action=getActiveAgenda`)
    .then(res => res.json())
    .then(data => {
      if (data.success !== undefined) {
        statusLabel.className = "font-bold text-emerald-600";
        statusLabel.innerHTML = '<span class="inline-flex items-center gap-1.5"><svg class="w-4 h-4 text-emerald-500 inline flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg> Koneksi Berhasil! Google Sheet Terhubung Sempurna.</span>';
        showToast('success', 'Koneksi Sukses', 'Google Spreadsheet Panitia KIP 2026 terhubung.');
      } else {
        statusLabel.className = "font-bold text-amber-600";
        statusLabel.innerHTML = '<span class="inline-flex items-center gap-1.5"><svg class="w-4 h-4 text-amber-500 inline flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg> Menerima respon, namun format tidak sesuai.</span>';
      }
    })
    .catch(err => {
      statusLabel.className = "font-bold text-rose-600";
      statusLabel.innerHTML = '<span class="inline-flex items-center gap-1.5"><svg class="w-4 h-4 text-rose-500 inline flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/></svg> Gagal terhubung: ' + err.message + '. Pastikan Deploy \'Anyone\'!</span>';
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
          if (!window.activeAgendaState) window.activeAgendaState = {};
          if (payload.sessionCode) window.activeAgendaState.sessionCode = payload.sessionCode;
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

  // 1. Simpan ke backend PHP
  fetch(`${PHP_API_BASE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'createAgenda', payload: payload, pin: currentAdminPin })
  })
  .then(res => res.json())
  .then(res => {
    spinner.classList.add('hidden');
    btn.disabled = false;
    if (res.success) {
      if (!window.activeAgendaState) window.activeAgendaState = {};
      if (payload.sessionCode) window.activeAgendaState.sessionCode = payload.sessionCode;
      closeModalGenerateAgenda();
      showToast('success', 'Agenda Diaktifkan', res.message);
      fetchActiveAgenda();
      refreshDashboard();
    } else {
      showToast('error', 'Gagal', res.message);
    }
  })
  .catch(err => {
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
          if (!window.activeAgendaState) window.activeAgendaState = {};
          if (payload.sessionCode) window.activeAgendaState.sessionCode = payload.sessionCode;
          closeModalGenerateAgenda();
          showToast('success', 'Agenda Diaktifkan di GSheet', res.message);
          fetchActiveAgenda();
          refreshDashboard();
        } else {
          showToast('error', 'Gagal', res.message);
        }
      })
      .catch(() => fallbackLocalCreateAgenda(payload, spinner, btn));
    } else {
      fallbackLocalCreateAgenda(payload, spinner, btn);
    }
  });
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

    // 1. Tutup agenda via backend PHP
    fetch(`${PHP_API_BASE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'closeAgenda', agendaId: agenda.id, pin: currentAdminPin })
    })
    .then(res => res.json())
    .then(res => {
      if (res.success) {
        showToast('success', 'Agenda Ditutup', res.message);
        fetchActiveAgenda();
        refreshDashboard();
      } else {
        showToast('error', 'Gagal', res.message);
      }
    })
    .catch(err => {
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
        .catch(() => fallbackLocalCloseAgenda(agenda));
      } else {
        fallbackLocalCloseAgenda(agenda);
      }
    });
  }
}

function fallbackLocalCloseAgenda(agenda) {
  agenda.status = 'SELESAI';
  localStorage.setItem('kip_active_agenda', JSON.stringify(agenda));
  showToast('success', 'Agenda Ditutup', `Agenda '${agenda.title}' telah ditutup.`);
  fetchActiveAgenda();
  refreshDashboard();
}

window.closeCurrentAgenda = confirmCloseAgenda;

/**
 * QR Code Presensi Modal
 */
function showQRCodeModal() {
  const curUrl = window.location.href;
  const wrapper = document.getElementById('qrcodeWrapper');
  wrapper.innerHTML = '';

  qrcodeInstance = new QRCode(wrapper, {
    text: curUrl,
    width: 200,
    height: 200,
    colorDark: "#1e3a8a",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });

  const title = window.activeAgendaState ? window.activeAgendaState.title : 'Presensi KIP 2026';
  document.getElementById('qrAgendaLabel').textContent = title;

  document.getElementById('modalQRCode').classList.remove('hidden');
  document.getElementById('modalQRCode').classList.add('flex');
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
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'pointer-events-auto inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-white/95 backdrop-blur-md border border-slate-200/90 shadow-md text-xs font-medium transition-all duration-200 max-w-full animate-fadeIn';

  let iconSvg = '';
  let iconBg = '';
  if (type === 'success') {
    iconBg = 'bg-emerald-100 text-emerald-700';
    iconSvg = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>';
  } else if (type === 'error') {
    iconBg = 'bg-red-100 text-red-700';
    iconSvg = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>';
  } else if (type === 'warning') {
    iconBg = 'bg-amber-100 text-amber-700';
    iconSvg = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>';
  } else {
    iconBg = 'bg-slate-100 text-slate-700';
    iconSvg = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
  }

  const msgHtml = message ? `<span class="text-slate-500 font-normal truncate max-w-[220px] sm:max-w-xs">• ${message}</span>` : '';

  toast.innerHTML = `
    <span class="w-5 h-5 rounded-full ${iconBg} flex items-center justify-center shrink-0">
      ${iconSvg}
    </span>
    <div class="flex items-center gap-1.5 min-w-0 text-xs">
      <strong class="font-bold text-slate-800 shrink-0">${title}</strong>
      ${msgHtml}
    </div>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('opacity-0', 'scale-95');
    setTimeout(() => toast.remove(), 250);
  }, 2500);
}
