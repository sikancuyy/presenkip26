<?php
/**
 * Konfigurasi Sistem Backend PHP Presensi KIP 2026
 * Terintegrasi Google Sheets sebagai SSOT
 */

// Set zona waktu seragam ke Waktu Indonesia Barat (WIB)
date_default_timezone_set('Asia/Jakarta');

// Error reporting untuk keamanan produksi
error_reporting(E_ALL & ~E_NOTICE & ~E_WARNING);
ini_set('display_errors', '0');

// Header CORS dan JSON
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Direktori penyimpanan cache lokal
define('DATA_DIR', dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data');

// Konfigurasi Google Apps Script Web App Default
define('DEFAULT_GAS_URL', 'https://script.google.com/macros/s/AKfycbwVAw5bmI1WgjQYQAyU93onjSi2TwvUfPPd5J28Dvp1zzA5w-cWWR7eumr40NcIE-MX/exec');

// PIN Administrator Default
define('DEFAULT_ADMIN_PIN', 'KIP2026');

// Interval Auto-Sync (detik)
define('AUTO_SYNC_INTERVAL', 10);

/**
 * Mendapatkan URL Google Apps Script aktif
 */
function getGasUrl(): string {
    $configFile = DATA_DIR . DIRECTORY_SEPARATOR . 'config.json';
    if (file_exists($configFile)) {
        $raw = @file_get_contents($configFile);
        if ($raw) {
            $json = json_decode($raw, true);
            if (!empty($json['gas_url'])) {
                return trim($json['gas_url']);
            }
        }
    }
    return DEFAULT_GAS_URL;
}

/**
 * Menyimpan URL Google Apps Script kustom
 */
function setGasUrl(string $url): bool {
    $configFile = DATA_DIR . DIRECTORY_SEPARATOR . 'config.json';
    $data = ['gas_url' => trim($url), 'updated_at' => date('Y-m-d H:i:s')];
    return (bool)@file_put_contents($configFile, json_encode($data, JSON_PRETTY_PRINT));
}

/**
 * Helper pengiriman respons JSON terstandarisasi
 */
function jsonResponse(array $payload, int $statusCode = 200): void {
    http_response_code($statusCode);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

