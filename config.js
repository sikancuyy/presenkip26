/**
 * =========================================================================
 * KONFIGURASI PRESENSI DIGITAL PANITIA KIP 2026
 * Subdomain: presenkip26.sikancuyy.my.id
 * =========================================================================
 */
window.APP_CONFIG = {
  // URL Web App Google Apps Script hasil Deployment (Deploy > Web app)
  // Contoh: "https://script.google.com/macros/s/AKfycbxXXXXXXXXXXXXXXXXXXXXXXXXX/exec"
  GAS_API_URL: localStorage.getItem('kip_gas_url') || "",

  // Pengaturan Domain & Branding
  SUBDOMAIN: "presenkip26.sikancuyy.my.id",
  ORGANISASI: "Panitia KIP 2026 - Politeknik Negeri Lhokseumawe",

  // PIN Akses Default Admin Dashboard
  DEFAULT_ADMIN_PIN: "KIP2026"
};
