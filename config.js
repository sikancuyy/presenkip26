/**
 * =========================================================================
 * KONFIGURASI PRESENSI DIGITAL PANITIA KIP 2026
 * Subdomain: presenkip26.sikancuyy.my.id
 * =========================================================================
 */
window.APP_CONFIG = {
  // Webhook Google Apps Script Permanen (tetap bisa diubah via Admin Modal & tersimpan di localStorage)
  DEFAULT_GAS_URL: "https://script.google.com/macros/s/AKfycbwVAw5bmI1WgjQYQAyU93onjSi2TwvUfPPd5J28Dvp1zzA5w-cWWR7eumr40NcIE-MX/exec",

  get GAS_API_URL() {
    return (localStorage.getItem('kip_gas_url') || this.DEFAULT_GAS_URL).trim();
  },

  // Pengaturan Domain & Branding
  SUBDOMAIN: "presenkip26.sikancuyy.my.id",
  ORGANISASI: "Komisi Independen Pemilihan (KIP) 2026 - PEMILWA PNL",

  // PIN Akses Default Admin Dashboard
  DEFAULT_ADMIN_PIN: "KIP2026"
};


